// Root systemd management of the shared SSH test host: the system manager and another
// user's manager, which the local non-root test agents cannot reach. Kept apart from
// `real-ssh.test.ts` only for file length; it runs in the serial SSH lane like it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, onTestFinished, test } from "vitest";
import type { SystemdScope } from "#bindings/SystemdScope";
import { ProcessManager, waitForValue } from "./test-utils";
import {
    SSH_PASSWORD_USER,
    cleanupSshTest,
    shellQuote,
    sshRootTestCommand,
    startRootSshAgent,
} from "./ssh-test-utils";
import {
    failureOf,
    journalMessages,
    openSystemdJournal,
} from "./systemd-test-utils";

/**
 * Prefix of every unit and state directory the root systemd suite creates on the SSH test
 * host, so cleanup after a crashed run only ever matches this suite's own leftovers.
 */
const ROOT_SYSTEMD_PREFIX = "redoor-root-systemd-test";

/**
 * Fixture account no test logs in as, so its user manager stays stopped; the fallback for the
 * manager-not-running check when something keeps `redoor-password`'s manager running.
 */
const SSH_UNUSED_USER = "relay";

/** Accounts the SSH test host provisions, which a root agent's systemd user list must show. */
const SSH_HOST_ACCOUNTS = [
    "redoor",
    SSH_PASSWORD_USER,
    SSH_UNUSED_USER,
] as const;

/** Linger and user manager state of one account, read directly on the SSH test host. */
type RemoteSystemdUser = {
    name: string;
    uid: number;
    linger: boolean;
    manager_running: boolean;
};

/**
 * Reads linger and manager state of `names` as root, with the same evidence the agent uses:
 * logind's linger file, and the manager's bus or private socket in `/run/user/<uid>`.
 */
async function remoteSystemdUsers(
    names: readonly string[],
): Promise<RemoteSystemdUser[]> {
    const output = await sshRootTestCommand(
        `for user in ${names.map(shellQuote).join(" ")}; do
uid=$(id -u -- "$user") || exit 1
linger=no; [ -e "/var/lib/systemd/linger/$user" ] && linger=yes
manager=no; { [ -S "/run/user/$uid/bus" ] || [ -S "/run/user/$uid/systemd/private" ]; } && manager=yes
echo "$user $uid $linger $manager"
done`,
    );

    return output
        .trim()
        .split("\n")
        .map((line) => {
            const [name = "", uid = "", linger = "", manager = ""] =
                line.split(" ");

            return {
                name,
                uid: Number(uid),
                linger: linger === "yes",
                manager_running: manager === "yes",
            };
        });
}

/** Linger and manager state of one account on the SSH test host. */
async function remoteSystemdUser(name: string): Promise<RemoteSystemdUser> {
    const [user] = await remoteSystemdUsers([name]);

    if (user === undefined) {
        throw new Error(`No systemd state reported for ${name}`);
    }

    return user;
}

/** Content of a root systemd suite unit; `description` lets the test edit a loaded file. */
function rootSystemdUnitContent(options: {
    readyLine: string;
    description: string;
    wantedBy: string;
}): string {
    return `[Unit]
Description=${options.description}

[Service]
Type=simple
ExecStart=/bin/sh -c 'echo ${options.readyLine}; exec sleep infinity'

[Install]
WantedBy=${options.wantedBy}
`;
}

/** Writes a file on the SSH test host as root, optionally handing it to `owner`. */
async function writeRemoteFile(options: {
    path: string;
    content: string;
    owner?: string;
}): Promise<void> {
    const chown =
        options.owner === undefined
            ? ""
            : ` && chown -- ${shellQuote(options.owner)}:"$(id -gn -- ${shellQuote(options.owner)})" ${shellQuote(options.path)}`;

    await sshRootTestCommand(
        `printf '%s' ${shellQuote(options.content)} > ${shellQuote(options.path)}${chown}`,
    );
}

/**
 * Reverts everything the root systemd suite changes on the shared SSH test host for the runs
 * `run` matches: one run's name, or `${ROOT_SYSTEMD_PREFIX}-*` for leftovers of crashed runs.
 *
 * It drives `systemctl` and `loginctl` directly so it also works when the API under test
 * failed, and tolerates every step never having happened. Linger, the user manager and the
 * directories created in the user's home are reverted only when the run's state directory
 * records that the run changed them, so state the test found is never touched.
 */
async function revertRootSystemdTest(run: string): Promise<void> {
    if (!/^redoor-root-systemd-test-(\*|[0-9-]+)$/.test(run)) {
        throw new Error(
            `Refusing to clean up unexpected systemd test run ${run}`,
        );
    }

    await sshRootTestCommand(`user=${shellQuote(SSH_PASSWORD_USER)}
uid=$(id -u -- "$user")
gid=$(id -g -- "$user")
home=$(getent passwd "$user" | cut -d: -f6)
user_units="$home/.config/systemd/user"
manager_running() { [ -S "/run/user/$uid/systemd/private" ]; }
# The user's own systemctl talks to the manager's private socket; systemctl -M user@ would
# go through the user bus instead and socket-activate a dbus-daemon that was not running.
as_user() { (cd / && setpriv --reuid="$uid" --regid="$gid" --init-groups env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin XDG_RUNTIME_DIR="/run/user/$uid" "$@"); }
removed_system=no
for file in /etc/systemd/system/${run}*.service; do
    [ -e "$file" ] || continue
    unit=\${file##*/}
    systemctl stop -- "$unit"
    systemctl disable -- "$unit"
    rm -f -- "$file" /etc/systemd/system/*.wants/"$unit"
    removed_system=yes
done
if [ "$removed_system" = yes ]; then
    systemctl daemon-reload
    systemctl reset-failed -- '${run}*.service' 2>/dev/null
fi
removed_user=no
for file in "$user_units"/${run}*.service; do
    [ -e "$file" ] || continue
    unit=\${file##*/}
    if manager_running; then
        as_user systemctl --user stop -- "$unit"
        as_user systemctl --user disable -- "$unit"
    fi
    rm -f -- "$file" "$user_units"/*.wants/"$unit"
    removed_user=yes
done
# Shared, root-owned user units that every user's manager loads; only the fixture user's
# manager was reloaded with them, so only it needs a reload after their removal.
for file in /etc/systemd/user/${run}*.service; do
    [ -e "$file" ] || continue
    rm -f -- "$file"
    removed_user=yes
done
if [ "$removed_user" = yes ] && manager_running; then
    as_user systemctl --user daemon-reload
    as_user systemctl --user reset-failed -- '${run}*.service' 2>/dev/null
fi
for state in /tmp/${run}; do
    [ -d "$state" ] || continue
    if [ -e "$state/linger-enabled" ]; then loginctl disable-linger -- "$user"; fi
    if [ -e "$state/manager-started" ]; then systemctl stop "user@$uid.service"; fi
    if [ -e "$state/created-directories" ]; then
        tac "$state/created-directories" | while IFS= read -r directory; do rmdir -- "$directory"; done
    fi
    rm -rf -- "$state"
done
true`);
}

describe.skipIf(
    process.env.REDOOR_SSH_TEST !== "1" ||
        !process.env.REDOOR_SSH_TEST_PASSWORD,
)("root SSH agent systemd", () => {
    test("manages the system manager and another user's manager", async () => {
        const processManager = new ProcessManager();
        const home = mkdtempSync(join(tmpdir(), "redoor-root-systemd-"));
        const suffix = `${process.pid}-${Date.now()}`;
        const run = `${ROOT_SYSTEMD_PREFIX}-${suffix}`;
        const appName = `redoor-root-systemd-${suffix}`;
        const agentName = `root-systemd-${suffix}`;
        // Records what this run changed, so cleanup (even of a crashed run) reverts only that.
        const stateDirectory = `/tmp/${run}`;
        const systemScope: SystemdScope = { type: "system" };

        const userScope: SystemdScope = {
            type: "user",
            name: SSH_PASSWORD_USER,
        };

        const systemUnit = {
            name: `${run}-system.service`,
            path: `/etc/systemd/system/${run}-system.service`,
            readyLine: `${run}-system-ready`,
            wantsLink: `/etc/systemd/system/multi-user.target.wants/${run}-system.service`,
        };

        onTestFinished(async () => {
            await processManager.killAll();

            try {
                await revertRootSystemdTest(run);
            } finally {
                try {
                    await cleanupSshTest({
                        remoteRoot: stateDirectory,
                        agentAppNames: [appName],
                        sshCommand: sshRootTestCommand,
                    });
                } finally {
                    rmSync(home, { recursive: true, force: true });
                }
            }
        }, 120_000);

        // Leftovers of a crashed run of this suite would otherwise skew the state found below.
        await revertRootSystemdTest(`${ROOT_SYSTEMD_PREFIX}-*`);
        await cleanupSshTest({
            remoteRoot: stateDirectory,
            agentAppNames: [appName],
            sshCommand: sshRootTestCommand,
        });

        // A login of another suite keeps the manager up a little after it ends (the SSH
        // connection share and logind's stop delay), so wait for it to stop on its own.
        // Processes left in an old session keep it running for good: then the test adapts,
        // it never stops a manager it did not start.
        const userBefore = await waitForValue({
            description: `${SSH_PASSWORD_USER}'s user manager to stop on its own`,
            timeoutMs: 45_000,
            intervalMs: 1_000,
            predicate: async () => {
                const user = await remoteSystemdUser(SSH_PASSWORD_USER);

                return user.manager_running ? undefined : user;
            },
        }).catch(() => remoteSystemdUser(SSH_PASSWORD_USER));

        if (userBefore.manager_running) {
            console.warn(
                `${SSH_PASSWORD_USER}'s user manager was already running (linger=${userBefore.linger}); checking the manager-not-running failure with ${SSH_UNUSED_USER} instead`,
            );
        }

        await sshRootTestCommand(
            `install -d -m 0700 ${shellQuote(stateDirectory)}`,
        );

        const agent = await startRootSshAgent({
            processManager,
            home,
            appName,
            agentName,
        });

        // A root agent on a systemd host must announce support so the UI shows the tab.
        expect(agent.systemd).toEqual({ status: "available" });

        // Other suites may log in as the fixture users meanwhile, so compare the overview with
        // the host only when the host's state did not change around the request.
        const snapshot = await waitForValue({
            description:
                "a systemd overview taken while the host state stood still",
            timeoutMs: 30_000,
            intervalMs: 500,
            predicate: async () => {
                const before = await remoteSystemdUsers(SSH_HOST_ACCOUNTS);
                const overview = await agent.systemdOverview();
                const after = await remoteSystemdUsers(SSH_HOST_ACCOUNTS);

                return isDeepStrictEqual(before, after)
                    ? { overview, remote: after }
                    : undefined;
            },
        });

        // Root runs as UID 0, which unlocks the system manager and every user's manager.
        expect(snapshot.overview).toMatchObject({
            username: "root",
            uid: 0,
            is_root: true,
        });
        // Root agents list regular accounts with the linger and manager state logind and
        // the managers' sockets show on the host, so the UI can offer linger per user.
        expect(
            snapshot.overview.users.filter((user) =>
                SSH_HOST_ACCOUNTS.some((name) => name === user.name),
            ),
        ).toEqual(snapshot.remote);

        const stoppedUser = userBefore.manager_running
            ? snapshot.remote.find(
                  (user) =>
                      user.name === SSH_UNUSED_USER && !user.manager_running,
              )?.name
            : SSH_PASSWORD_USER;

        if (stoppedUser === undefined) {
            console.warn(
                "No fixture account without a running user manager; skipping the manager-not-running check",
            );
        } else {
            // Without a running manager the UI must be told so it can offer linger.
            expect(
                await failureOf(
                    agent.listSystemdUnits({ type: "user", name: stoppedUser }),
                ),
            ).toEqual({
                status: 409,
                code: "systemd_user_manager_not_running",
            });
        }

        const userHome = (
            await sshRootTestCommand(
                `getent passwd ${shellQuote(SSH_PASSWORD_USER)} | cut -d: -f6`,
            )
        ).trim();

        const userUnitDirectory = `${userHome}/.config/systemd/user`;

        const userUnit = {
            name: `${run}-user.service`,
            path: `${userUnitDirectory}/${run}-user.service`,
            readyLine: `${run}-user-ready`,
        };

        // Directories are recorded before they are created, so cleanup removes exactly them.
        await sshRootTestCommand(`user=${shellQuote(SSH_PASSWORD_USER)}
group=$(id -gn -- "$user")
for directory in ${shellQuote(`${userHome}/.config`)} ${shellQuote(`${userHome}/.config/systemd`)} ${shellQuote(userUnitDirectory)}; do
    if [ ! -d "$directory" ]; then
        printf '%s\\n' "$directory" >> ${shellQuote(`${stateDirectory}/created-directories`)}
        install -d -o "$user" -g "$group" -m 0755 -- "$directory"
    fi
done`);
        await writeRemoteFile({
            path: userUnit.path,
            content: rootSystemdUnitContent({
                readyLine: userUnit.readyLine,
                description: "Redoor root systemd test, user",
                wantedBy: "default.target",
            }),
            owner: SSH_PASSWORD_USER,
        });

        const markers = [
            ...(userBefore.linger ? [] : ["linger-enabled"]),
            ...(userBefore.manager_running ? [] : ["manager-started"]),
        ];

        if (markers.length > 0) {
            await sshRootTestCommand(
                `touch ${markers.map((marker) => shellQuote(`${stateDirectory}/${marker}`)).join(" ")}`,
            );
        }

        const linger = await agent.setSystemdLinger(SSH_PASSWORD_USER, true);

        // The response reports logind's linger record after the change.
        expect(linger).toEqual({ user: SSH_PASSWORD_USER, linger: true });
        // Root changes another user's linger through logind, which records it on disk.
        expect((await remoteSystemdUser(SSH_PASSWORD_USER)).linger).toBe(true);

        await waitForValue({
            description: `the overview to report ${SSH_PASSWORD_USER}'s manager running`,
            timeoutMs: 30_000,
            intervalMs: 250,
            predicate: async () =>
                (await agent.systemdOverview()).users.find(
                    (user) =>
                        user.name === SSH_PASSWORD_USER &&
                        user.linger &&
                        user.manager_running,
                ),
        });

        const userReload = await agent.systemdDaemonReload(userScope);

        // A manager the overview calls running accepts requests right away, and the response
        // names the user's manager, not root's.
        expect(userReload.scope).toEqual(userScope);

        const userList = await agent.listSystemdUnits(userScope);

        // Root fully manages another user's manager.
        expect(userList.can_manage).toBe(true);
        // The list comes from that user's manager: it holds the file in the user's home.
        expect(
            userList.units.find((unit) => unit.name === userUnit.name),
        ).toMatchObject({ unit_type: "service", unit_file_state: "disabled" });

        const userStarted = await agent.runSystemdUnitAction(
            userScope,
            userUnit.name,
            "start",
        );

        // The start job ran in the user's manager and finished before the response.
        expect(userStarted).toMatchObject({
            scope: userScope,
            active_state: "active",
            sub_state: "running",
            fragment_path: userUnit.path,
            can_manage: true,
        });

        const userJournal = openSystemdJournal({
            agent,
            scope: userScope,
            unit: userUnit.name,
            lines: 50,
        });

        await waitForValue({
            description: "the user unit's ready line in its journal",
            timeoutMs: 20_000,
            predicate: async () =>
                journalMessages(userJournal.events).includes(
                    userUnit.readyLine,
                ),
        });

        // Root reads the user unit's journal through `_SYSTEMD_USER_UNIT` and `_UID` matches,
        // so the line the service printed must arrive.
        expect(journalMessages(userJournal.events)).toContain(
            userUnit.readyLine,
        );

        const userRestarted = await agent.runSystemdUnitAction(
            userScope,
            userUnit.name,
            "restart",
        );

        // A restart replaces the main process in the user's manager.
        expect(userRestarted.active_state).toBe("active");
        expect(userRestarted.main_pid).not.toBe(userStarted.main_pid);

        await waitForValue({
            description: "a live ready line of the user unit after the restart",
            timeoutMs: 20_000,
            predicate: async () =>
                journalMessages(userJournal.events).filter(
                    (line) => line === userUnit.readyLine,
                ).length >= 2,
        });

        // The same open stream follows the user's journal, so the restart's line arrived live.
        expect(
            journalMessages(userJournal.events).filter(
                (line) => line === userUnit.readyLine,
            ),
        ).toHaveLength(2);

        await userJournal.close();

        await writeRemoteFile({
            path: userUnit.path,
            content: rootSystemdUnitContent({
                readyLine: userUnit.readyLine,
                description: "Redoor root systemd test, user, edited",
                wantedBy: "default.target",
            }),
        });

        // A root agent asks the file owner's manager, so the edit shows in that user's scope.
        expect((await agent.systemdPathStatus(userUnit.path)).matches).toEqual([
            {
                scope: userScope,
                unit: userUnit.name,
                drop_in: false,
                state: "needs_reload",
                can_reload: true,
            },
        ]);

        await agent.systemdDaemonReload(userScope);

        // The daemon-reload through the API reached the user's manager.
        expect(
            (await agent.systemdPathStatus(userUnit.path)).matches[0]?.state,
        ).toBe("up_to_date");

        const sharedUnit = {
            name: `${run}-shared.service`,
            path: `/etc/systemd/user/${run}-shared.service`,
        };

        // A root-owned file in a directory every user's manager loads, like the ones
        // `/usr/lib/systemd/user` ships. Cleanup removes it by the run's prefix.
        await writeRemoteFile({
            path: sharedUnit.path,
            content: rootSystemdUnitContent({
                readyLine: `${run}-shared-ready`,
                description: "Redoor root systemd test, shared",
                wantedBy: "default.target",
            }),
        });
        await agent.systemdDaemonReload(userScope);

        // Without a named user a root agent asks the owner root's manager, which is not the
        // manager whose unit list links to the file.
        expect(
            (await agent.systemdPathStatus(sharedUnit.path)).matches.some(
                (match) => isDeepStrictEqual(match.scope, userScope),
            ),
        ).toBe(false);
        // A link from the user's unit list names the user, so the view shows that user's unit.
        expect(
            (
                await agent.systemdPathStatus(sharedUnit.path, {
                    user: SSH_PASSWORD_USER,
                })
            ).matches,
        ).toEqual([
            {
                scope: userScope,
                unit: sharedUnit.name,
                drop_in: false,
                state: "up_to_date",
                can_reload: true,
            },
        ]);

        const userStopped = await agent.runSystemdUnitAction(
            userScope,
            userUnit.name,
            "stop",
        );

        // Stop waits for the job, so the user unit is already inactive.
        expect(userStopped).toMatchObject({
            active_state: "inactive",
            main_pid: null,
        });

        await writeRemoteFile({
            path: systemUnit.path,
            content: rootSystemdUnitContent({
                readyLine: systemUnit.readyLine,
                description: "Redoor root systemd test, system",
                wantedBy: "multi-user.target",
            }),
        });

        const systemReload = await agent.systemdDaemonReload(systemScope);

        // Root may reload the system manager.
        expect(systemReload.scope).toEqual(systemScope);

        const systemList = await agent.listSystemdUnits(systemScope);

        // Unlike a non-root agent, root manages the system scope.
        expect(systemList.can_manage).toBe(true);
        // The installed but never started unit is listed thanks to the unit file merge.
        expect(
            systemList.units.find((unit) => unit.name === systemUnit.name),
        ).toMatchObject({ unit_type: "service", unit_file_state: "disabled" });

        const systemStarted = await agent.runSystemdUnitAction(
            systemScope,
            systemUnit.name,
            "start",
        );

        // Root starts system units; the job finished before the response.
        expect(systemStarted).toMatchObject({
            scope: systemScope,
            active_state: "active",
            sub_state: "running",
            can_manage: true,
            is_agent_unit: false,
        });

        const systemJournal = openSystemdJournal({
            agent,
            scope: systemScope,
            unit: systemUnit.name,
            lines: 50,
        });

        await waitForValue({
            description: "the system unit's ready line in its journal",
            timeoutMs: 20_000,
            predicate: async () =>
                journalMessages(systemJournal.events).includes(
                    systemUnit.readyLine,
                ),
        });

        // Root reads the whole system journal, so no access note precedes the entries.
        expect(
            systemJournal.events.some(
                (event) => event.type === "access_limited",
            ),
        ).toBe(false);

        const systemRestarted = await agent.runSystemdUnitAction(
            systemScope,
            systemUnit.name,
            "restart",
        );

        // A restart replaces the system unit's main process.
        expect(systemRestarted.active_state).toBe("active");
        expect(systemRestarted.main_pid).not.toBe(systemStarted.main_pid);

        await waitForValue({
            description:
                "a live ready line of the system unit after the restart",
            timeoutMs: 20_000,
            predicate: async () =>
                journalMessages(systemJournal.events).filter(
                    (line) => line === systemUnit.readyLine,
                ).length >= 2,
        });

        await systemJournal.close();

        const systemEnabled = await agent.runSystemdUnitAction(
            systemScope,
            systemUnit.name,
            "enable",
        );

        // Enabling installs the unit for multi-user.target without changing its state.
        expect(systemEnabled).toMatchObject({
            unit_file_state: "enabled",
            active_state: "active",
        });
        // The [Install] section's effect on disk is the wants symlink.
        expect(
            (
                await sshRootTestCommand(
                    `test -L ${shellQuote(systemUnit.wantsLink)} && echo linked || echo missing`,
                )
            ).trim(),
        ).toBe("linked");

        const systemDisabled = await agent.runSystemdUnitAction(
            systemScope,
            systemUnit.name,
            "disable",
        );

        // Disabling removes the install symlink again and leaves the unit running.
        expect(systemDisabled).toMatchObject({
            unit_file_state: "disabled",
            active_state: "active",
        });
        expect(
            (
                await sshRootTestCommand(
                    `test -e ${shellQuote(systemUnit.wantsLink)} || test -L ${shellQuote(systemUnit.wantsLink)} && echo linked || echo missing`,
                )
            ).trim(),
        ).toBe("missing");

        await writeRemoteFile({
            path: systemUnit.path,
            content: rootSystemdUnitContent({
                readyLine: systemUnit.readyLine,
                description: "Redoor root systemd test, system, edited",
                wantedBy: "multi-user.target",
            }),
        });

        // An edited system unit file needs a reload of the system manager only; root's own
        // user manager does not load files from /etc/systemd/system.
        expect(
            (await agent.systemdPathStatus(systemUnit.path)).matches,
        ).toEqual([
            {
                scope: systemScope,
                unit: systemUnit.name,
                drop_in: false,
                state: "needs_reload",
                can_reload: true,
            },
        ]);

        await agent.systemdDaemonReload(systemScope);

        // The system daemon-reload through the API picked up the edit.
        expect(
            (await agent.systemdPathStatus(systemUnit.path)).matches[0]?.state,
        ).toBe("up_to_date");

        const systemStopped = await agent.runSystemdUnitAction(
            systemScope,
            systemUnit.name,
            "stop",
        );

        // Stop waits for the job, so the system unit is already inactive.
        expect(systemStopped).toMatchObject({
            active_state: "inactive",
            main_pid: null,
        });
    }, 300_000);
});
