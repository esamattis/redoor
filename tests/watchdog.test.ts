import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    onTestFinished,
} from "vitest";
import { ApiClient, Agent } from "#ui/api-client";
import { writeFileSync, rmSync } from "node:fs";
import {
    ProcessManager,
    TempFileManager,
    VITEST_SERVER_PORT,
    waitForValue,
    waitForPort,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
} from "./test-utils";

const AGENT_NAME = "watchdog-test-agent";

const FAILING_AGENT_NAME = "watchdog-failing-agent";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

let serverPort: number;

let apiClient: ApiClient;

let configPath: string;

let serverLogPath: string;

beforeAll(async () => {
    serverPort = VITEST_SERVER_PORT;
    apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);

    // Build a temp config file with one local agent so the server's
    // watchdog supervisor is in charge of the agent's lifecycle.
    // Pointing `dir` at a temp directory keeps the agent from doing
    // anything surprising on the test host.
    const agentDir = tempFiles.tempDirectory({ suffix: "-watchdog-agent-cwd" });
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${AGENT_NAME}"
home = "${agentDir}"

[[agents]]
local = true
name = "${FAILING_AGENT_NAME}"
home = "${agentDir}/does-not-exist"
`,
    );

    // Capture the server's own log to a file so the test can
    // inspect it on failure. The agent's own log is configured
    // above; this is the server's `--log`.
    serverLogPath = tempFiles.tempFile({ suffix: ".log" });
    rmSync(serverLogPath, { force: true });

    process.env.REDOOR_PORT = serverPort.toString();
    processManager.spawnServer({
        config: configPath,
        log: serverLogPath,
    });

    await waitForPort(serverPort);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    const configuredAgent = await waitForValue({
        timeoutMs: 15000,
        description: `watchdog agent ${AGENT_NAME} inventory registration`,
        predicate: async () => {
            const agents = await apiClient.listAgents();

            return agents.find((agent) => agent.name === AGENT_NAME);
        },
    });

    // Configuration must create visible inventory without eagerly launching a subprocess.
    expect(configuredAgent.managed).toBe(true);
    expect(configuredAgent.status).toBe("stopped");

    await configuredAgent.start();
    await waitForValue({
        timeoutMs: 15000,
        description: `watchdog agent ${AGENT_NAME} to connect after explicit start`,
        predicate: async () => {
            const agents = await apiClient.listAgents();

            return agents.find(
                (agent) =>
                    agent.name === AGENT_NAME && agent.status === "connected",
            );
        },
    });
}, 30000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** Returns the single watchdog-spawned agent, asserting it's present. */
async function getWatchdogAgent(): Promise<Agent> {
    const agents = await apiClient.listAgents();

    const agent = agents.find(
        (entry) => entry.name === AGENT_NAME && entry.status === "connected",
    );

    if (!agent) {
        throw new Error(`Watchdog agent ${AGENT_NAME} not found`);
    }

    return agent;
}

describe("Watchdog supervisor", () => {
    it("starts a new daemon when the daemon process is killed", async () => {
        const firstAgent = await getWatchdogAgent();
        const firstConnectionId = firstAgent.connectionId;

        if (!firstConnectionId) {
            throw new Error("Watchdog agent has no control connection id");
        }

        const firstDetails = await waitForValue({
            timeoutMs: 15000,
            description: "watchdog agent to be responsive after startup",
            predicate: async () => firstAgent.getDetails(),
        });

        const firstPid = firstDetails.pid;
        // A positive PID is the cheapest sanity check that the agent
        // actually ran a subprocess and reported it back to the server.
        expect(firstPid).toBeGreaterThan(0);

        // SIGKILL the daemon. Its session sees the lock released and ends, and the
        // supervisor's next cycle starts a new daemon.
        process.kill(firstPid, "SIGKILL");

        // Wait for the new agent to be listed with a different PID.
        // The supervisor's first backoff is 1s, so the new agent
        // should appear within a few seconds.
        const replacement = await waitForValue({
            timeoutMs: 15000,
            description: "watchdog agent to be re-registered with a new PID",
            predicate: async () => {
                const agents = await apiClient.listAgents();

                const a = agents.find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected" &&
                        entry.connectionId !== firstConnectionId,
                );

                if (!a) {
                    return undefined;
                }

                const details = await a.getDetails();

                return details;
            },
        });

        // A new, different PID proves the supervisor actually
        // respawned a fresh subprocess instead of leaving the
        // registry stale.
        expect(replacement.pid).not.toBe(firstPid);
        expect(replacement.pid).toBeGreaterThan(0);
        // The old PID should be gone; the kernel reuses PIDs but a
        // long-running test would notice a new process with the same
        // PID. We just check that `getDetails` works against the new
        // connection, which is the actual user-facing guarantee.
        const replacementAgent = await getWatchdogAgent();
        const replacementDetails = await replacementAgent.getDetails();
        expect(replacementDetails.pid).toBe(replacement.pid);
    }, 30000);

    it("keeps the daemon when its WebSocket goes stale and reconnects it", async () => {
        // Stale detection uses the suite's shortened REDOOR_WEBSOCKET_* timers, so the
        // server notices the frozen daemon in about a second.
        const firstAgent = await getWatchdogAgent();
        const firstConnectionId = firstAgent.connectionId;

        if (!firstConnectionId) {
            throw new Error("Watchdog agent has no control connection id");
        }

        const firstPid = (await firstAgent.getDetails()).pid;
        expect(firstPid).toBeGreaterThan(0);

        // SIGSTOP freezes the daemon without killing it, so its socket goes silent.
        process.kill(firstPid, "SIGSTOP");
        onTestFinished(() => {
            try {
                process.kill(firstPid, "SIGCONT");
            } catch {
                // The daemon is already gone.
            }
        });

        await waitForValue({
            timeoutMs: 15000,
            description: "stale daemon connection to be dropped",
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === AGENT_NAME,
                );

                return agent?.connectionId !== firstConnectionId || undefined;
            },
        });
        process.kill(firstPid, "SIGCONT");

        const replacement = await waitForValue({
            timeoutMs: 15000,
            description: "the same daemon to reconnect after its connection went stale",
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected" &&
                        entry.connectionId !== firstConnectionId,
                );

                return agent ? agent.getDetails() : undefined;
            },
        });

        // A stale socket only drops the tunnel; the daemon and its shells keep running.
        expect(replacement.pid).toBe(firstPid);
        const echo = await (await getWatchdogAgent()).echo("alive");
        // The new connection carries commands.
        expect(echo.message).toBe("alive");
    }, 30000);

    it("intentionally shuts down and can restart a managed agent", async () => {
        const agent = await getWatchdogAgent();
        const details = await agent.getDetails();
        const oldPid = details.pid;
        const response = await agent.shutdown();

        // The session is gone at once; the daemon is stopped right after.
        expect(["stopping", "stopped"]).toContain(response.agent.status);

        const stopped = await waitForValue({
            timeoutMs: 15000,
            description: "managed agent to settle stopped",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME && entry.status === "stopped",
                ),
        });

        // Intentional shutdown retains the managed row rather than removing it.
        expect(stopped?.status).toBe("stopped");
        expect(stopped?.managed).toBe(true);

        if (!stopped) throw new Error("Stopped managed agent disappeared");
        await stopped.start();
        await waitForValue({
            timeoutMs: 15000,
            description: "managed agent to reconnect after restart",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected",
                ),
        });
        const restartedDetails = await (await getWatchdogAgent()).getDetails();
        // Stop ended the daemon, so the start runs a new one.
        expect(restartedDetails.pid).not.toBe(oldPid);
    }, 30000);

    it("atomically retries a managed attempt and replaces its connected child", async () => {
        const agent = await getWatchdogAgent();
        const firstConnectionId = agent.connectionId;

        if (!firstConnectionId) {
            throw new Error("Watchdog agent has no control connection id");
        }

        const firstDetails = await agent.getDetails();

        const response = await agent.retryStart();
        // Acceptance is a cleanup barrier but deliberately does not wait for reconnection.
        expect(response.agent.status).toBe("starting");
        expect(response.agent.connection_issue).toBeNull();

        const replacement = await waitForValue({
            timeoutMs: 15000,
            description: "retried managed agent to connect with a fresh generation",
            predicate: async () => {
                const candidate = (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected" &&
                        entry.connectionId !== firstConnectionId,
                );

                if (!candidate) return undefined;

                return candidate.getDetails();
            },
        });

        // A different PID proves the retry endpoint canceled the owned child before replacement.
        expect(replacement.pid).not.toBe(firstDetails.pid);
        const inventory = await apiClient.listAgents();
        // Unrelated controls remain responsive while the replacement registration settles.
        expect(inventory.some((entry) => entry.name === FAILING_AGENT_NAME)).toBe(
            true,
        );
    }, 30000);

    it("surfaces managed startup issues without blocking control APIs", async () => {
        const failingAgent = (await apiClient.listAgents()).find(
            (entry) => entry.name === FAILING_AGENT_NAME,
        );

        if (!failingAgent)
            throw new Error("Failing configured agent not found");
        onTestFinished(async () => {
            await failingAgent.shutdown();
        });

        await failingAgent.start();

        const issue = await waitForValue({
            timeoutMs: 15000,
            description: "failing managed agent connection issue",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === FAILING_AGENT_NAME &&
                        entry.connectionIssue !== null,
                ),
        });

        // Concrete child failures remain visible while desired-running retries continue.
        expect(issue.status).toBe("starting");
        expect(issue.connectionIssue).toBeTruthy();
        const retried = await failingAgent.retryStart();
        // A broken agent still accepts a clean attempt rather than treating desired-running as idempotent.
        expect(retried.agent.status).toBe("starting");
        const inventory = await apiClient.listAgents();
        // An unrelated list control remains responsive while the broken supervisor retries.
        expect(inventory.some((entry) => entry.name === AGENT_NAME)).toBe(true);
    }, 30000);
});
