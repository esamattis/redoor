import { describe, it, expect, beforeAll, afterAll, onTestFinished } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import { writeFileSync, rmSync } from "node:fs";
import {
    ProcessManager,
    TempFileManager,
    getAvailablePort,
    waitForValue,
    waitForPort,
} from "./test-utils";

const AGENT_NAME = "watchdog-test-agent";

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();

let serverPort: number;
let apiClient: ApiClient;
let configPath: string;
let serverLogPath: string;

beforeAll(async () => {
    serverPort = await getAvailablePort();
    apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);

    // Build a temp config file with one local agent so the server's
    // watchdog supervisor is in charge of the agent's lifecycle.
    // Pointing `dir` at a temp directory keeps the agent from doing
    // anything surprising on the test host.
    const agentDir = tempFiles.tempDirectory({ suffix: "-watchdog-agent-cwd" });
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    const agentLogPath = tempFiles.tempFile({ suffix: ".log" });
    rmSync(agentLogPath, { force: true });
    writeFileSync(
        configPath,
        `[[agents]]\nlocal = true\nname = "${AGENT_NAME}"\ndir = "${agentDir}"\nlog = "${agentLogPath}"\n`,
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

    // The supervisor-spawned agent registers automatically once the
    // server is up. Wait for it via the REST API rather than a
    // stdout log match: the supervisor may register the agent
    // before the test attaches a stdout listener, so the log-based
    // waitForLogMessage helper would miss it.
    await waitForValue({
        timeoutMs: 15000,
        description: `watchdog agent ${AGENT_NAME} to be listed`,
        predicate: async () => {
            const agents = await apiClient.listAgents();
            return agents.find((a) => a.name === AGENT_NAME);
        },
    });
}, 30000);

afterAll(() => {
    processManager.killAll();
    tempFiles.cleanup();
});

/** Returns the single watchdog-spawned agent, asserting it's present. */
async function getWatchdogAgent(): Promise<Agent> {
    const agents = await apiClient.listAgents();
    const agent = agents.find((a) => a.name === AGENT_NAME);
    if (!agent) {
        throw new Error(`Watchdog agent ${AGENT_NAME} not found`);
    }
    return agent;
}

describe("Watchdog supervisor", () => {
    it("restarts the subprocess when the agent process is killed", async () => {
        const agent = await getWatchdogAgent();
        const firstDetails = await agent.getDetails();
        const firstPid = firstDetails.pid;
        // A positive PID is the cheapest sanity check that the agent
        // actually ran a subprocess and reported it back to the server.
        expect(firstPid).toBeGreaterThan(0);

        // SIGKILL the agent subprocess. The supervisor watches
        // `child.wait()` and should react by starting a new cycle.
        process.kill(firstPid, "SIGKILL");

        // Wait for the new agent to be listed with a different PID.
        // The supervisor's first backoff is 1s, so the new agent
        // should appear within a few seconds.
        const replacement = await waitForValue({
            timeoutMs: 15000,
            description: "watchdog agent to be re-registered with a new PID",
            predicate: async () => {
                const agents = await apiClient.listAgents();
                const a = agents.find((x) => x.name === AGENT_NAME);
                if (!a) {
                    return undefined;
                }
                const details = await a.getDetails();
                return details.pid !== firstPid ? details : undefined;
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

    it(
        "restarts the subprocess when the WebSocket goes stale",
        async () => {
            // Stale detection is timed in seconds (ping interval 10s,
            // stale timeout 30s, stale check every 5s) so this test
            // can take up to ~40s end to end. We pad the timeout to
            // 60s so a slow CI host still completes it.
            const agent = await getWatchdogAgent();
            const firstDetails = await agent.getDetails();
            const firstPid = firstDetails.pid;
            expect(firstPid).toBeGreaterThan(0);

            // SIGSTOP freezes the agent without killing it. The
            // kernel still has a live process, so the supervisor's
            // `child.wait()` does not fire; the WebSocket session,
            // however, sees zero frames and the stale check fires
            // after 30s of silence. The supervisor then SIGKILLs
            // the frozen process (SIGKILL works on a stopped
            // process) and respawns a fresh agent.
            process.kill(firstPid, "SIGSTOP");

            // Register cleanup at the top of the test so it is
            // visible and runs even if the test times out (vitest
            // skips the body of a timed-out test, so a
            // `try/finally` here would not always fire).
            onTestFinished(() => {
                // Resume the frozen process if it is still alive so
                // it can receive the SIGKILL cleanly. If the
                // supervisor already killed it, the kill returns
                // ESRCH which we ignore.
                try {
                    process.kill(firstPid, "SIGCONT");
                } catch {
                    // process already gone, nothing to resume
                }
            });

            const replacement = await waitForValue({
                timeoutMs: 60000,
                description:
                    "watchdog agent to be restarted after WebSocket went stale",
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    const a = agents.find((x) => x.name === AGENT_NAME);
                    if (!a) {
                        return undefined;
                    }
                    const details = await a.getDetails();
                    return details.pid !== firstPid ? details : undefined;
                },
            });

            // A new, different PID proves the supervisor
            // actually killed the frozen process and respawned
            // a fresh one in response to the stale signal.
            expect(replacement.pid).not.toBe(firstPid);
            expect(replacement.pid).toBeGreaterThan(0);

            // The replacement should be responsive via the REST
            // API, confirming the new WebSocket is live.
            const replacementAgent = await getWatchdogAgent();
            const echo = await replacementAgent.echo("alive");
            expect(echo.message).toBe("alive");
        },
        90000,
    );
});
