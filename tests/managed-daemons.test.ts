import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    copyFileSync,
    existsSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ApiClient, type Agent } from "#ui/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    managedDaemonDataDir,
    managedDaemonPid,
    processIsAlive,
    waitForPort,
    waitForValue,
} from "./test-utils";
import {
    TEST_TERMINAL_SIZE,
    TerminalViewer,
    openTerminal,
} from "./terminal-test-utils";

const RUNNING_AGENT = "daemon-running";

const STOPPED_AGENT = "daemon-stopped";

const processes = new ProcessManager();

const tempFiles = new TempFileManager();

const api = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);

let configPath: string;

let serverPid: number;

let agentHome: string;

/** Starts the test server from `executablePath` (the built binary by default). */
async function startServer(options?: {
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void> {
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    serverPid = processes.spawnServer({
        config: configPath,
        executablePath: options?.executablePath,
        // Daemons inherit the server's environment; a plain shell needs no profile in the
        // server's temporary home.
        env: { SHELL: "/bin/sh", ...options?.env },
    });
    await waitForPort(VITEST_SERVER_PORT);
    await api.login(TEST_USERNAME, TEST_PASSWORD);
}

/** Kills the server process (and its sessions) the way a crash does; daemons survive. */
async function crashServer(): Promise<void> {
    await processes.killAndWait(serverPid);
}

/** The inventory row of `name`. */
async function agentNamed(name: string): Promise<Agent> {
    const agent = (await api.listAgents()).find((entry) => entry.name === name);

    if (agent === undefined) {
        throw new Error(`Agent ${name} not found`);
    }

    return agent;
}

/** Waits until `name` is connected on a connection other than `previousConnection`. */
async function waitForConnected(
    name: string,
    previousConnection?: string | null,
): Promise<Agent> {
    return waitForValue({
        timeoutMs: 30_000,
        description: `${name} to connect`,
        predicate: async () => {
            const agent = (await api.listAgents()).find(
                (entry) =>
                    entry.name === name &&
                    entry.status === "connected" &&
                    entry.connectionId !== previousConnection,
            );

            return agent;
        },
    });
}

/**
 * Waits until the daemon of `name` that reconnected on its own was adopted and then
 * replaced by the ensure step with the daemon this server expects, and that one connected.
 * The adopted daemon's provisional connection comes first, so waiting for any connection
 * would return the daemon that is about to be replaced.
 */
async function waitForReplacedDaemon(name: string): Promise<Agent> {
    return waitForValue({
        timeoutMs: 30_000,
        description: `${name}'s daemon to be replaced and connect`,
        predicate: async () => {
            const agent = await agentNamed(name);
            const steps = agent.provisioningStatus.map((step) => step.message);

            const replaced = steps.findIndex((message) =>
                message.startsWith("Replaced the agent daemon"),
            );

            return agent.status === "connected" &&
                replaced !== -1 &&
                steps.lastIndexOf("Connected") > replaced
                ? agent
                : undefined;
        },
    });
}

/** Waits until the daemon process `pid` is gone. */
async function waitForExit(pid: number, description: string): Promise<void> {
    await waitForValue({
        timeoutMs: 20_000,
        description,
        predicate: async () => (processIsAlive(pid) ? undefined : true),
    });
}

/** The PID the daemon of `agent` recorded, failing when it has none. */
function daemonPid(agent: Agent): number {
    const pid = managedDaemonPid(agent.id);

    if (pid === null) {
        throw new Error(`Daemon of ${agent.name} has no PID file`);
    }

    return pid;
}

/** Runs `echo <marker>-$$` in the shell and returns the shell's PID from the output. */
async function shellPid(viewer: TerminalViewer, marker: string): Promise<string> {
    viewer.type(`echo ${marker}-$$\n`);

    const output = await viewer.waitForOutputMatching(
        new RegExp(`${marker}-(\\d+)`),
    );

    const match = new RegExp(`${marker}-(\\d+)`).exec(output);

    if (match?.[1] === undefined) {
        throw new Error(`No shell PID in ${output}`);
    }

    return match[1];
}

beforeAll(async () => {
    agentHome = tempFiles.tempDirectory({ suffix: "-managed-daemon-home" });
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${RUNNING_AGENT}"
home = "${agentHome}"

[[agents]]
local = true
name = "${STOPPED_AGENT}"
home = "${agentHome}"
`,
    );
    await startServer();
    await (await agentNamed(RUNNING_AGENT)).start();
    await waitForConnected(RUNNING_AGENT);
}, 60_000);

afterAll(async () => {
    await processes.killAll();
    tempFiles.cleanup();
});

describe("managed local agent daemons", () => {
    it("keeps the shell and its screen across an in-place server restart", async () => {
        const agent = await agentNamed(RUNNING_AGENT);
        const pidBefore = daemonPid(agent);
        const { session, viewer } = await openTerminal(api, agent, agentHome);
        const shell = await shellPid(viewer, "before");
        const bootId = (await api.getServerInfo()).boot_id;

        await api.restartServer();
        await waitForValue({
            timeoutMs: 20_000,
            description: "restarted server",
            predicate: async () =>
                (await api.getServerInfo()).boot_id !== bootId || undefined,
        });
        // Nothing starts the device; its daemon reconnects by itself and is adopted.
        await waitForConnected(RUNNING_AGENT, agent.connectionId);

        // The server only dropped the session; the daemon and its shell kept running.
        expect(daemonPid(await agentNamed(RUNNING_AGENT))).toBe(pidBefore);
        // The daemon reports its shell to the restarted server, which kept no index of it.
        await waitForValue({
            timeoutMs: 15_000,
            description: "session reported by the daemon",
            predicate: async () =>
                (await api.listTerminalSessions()).sessions.find(
                    (listed) => listed.id === session.id,
                ),
        });

        const reattached = new TerminalViewer(
            api,
            session.id,
            TEST_TERMINAL_SIZE,
        );

        await reattached.waitForReady();
        // The snapshot still shows what the shell printed before the restart.
        await reattached.waitForOutput(`before-${shell}`);
        // The same shell answers, not a new one.
        expect(await shellPid(reattached, "after")).toBe(shell);
    }, 90_000);

    it("adopts a reconnecting daemon after a crash and starts no stopped device", async () => {
        const stopped = await agentNamed(STOPPED_AGENT);
        await stopped.start();
        await waitForConnected(STOPPED_AGENT);
        const stoppedPid = daemonPid(stopped);
        await stopped.shutdown();
        await waitForExit(stoppedPid, "the stopped device's daemon to exit");
        const running = await agentNamed(RUNNING_AGENT);
        const runningPid = daemonPid(running);

        await crashServer();
        // The daemon outlived the server.
        expect(processIsAlive(runningPid)).toBe(true);
        await startServer();

        // The running device's daemon reconnects by itself and is kept, so its shells live on.
        const back = await waitForConnected(RUNNING_AGENT);
        expect(daemonPid(back)).toBe(runningPid);
        // The server starts no device itself, so the stopped one stays stopped.
        expect((await agentNamed(STOPPED_AGENT)).status).toBe("stopped");
    }, 90_000);

    it("replaces the daemon when the server starts from another binary", async () => {
        const agent = await agentNamed(RUNNING_AGENT);
        const pidBefore = daemonPid(agent);
        const { session } = await openTerminal(api, agent, agentHome);

        const copy = join(
            tempFiles.tempDirectory({ suffix: "-other-binary" }),
            "redoor",
        );

        // A copy is another file with the same build, like a reinstall of the same release.
        copyFileSync(SERVER_PATH, copy);

        await crashServer();
        await startServer({ executablePath: copy });
        const replaced = await waitForReplacedDaemon(RUNNING_AGENT);

        // The old daemon reconnected and was adopted, and the adoption's ensure step replaced
        // it because it runs another binary file.
        expect(daemonPid(replaced)).not.toBe(pidBefore);
        await waitForExit(pidBefore, "the old daemon to exit");

        // The adopted old daemon reported its shell before it was replaced, so the tab
        // explains why its shell is gone.
        const listed = await waitForValue({
            timeoutMs: 15_000,
            description: "the old shell to be listed as ended",
            predicate: async () => {
                const sessions = await api.listTerminalSessions();

                const found = sessions.sessions.find(
                    (entry) => entry.id === session.id,
                );

                return found?.status.type === "exited" ? found : undefined;
            },
        });

        expect(listed.status).toEqual({
            type: "exited",
            message: "Shell ended when its device restarted",
        });
        await crashServer();
        await startServer();
        await waitForReplacedDaemon(RUNNING_AGENT);
    }, 120_000);

    it("does not loop when the binary at the old server's path was replaced", async () => {
        const directory = tempFiles.tempDirectory({ suffix: "-upgraded-binary" });
        const path = join(directory, "redoor");
        copyFileSync(SERVER_PATH, path);
        await crashServer();
        await startServer({ executablePath: path });
        const before = await waitForReplacedDaemon(RUNNING_AGENT);
        const pidBefore = daemonPid(before);

        // What `redoor upgrade --no-restart` does: a new file is renamed over the path while
        // the old server keeps running.
        copyFileSync(SERVER_PATH, `${path}.new`);
        renameSync(`${path}.new`, path);
        process.kill(pidBefore, "SIGKILL");

        const after = await waitForConnected(RUNNING_AGENT, before.connectionId);
        const pidAfter = daemonPid(after);

        // The new daemon runs the new file, which the old server accepts because it compares
        // with the ensure report, not with its own build.
        expect(pidAfter).not.toBe(pidBefore);

        const settled = await waitForValue({
            timeoutMs: 15_000,
            description: "the new daemon to stay connected",
            predicate: async () => {
                const agent = await agentNamed(RUNNING_AGENT);

                return agent.status === "connected" &&
                    agent.provisioningStatus.some(
                        (step) => step.message === "Connected",
                    )
                    ? agent
                    : undefined;
            },
        });

        // No supersede and restart cycle: the same daemon and connection are still there.
        expect(settled.connectionId).toBe(after.connectionId);
        expect(daemonPid(settled)).toBe(pidAfter);
        await crashServer();
        await startServer();
        await waitForReplacedDaemon(RUNNING_AGENT);
    }, 120_000);

    it("refuses per-device upgrades of managed agents", async () => {
        const agent = await agentNamed(RUNNING_AGENT);

        // The server upgrades managed daemons itself; a per-device upgrade would be undone.
        await expect(agent.forceInstallRunningBinary()).rejects.toMatchObject({
            status: 409,
        });
    }, 30_000);

    it("replaces the daemon on Restart and ends it on Stop", async () => {
        const agent = await agentNamed(RUNNING_AGENT);
        const pidBefore = daemonPid(agent);

        await agent.restart();

        const restarted = await waitForConnected(
            RUNNING_AGENT,
            agent.connectionId,
        );

        const pidAfter = daemonPid(restarted);

        // A Restart of a managed device replaces its daemon in a new cycle.
        expect(pidAfter).not.toBe(pidBefore);
        await waitForExit(pidBefore, "the restarted daemon's predecessor to exit");

        await restarted.shutdown();
        await waitForExit(pidAfter, "the stopped daemon to exit");

        const stopped = await waitForValue({
            timeoutMs: 15_000,
            description: "the device to settle stopped",
            predicate: async () => {
                const entry = await agentNamed(RUNNING_AGENT);

                return entry.status === "stopped" ? entry : undefined;
            },
        });

        // Nothing is pending once the daemon is gone.
        expect(stopped.connectionIssue).toBeNull();
    }, 60_000);

    it("deleting a device ends its daemon and removes its namespace", async () => {
        const agent = await agentNamed(STOPPED_AGENT);
        await agent.start();
        await waitForConnected(STOPPED_AGENT);
        const pid = daemonPid(agent);
        const namespace = managedDaemonDataDir(agent.id);
        // The daemon logs into its own namespace.
        expect(readFileSync(join(namespace, "agent.log"), "utf8")).toContain(
            "Starting agent",
        );

        await agent.shutdown();
        await api.deleteManagedAgent(agent.id, "local");

        await waitForExit(pid, "the deleted device's daemon to exit");
        await waitForValue({
            timeoutMs: 15_000,
            description: "the deleted device's namespace to be removed",
            predicate: async () => (existsSync(namespace) ? undefined : true),
        });
    }, 60_000);

    it("a daemon without a server exits at its orphan limit", async () => {
        await crashServer();
        await startServer({ env: { REDOOR_MANAGED_ORPHAN_TIMEOUT: "2s" } });
        const agent = await agentNamed(RUNNING_AGENT);
        // An earlier test stopped the device, so no daemon is left to adopt.
        await agent.start();
        const connected = await waitForConnected(RUNNING_AGENT);
        const pid = daemonPid(connected);

        await crashServer();

        // Without a connection for the limit the daemon gives up on its own.
        await waitForExit(pid, "the orphaned daemon to exit");
        expect(
            readFileSync(
                join(managedDaemonDataDir(agent.id), "agent.log"),
                "utf8",
            ),
        ).toContain("orphan limit");
    }, 60_000);
});
