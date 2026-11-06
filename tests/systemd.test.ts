import {
    existsSync,
    lstatSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";

import type { Agent, ApiClient } from "#ui/api-client";
import type { SystemdLingerResponse } from "#bindings/SystemdLingerResponse";
import type { SystemdScope } from "#bindings/SystemdScope";
import { FakeAgent } from "./fake-agent";
import {
    type Failure,
    failureOf,
    journalMessages,
    openSystemdJournal,
} from "./systemd-test-utils";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

/** States `systemctl --user is-system-running` prints when it reached a user manager. */
const REACHABLE_MANAGER_STATES = new Set([
    "initializing",
    "starting",
    "running",
    "degraded",
    "maintenance",
    "stopping",
]);

/**
 * Whether the current user's systemd manager answers. These tests drive real units of that
 * manager, so they cannot run on macOS or on CI runners without a user bus. The exit code
 * is not enough: a `degraded` manager also exits non-zero but works fine.
 */
async function userManagerReachable(): Promise<boolean> {
    if (process.platform !== "linux") {
        return false;
    }

    const result = await $`systemctl --user is-system-running`
        .quiet()
        .nothrow();

    return REACHABLE_MANAGER_STATES.has(result.stdout.trim());
}

const hasUserManager = await userManagerReachable();

/** The account the test runner, and therefore the spawned agent, runs as. */
const username = userInfo().username;

/** The agent's own user manager, the only one a non-root agent may manage. */
const ownScope: SystemdScope = { type: "user", name: username };

const systemScope: SystemdScope = { type: "system" };

/** Where the user manager loads the test units from. */
const userUnitDirectory = join(homedir(), ".config", "systemd", "user");

/** A system unit every systemd host runs, for the read-only system scope checks. */
const SYSTEM_UNIT = "systemd-journald.service";

/** Another account that exists on every Linux host, for the refused-user checks. */
const OTHER_USER = "root";

/**
 * A shared user unit path for path checks that name a user manager: the named user is
 * resolved and authorized before the path is looked at, so the file need not exist.
 */
const PATH_STATUS_PROBE = "/etc/systemd/user/redoor-path-status-probe.service";

/** A real unit file in the user's manager, unique to one test so parallel lanes never meet. */
type TestUnit = {
    /** Full unit name, `redoor-test-<random>.service`. */
    name: string;
    /** The line the service prints each time it starts. */
    readyLine: string;
    /** The unit file below `~/.config/systemd/user`. */
    path: string;
    /** Drop-in directory of the unit, created only by tests that need it. */
    dropInDirectory: string;
    /** Where `enable` links the unit for `WantedBy=default.target`. */
    wantsLink: string;
};

/** Content of a test unit file; `description` lets tests change the file after loading. */
function unitFileContent(readyLine: string, description: string): string {
    return `[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=/bin/sh -c 'echo ${readyLine}; exec sleep infinity'

[Install]
WantedBy=default.target
`;
}

/**
 * Writes a fresh service into the user's unit directory and registers its removal. Cleanup
 * runs `systemctl --user` directly so it also works when the API under test failed, and
 * tolerates every step having never happened.
 */
function createTestUnit(): TestUnit {
    const id = randomBytes(6).toString("hex");
    const name = `redoor-test-${id}.service`;

    const unit: TestUnit = {
        name,
        readyLine: `redoor-test-ready-${id}`,
        path: join(userUnitDirectory, name),
        dropInDirectory: join(userUnitDirectory, `${name}.d`),
        wantsLink: join(userUnitDirectory, "default.target.wants", name),
    };

    onTestFinished(async () => {
        await $`systemctl --user stop -- ${unit.name}`.quiet().nothrow();
        await $`systemctl --user disable -- ${unit.name}`.quiet().nothrow();
        rmSync(unit.wantsLink, { force: true });
        rmSync(unit.dropInDirectory, { recursive: true, force: true });
        rmSync(unit.path, { force: true });
        await $`systemctl --user daemon-reload`.quiet().nothrow();
        await $`systemctl --user reset-failed -- ${unit.name}`
            .quiet()
            .nothrow();
    });

    mkdirSync(userUnitDirectory, { recursive: true });
    writeFileSync(
        unit.path,
        unitFileContent(unit.readyLine, `Redoor integration test ${id}`),
    );

    return unit;
}

/** A oneshot service with two timers that start it, unique to one test. */
type TestTimers = {
    /** `redoor-test-<random>.service`, which prints one line per run. */
    service: string;
    /** The service's own timer: a 2099 calendar rule plus `OnActiveSec=1h`, `Persistent`. */
    timer: string;
    /** A second timer that starts the service one second after the timer starts. */
    soonTimer: string;
};

/**
 * Writes a oneshot service and two timers for it into the user's unit directory and
 * registers their removal. The calendar rule is in 2099 so it never runs and never meets a
 * year boundary, and `OnActiveSec=1h` gives the timer a monotonic next elapse to convert.
 * Cleanup runs `systemctl --user` directly so it also works when the API under test failed.
 */
function createTestTimers(): TestTimers {
    const id = randomBytes(6).toString("hex");

    const timers: TestTimers = {
        service: `redoor-test-${id}.service`,
        timer: `redoor-test-${id}.timer`,
        soonTimer: `redoor-test-${id}-soon.timer`,
    };

    const names = [timers.timer, timers.soonTimer, timers.service];

    onTestFinished(async () => {
        await $`systemctl --user stop -- ${names}`.quiet().nothrow();

        for (const name of names) {
            rmSync(join(userUnitDirectory, name), { force: true });
            // Persistent timers keep their last run in a stamp file.
            rmSync(
                join(
                    homedir(),
                    ".local",
                    "share",
                    "systemd",
                    "timers",
                    `stamp-${name}`,
                ),
                { force: true },
            );
        }

        await $`systemctl --user daemon-reload`.quiet().nothrow();
        await $`systemctl --user reset-failed -- ${names}`.quiet().nothrow();
    });

    mkdirSync(userUnitDirectory, { recursive: true });
    writeFileSync(
        join(userUnitDirectory, timers.service),
        `[Unit]
Description=Redoor timer test ${id}

[Service]
Type=oneshot
ExecStart=/bin/echo redoor-test-timer-${id}
`,
    );
    writeFileSync(
        join(userUnitDirectory, timers.timer),
        `[Unit]
Description=Redoor timer test ${id}

[Timer]
OnCalendar=2099-01-01 00:00:00
OnActiveSec=1h
Persistent=true
`,
    );
    writeFileSync(
        join(userUnitDirectory, timers.soonTimer),
        `[Unit]
Description=Redoor soon timer test ${id}

[Timer]
OnActiveSec=1s
Unit=${timers.service}
`,
    );

    return timers;
}

/** Counts the unit's ready lines in the user journal, read directly without the API. */
async function journalReadyLines(unit: TestUnit): Promise<number> {
    const result =
        await $`journalctl --user --unit=${unit.name} --output=cat --no-pager --quiet`
            .quiet()
            .nothrow();

    return result.stdout
        .split("\n")
        .filter((line) => line.trim() === unit.readyLine).length;
}

/**
 * Process ids of `journalctl` runs following this unit, to observe the stream's process. The
 * `[j]` keeps the pattern from matching the shell that runs `pgrep` with it as an argument.
 */
async function journalctlPids(unit: string): Promise<string[]> {
    const pattern = `[j]ournalctl.*--unit=${unit}.*--follow`;

    const result = await $`pgrep -f ${pattern}`.quiet().nothrow();

    return result.stdout.split("\n").filter(Boolean);
}

describe.skipIf(!hasUserManager).sequential("systemd units", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let agent: Agent;
    let serverPort: number;

    beforeAll(async () => {
        const started = await startServerAndAgent({
            processManager,
            agentName: "systemd-test-agent",
            agentCwd: tempFiles.tempDirectory({ suffix: "-systemd" }),
        });

        apiClient = started.apiClient;
        agent = started.testAgent;
        serverPort = started.serverPort;
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("reports systemd support and the agent's own account", async () => {
        // A real Linux agent booted with systemd must announce support so the UI shows the tab.
        expect(agent.systemd).toEqual({ status: "available" });

        const overview = await agent.systemdOverview();

        // The overview describes the account the agent runs as, which is the test runner's.
        expect(overview.username).toBe(username);
        expect(overview.uid).toBe(process.getuid?.());
        // The integration agent is not root, so its system scope must be read-only.
        expect(overview.is_root).toBe(false);
        // The skip check reached this user's manager, so the agent must see it running too.
        expect(overview.user_manager_running).toBe(true);
        // Linger is read from logind's own record, which every account may read.
        expect(overview.linger).toBe(
            existsSync(join("/var/lib/systemd/linger", username)),
        );
        // Only root agents list other accounts; a non-root agent must not leak them.
        expect(overview.users).toEqual([]);
        expect(overview.users_truncated).toBe(false);
    });

    it("manages the lifecycle of a unit in the agent's own user manager", async () => {
        const unit = createTestUnit();

        const reloaded = await agent.systemdDaemonReload(ownScope);

        // The response names the manager that reloaded so the UI can confirm the right one.
        expect(reloaded.scope).toEqual(ownScope);

        const list = await agent.listSystemdUnits(ownScope);

        // The agent's own user manager is fully manageable.
        expect(list.can_manage).toBe(true);
        expect(list.scope).toEqual(ownScope);
        // Installed but never started units still appear thanks to the unit file merge.
        expect(
            list.units.find((entry) => entry.name === unit.name),
        ).toMatchObject({
            name: unit.name,
            unit_type: "service",
            unit_file_state: "disabled",
            // systemd has not loaded the never-started unit, so the agent finds its file in
            // the manager's search path; the UI links the unit to that file's view.
            load_state: null,
            fragment_path: unit.path,
        });
        // Units are sorted by name so the UI can render them without sorting again.
        const names = list.units.map((entry) => entry.name);
        expect(names).toEqual([...names].sort());

        const details = await agent.systemdUnit(ownScope, unit.name);

        // Details come from systemd for the unit file the test wrote.
        expect(details).toMatchObject({
            scope: ownScope,
            id: unit.name,
            load_state: "loaded",
            active_state: "inactive",
            unit_file_state: "disabled",
            fragment_path: unit.path,
            drop_in_paths: [],
            need_daemon_reload: false,
            main_pid: null,
            can_reload: false,
            can_manage: true,
            is_agent_unit: false,
        });

        const enabled = await agent.runSystemdUnitAction(
            ownScope,
            unit.name,
            "enable",
        );

        // Enabling installs the unit file for its WantedBy target.
        expect(enabled.unit_file_state).toBe("enabled");
        // Enabling must not start the unit; the UI has a separate start action.
        expect(enabled.active_state).toBe("inactive");
        // The [Install] section's effect on disk is the symlink in default.target.wants.
        expect(lstatSync(unit.wantsLink).isSymbolicLink()).toBe(true);

        const started = await agent.runSystemdUnitAction(
            ownScope,
            unit.name,
            "start",
        );

        // The action resolves after systemd's job, so the returned status is already running.
        expect(started).toMatchObject({
            active_state: "active",
            sub_state: "running",
        });
        // A running simple service has a main process the UI can show.
        expect(started.main_pid).toEqual(expect.any(Number));
        // Entering the active state is timestamped in Unix milliseconds.
        expect(started.active_enter_timestamp_ms).toBeGreaterThan(
            Date.now() - 60_000,
        );

        const restarted = await agent.runSystemdUnitAction(
            ownScope,
            unit.name,
            "restart",
        );

        // A restart replaces the main process and leaves the unit running.
        expect(restarted).toMatchObject({
            active_state: "active",
            sub_state: "running",
        });
        expect(restarted.main_pid).toEqual(expect.any(Number));
        expect(restarted.main_pid).not.toBe(started.main_pid);

        const reload = await failureOf(
            agent.runSystemdUnitAction(ownScope, unit.name, "reload"),
        );

        // A unit without ExecReload refuses the reload job, which is a conflict, not a crash.
        expect(reload).toEqual({ status: 409, code: null });

        const disabled = await agent.runSystemdUnitAction(
            ownScope,
            unit.name,
            "disable",
        );

        // Disabling removes the install symlink again.
        expect(disabled.unit_file_state).toBe("disabled");
        expect(existsSync(unit.wantsLink)).toBe(false);
        // Disabling must not stop a running unit.
        expect(disabled.active_state).toBe("active");

        const stopped = await agent.runSystemdUnitAction(
            ownScope,
            unit.name,
            "stop",
        );

        // Stop waits for the job, so the unit is already inactive without a main process.
        expect(stopped).toMatchObject({
            active_state: "inactive",
            main_pid: null,
        });
    }, 60_000);

    it("reports timer schedules and the timers that activate a service", async () => {
        const timers = createTestTimers();

        await agent.systemdDaemonReload(ownScope);

        const startedAt = Date.now();

        await agent.runSystemdUnitAction(ownScope, timers.timer, "start");

        const details = await agent.systemdUnit(ownScope, timers.timer);

        // The timer's rules are reported as unit file lines, the calendar rule first.
        expect(details.timer?.schedules).toEqual([
            expect.stringMatching(/^OnCalendar=2099-01-01 00:00:00/),
            "OnActiveSec=1h",
        ]);
        // A timer without Unit= activates the service of the same name.
        expect(details.timer?.triggers).toEqual([timers.service]);
        // Persistent= is reported so the UI can say missed runs are caught up.
        expect(details.timer?.persistent).toBe(true);
        // A fresh timer that never elapsed has no last run.
        expect(details.timer?.last_trigger_ms).toBeNull();

        const nextElapse = details.timer?.next_elapse_ms ?? null;

        // The next run is the monotonic OnActiveSec=1h moved onto the wall clock, which is
        // earlier than the 2099 calendar rule; a broken conversion would land far off.
        expect(nextElapse).toBeGreaterThan(startedAt + 3_600_000 - 60_000);
        expect(nextElapse).toBeLessThan(Date.now() + 3_600_000 + 60_000);
        // A timer activates units but is not itself activated by one here.
        expect(details.triggered_by).toEqual([]);

        const serviceDetails = await agent.systemdUnit(
            ownScope,
            timers.service,
        );

        // The service names the timer that starts it, so the UI can explain its runs.
        expect(serviceDetails.triggered_by).toContain(timers.timer);
        // Only timer units carry a schedule.
        expect(serviceDetails.timer).toBeNull();

        const list = await agent.listSystemdUnits(ownScope);

        const listedTimer = list.units.find(
            (unit) => unit.name === timers.timer,
        );

        // A loaded unit's file comes from systemd, so the list links the timer to it.
        expect(listedTimer?.load_state).toBe("loaded");
        expect(listedTimer?.fragment_path).toBe(
            join(userUnitDirectory, timers.timer),
        );
        // The list carries the list-timers columns for loaded timers.
        expect(listedTimer?.timer).toEqual({
            next_elapse_ms: expect.any(Number),
            last_trigger_ms: null,
            triggers: [timers.service],
        });
        // The list converts the monotonic elapse the same way the details do.
        expect(
            Math.abs(
                (listedTimer?.timer?.next_elapse_ms ?? 0) - (nextElapse ?? 0),
            ),
        ).toBeLessThan(5_000);
        // Other unit types carry no timer summary.
        expect(
            list.units.find((unit) => unit.name === timers.service)?.timer,
        ).toBeNull();

        const soonStartedAt = Date.now();

        await agent.runSystemdUnitAction(ownScope, timers.soonTimer, "start");

        const elapsed = await waitForValue({
            description: "the one second timer to elapse",
            timeoutMs: 20_000,
            predicate: async () => {
                const soon = await agent.systemdUnit(
                    ownScope,
                    timers.soonTimer,
                );

                return soon.timer?.last_trigger_ms === null ? undefined : soon;
            },
        });

        // systemd records when the timer really elapsed; show prints whole seconds.
        expect(elapsed.timer?.last_trigger_ms).toBeGreaterThanOrEqual(
            soonStartedAt - 2_000,
        );
        expect(elapsed.timer?.last_trigger_ms).toBeLessThanOrEqual(
            Date.now() + 1_000,
        );
        // A one-shot OnActiveSec timer has nothing left to run after it elapsed.
        expect(elapsed.timer?.next_elapse_ms).toBeNull();
        // An explicit Unit= is the timer's target.
        expect(elapsed.timer?.triggers).toEqual([timers.service]);

        // Both loaded timers now activate the service.
        expect(
            (await agent.systemdUnit(ownScope, timers.service)).triggered_by,
        ).toEqual(expect.arrayContaining([timers.timer, timers.soonTimer]));

        const afterTrigger = await agent.listSystemdUnits(ownScope);

        // The list shows the last run of the timer that elapsed.
        expect(
            afterTrigger.units.find((unit) => unit.name === timers.soonTimer)
                ?.timer?.last_trigger_ms,
        ).toBe(elapsed.timer?.last_trigger_ms);
    }, 60_000);

    it("refuses invalid, unknown and template units", async () => {
        const id = randomBytes(6).toString("hex");

        const template = await failureOf(
            agent.systemdUnit(ownScope, `redoor-test-${id}@.service`),
        );

        // Templates have no status of their own; only their instances do.
        expect(template).toEqual({ status: 400, code: null });

        const missing = await agent.systemdUnit(
            ownScope,
            `redoor-test-missing-${id}.service`,
        );

        // Reading a unit systemd does not know is not an error: systemd reports it not found.
        expect(missing.load_state).toBe("not-found");

        const missingAction = await failureOf(
            agent.runSystemdUnitAction(
                ownScope,
                `redoor-test-missing-${id}.service`,
                "start",
            ),
        );

        // Acting on a unit systemd does not know is a missing resource.
        expect(missingAction).toEqual({ status: 404, code: null });

        for (const invalid of [
            `redoor-test-${id}`,
            `redoor-test-${id}*.service`,
            `redoor test ${id}.service`,
            `redoor-test-${id}.nonsense`,
        ]) {
            // Names without a unit type or with glob or other characters never reach systemd.
            expect(
                await failureOf(agent.systemdUnit(ownScope, invalid)),
                invalid,
            ).toEqual({ status: 400, code: null });
            // Actions validate the name the same way before running systemctl.
            expect(
                await failureOf(
                    agent.runSystemdUnitAction(ownScope, invalid, "start"),
                ),
                invalid,
            ).toEqual({ status: 400, code: null });
        }

        const invalidJournal = await failureOf(
            agent
                .streamSystemdJournal(ownScope, `redoor-test-${id}*.service`)
                .next(),
        );

        // The journal validates before streaming, so the error is a plain JSON response.
        expect(invalidJournal).toEqual({ status: 400, code: null });

        const tooManyLines = await failureOf(
            agent
                .streamSystemdJournal(ownScope, `redoor-test-${id}.service`, {
                    lines: 10_001,
                })
                .next(),
        );

        // The history size is bounded so one request cannot pull an unbounded journal.
        expect(tooManyLines).toEqual({ status: 400, code: null });
    });

    it("streams a unit's journal history and then live entries", async () => {
        const unit = createTestUnit();
        await agent.systemdDaemonReload(ownScope);
        await agent.runSystemdUnitAction(ownScope, unit.name, "start");
        // Journald writes asynchronously; wait until the line is history before opening.
        await waitForValue({
            description: "the first ready line in the user journal",
            predicate: async () => (await journalReadyLines(unit)) >= 1,
        });

        const journal = openSystemdJournal({
            agent,
            scope: ownScope,
            unit: unit.name,
            lines: 50,
        });

        await waitForValue({
            description: "the ready line in the journal history",
            predicate: async () =>
                journalMessages(journal.events).includes(unit.readyLine),
        });

        const readyEntry = journal.events.find(
            (event) =>
                event.type === "entry" &&
                event.entry.message === unit.readyLine,
        );

        // Entries carry the journal's own fields so the UI can show time, priority and process.
        expect(readyEntry).toMatchObject({
            type: "entry",
            entry: {
                timestamp_us: expect.any(Number),
                priority: expect.any(Number),
                pid: expect.any(Number),
                identifier: expect.any(String),
            },
        });

        // A user unit's journal is readable by its own user, so no access note is sent.
        expect(
            journal.events.some((event) => event.type === "access_limited"),
        ).toBe(false);

        await waitForValue({
            description: "journalctl following the unit on the device",
            predicate: async () => (await journalctlPids(unit.name)).length > 0,
        });

        await agent.runSystemdUnitAction(ownScope, unit.name, "restart");

        await waitForValue({
            description: "a live ready line after the restart",
            timeoutMs: 20_000,
            predicate: async () =>
                journalMessages(journal.events).filter(
                    (line) => line === unit.readyLine,
                ).length >= 2,
        });

        // The stream follows the journal: the line written after opening arrived on it.
        expect(
            journalMessages(journal.events).filter(
                (line) => line === unit.readyLine,
            ),
        ).toHaveLength(2);
        // The stream does not end by itself while journalctl follows.
        expect(journal.events.some((event) => event.type === "end")).toBe(
            false,
        );

        await journal.close();

        await waitForValue({
            description: "journalctl to stop after the client went away",
            predicate: async () =>
                (await journalctlPids(unit.name)).length === 0,
        });

        // Closing the HTTP stream stops journalctl on the device instead of leaking it.
        expect(await journalctlPids(unit.name)).toEqual([]);
    }, 60_000);

    it("tells the editor when a unit file needs a daemon-reload", async () => {
        const unit = createTestUnit();
        await agent.systemdDaemonReload(ownScope);
        await agent.runSystemdUnitAction(ownScope, unit.name, "start");

        const fresh = await agent.systemdPathStatus(unit.path);

        // A unit file systemd loaded as written needs no reload.
        expect(fresh).toEqual({
            path: unit.path,
            matches: [
                {
                    scope: ownScope,
                    unit: unit.name,
                    drop_in: false,
                    state: "up_to_date",
                    can_reload: true,
                },
            ],
        });
        // Naming the agent's own user, as links from its unit list do, asks the same manager.
        expect(
            await agent.systemdPathStatus(unit.path, { user: username }),
        ).toEqual(fresh);

        writeFileSync(
            unit.path,
            unitFileContent(unit.readyLine, "Redoor integration test, edited"),
        );

        const edited = await agent.systemdPathStatus(unit.path);

        // Editing the loaded file makes systemd report NeedDaemonReload for the user scope.
        expect(edited.matches).toEqual([
            {
                scope: ownScope,
                unit: unit.name,
                drop_in: false,
                state: "needs_reload",
                can_reload: true,
            },
        ]);
        // The unit details agree with the editor's reload offer.
        expect(
            (await agent.systemdUnit(ownScope, unit.name)).need_daemon_reload,
        ).toBe(true);

        await agent.systemdDaemonReload(ownScope);

        const reloaded = await agent.systemdPathStatus(unit.path);

        // The daemon-reload through the API picked up the edit.
        expect(reloaded.matches[0]?.state).toBe("up_to_date");
        // The reload loaded the new description into the running manager.
        expect((await agent.systemdUnit(ownScope, unit.name)).description).toBe(
            "Redoor integration test, edited",
        );

        mkdirSync(unit.dropInDirectory, { recursive: true });
        const dropIn = join(unit.dropInDirectory, "override.conf");
        writeFileSync(
            dropIn,
            `[Service]
Environment=REDOOR_TEST=1
`,
        );

        const dropInStatus = await agent.systemdPathStatus(dropIn);

        // A new drop-in belongs to the unit it modifies and needs a reload to apply.
        expect(dropInStatus.matches).toEqual([
            {
                scope: ownScope,
                unit: unit.name,
                drop_in: true,
                state: "needs_reload",
                can_reload: true,
            },
        ]);

        await agent.systemdDaemonReload(ownScope);

        // After the reload the running unit uses the drop-in, so no further reload is due.
        expect((await agent.systemdPathStatus(dropIn)).matches[0]?.state).toBe(
            "up_to_date",
        );
        // The unit details list the drop-in so the UI can open it in the editor.
        expect(
            (await agent.systemdUnit(ownScope, unit.name)).drop_in_paths,
        ).toEqual([dropIn]);

        const outside = join(
            tempFiles.tempDirectory({ suffix: "-not-units" }),
            unit.name,
        );

        writeFileSync(outside, unitFileContent(unit.readyLine, "elsewhere"));

        // A unit-looking file outside every unit search path is loaded by no manager.
        expect((await agent.systemdPathStatus(outside)).matches).toEqual([]);

        const relative = await failureOf(
            agent.systemdPathStatus(`.config/systemd/user/${unit.name}`),
        );

        // Search paths are absolute, so a relative path cannot be judged.
        expect(relative).toEqual({ status: 400, code: null });
    }, 60_000);

    it("lets a non-root agent read but not manage the system manager", async () => {
        const list = await agent.listSystemdUnits(systemScope);

        // Listing system units needs no privileges, but the view must be read-only.
        expect(list.scope).toEqual(systemScope);
        expect(list.can_manage).toBe(false);
        // The journal daemon runs on every systemd host.
        expect(
            list.units.find((unit) => unit.name === SYSTEM_UNIT),
        ).toMatchObject({
            load_state: "loaded",
            active_state: "active",
            // System units link to their files just like user units.
            fragment_path: expect.stringMatching(
                /\/systemd-journald\.service$/,
            ),
        });

        const details = await agent.systemdUnit(systemScope, SYSTEM_UNIT);

        // System unit status is readable without root.
        expect(details).toMatchObject({
            scope: systemScope,
            id: SYSTEM_UNIT,
            load_state: "loaded",
            active_state: "active",
            can_manage: false,
            is_agent_unit: false,
        });

        for (const action of [
            "start",
            "stop",
            "restart",
            "reload",
            "enable",
            "disable",
        ] as const) {
            // The agent refuses system actions itself instead of asking polkit for a password.
            expect(
                await failureOf(
                    agent.runSystemdUnitAction(
                        systemScope,
                        SYSTEM_UNIT,
                        action,
                    ),
                ),
                action,
            ).toEqual({ status: 403, code: null });
        }

        // Reloading the system manager is a management action too.
        expect(await failureOf(agent.systemdDaemonReload(systemScope))).toEqual(
            { status: 403, code: null },
        );
        // The refused actions did not touch the unit.
        expect(
            (await agent.systemdUnit(systemScope, SYSTEM_UNIT)).active_state,
        ).toBe("active");
    });

    it("explains when the agent cannot read the system journal", async () => {
        const machineId = (await readFile("/etc/machine-id", "utf8")).trim();

        const journalFiles = ["/var/log/journal", "/run/log/journal"].flatMap(
            (directory) => {
                const path = join(directory, machineId, "system.journal");

                return existsSync(path) ? [path] : [];
            },
        );

        let readable = true;

        if (journalFiles[0] !== undefined) {
            readable = await readFile(journalFiles[0]).then(
                () => true,
                () => false,
            );
        }

        const journal = openSystemdJournal({
            agent,
            scope: systemScope,
            unit: SYSTEM_UNIT,
            lines: 5,
        });

        // An unreadable journal sends its note first; a readable one sends journald's entries.
        const first = await waitForValue({
            description: "the first system journal event",
            timeoutMs: 15_000,
            predicate: async () => journal.events[0],
        });

        if (readable) {
            // A readable system journal streams entries without an access note.
            expect(first.type).toBe("entry");
        } else {
            // The note comes first so the UI explains the missing entries before any appear.
            expect(first).toMatchObject({
                type: "access_limited",
                message: expect.stringContaining("systemd-journal"),
            });
        }

        await journal.close();

        // The access note is sent at most once per stream.
        expect(
            journal.events.filter((event) => event.type === "access_limited")
                .length,
        ).toBeLessThanOrEqual(1);
    }, 30_000);

    it("refuses other users' managers to a non-root agent", async () => {
        const otherScope: SystemdScope = { type: "user", name: OTHER_USER };

        // Calls start one at a time, so no rejection sits unhandled while another runs.
        const refused: [string, () => Promise<Failure>][] = [
            ["list", () => failureOf(agent.listSystemdUnits(otherScope))],
            [
                "details",
                () => failureOf(agent.systemdUnit(otherScope, SYSTEM_UNIT)),
            ],
            [
                "action",
                () =>
                    failureOf(
                        agent.runSystemdUnitAction(
                            otherScope,
                            SYSTEM_UNIT,
                            "start",
                        ),
                    ),
            ],
            [
                "daemon-reload",
                () => failureOf(agent.systemdDaemonReload(otherScope)),
            ],
            [
                "journal",
                () =>
                    failureOf(
                        agent
                            .streamSystemdJournal(otherScope, SYSTEM_UNIT)
                            .next(),
                    ),
            ],
            [
                "linger",
                () => failureOf(agent.setSystemdLinger(OTHER_USER, true)),
            ],
            [
                "path-status",
                () =>
                    failureOf(
                        agent.systemdPathStatus(PATH_STATUS_PROBE, {
                            user: OTHER_USER,
                        }),
                    ),
            ],
        ];

        for (const [label, call] of refused) {
            // A non-root agent cannot reach another account's manager, even for reads.
            expect(await call(), label).toEqual({
                status: 403,
                code: null,
            });
        }

        const unknown = `redoor-no-user-${randomBytes(4).toString("hex")}`;

        // An account that does not exist is reported as missing, so the UI can tell a typo.
        expect(
            await failureOf(
                agent.listSystemdUnits({ type: "user", name: unknown }),
            ),
        ).toEqual({ status: 404, code: null });
        // Linger for an unknown account is missing too, not refused.
        expect(await failureOf(agent.setSystemdLinger(unknown, true))).toEqual({
            status: 404,
            code: null,
        });
        // A path check naming an unknown account's manager is missing too.
        expect(
            await failureOf(
                agent.systemdPathStatus(PATH_STATUS_PROBE, { user: unknown }),
            ),
        ).toEqual({ status: 404, code: null });

        // Names that could be read as options or paths are rejected before any lookup.
        expect(
            await failureOf(
                agent.listSystemdUnits({ type: "user", name: "-root" }),
            ),
        ).toEqual({ status: 400, code: null });
    });

    it("keeps the agent account's linger unchanged when setting it to its current value", async () => {
        const before = await agent.systemdOverview();

        const responses: SystemdLingerResponse[] = [];

        // Setting the current value changes nothing on the developer's machine either way.
        const outcome = await failureOf(
            agent
                .setSystemdLinger(username, before.linger)
                .then((response) => responses.push(response)),
        );

        // logind either allows the own account's linger or polkit refuses it as forbidden.
        expect([200, 403]).toContain(outcome.status);

        if (outcome.status === 200) {
            // The response reports logind's state after the change.
            expect(responses).toEqual([
                { user: username, linger: before.linger },
            ]);
        }

        // The linger state is unchanged after the call.
        expect((await agent.systemdOverview()).linger).toBe(before.linger);
    });

    it("reports agents without systemd as unsupported", async () => {
        const fake = await FakeAgent.connect({
            serverPort,
            agentName: `systemd-fake-${randomBytes(4).toString("hex")}`,
        });

        onTestFinished(() => fake.close());

        // An agent without systemd answers every systemd command with the typed failure.
        fake.onCommand((command) => {
            if (command.command.type.startsWith("Systemd")) {
                fake.fail(
                    command.id,
                    "systemd_unsupported",
                    "This device does not use systemd",
                );
            }
        });

        const listed = await waitForValue({
            description: "fake agent connected",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.id === fake.agentId &&
                        entry.status === "connected",
                ),
        });

        // An agent whose hello carries no systemd field is treated as not using systemd.
        expect(listed.systemd).toEqual({
            status: "unavailable",
            reason: "The agent did not report systemd support",
        });

        const overview = await failureOf(listed.systemdOverview());

        // The typed failure lets the UI show "does not use systemd" instead of an error.
        expect(overview).toEqual({ status: 501, code: "systemd_unsupported" });
        // Scoped routes forward the same typed failure.
        expect(await failureOf(listed.listSystemdUnits(ownScope))).toEqual({
            status: 501,
            code: "systemd_unsupported",
        });
    });
});
