import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    onTestFinished,
} from "vitest";
import { ApiClient, ApiError } from "#ui/api-client";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
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

const AGENT_NAME = "restart-agent";
const SECOND_AGENT_NAME = "restart-agent-two";

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();

let serverPort: number;
let apiClient: ApiClient;
let configPath: string;
let serverLogPath: string;
let serverPid: number;
let agentDir: string;
let agentLogPath: string;
let secondAgentDir: string;
let secondAgentLogPath: string;

function writeValidConfig(options?: { includeSecondAgent?: boolean }) {
    const secondAgent = options?.includeSecondAgent
        ? `
[[agents]]
local = true
name = "${SECOND_AGENT_NAME}"
dir = "${secondAgentDir}"
log = "${secondAgentLogPath}"
`
        : "";

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${AGENT_NAME}"
dir = "${agentDir}"
log = "${agentLogPath}"
${secondAgent}`,
    );
}

beforeAll(async () => {
    serverPort = VITEST_SERVER_PORT;
    apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);

    agentDir = tempFiles.tempDirectory({ suffix: "-restart-agent-cwd" });
    secondAgentDir = tempFiles.tempDirectory({
        suffix: "-restart-agent-two-cwd",
    });
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    agentLogPath = tempFiles.tempFile({ suffix: ".log" });
    secondAgentLogPath = tempFiles.tempFile({ suffix: ".log" });
    rmSync(agentLogPath, { force: true });
    rmSync(secondAgentLogPath, { force: true });
    writeValidConfig();

    serverLogPath = tempFiles.tempFile({ suffix: ".log" });
    rmSync(serverLogPath, { force: true });

    process.env.REDOOR_PORT = serverPort.toString();
    serverPid = processManager.spawnServer({
        config: configPath,
        log: serverLogPath,
    });

    await waitForPort(serverPort);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
    await apiClient.waitForAgentNames([AGENT_NAME], 15000);
}, 30000);

afterAll(() => {
    processManager.killAll();
    tempFiles.cleanup();
});

describe("process restart APIs", () => {
    it("rejects invalid config without restarting the process", async () => {
        onTestFinished(() => {
            // Restore a valid config so later tests and teardown see a healthy server.
            writeValidConfig();
        });

        writeFileSync(configPath, "this is not valid toml [[[");

        await expect(apiClient.restartServer()).rejects.toSatisfy(
            (error: unknown) => {
                // Invalid TOML must be rejected pre-restart so the operator keeps the running process.
                return (
                    error instanceof ApiError &&
                    error.status === 400 &&
                    error.message.includes("Invalid config")
                );
            },
        );

        // Server must still be serving the previous config (agent still listed).
        const agents = await apiClient.listAgents();
        expect(agents.map((agent) => agent.name)).toContain(AGENT_NAME);

        // PID must be unchanged because we never exec'd.
        expect(() => process.kill(serverPid, 0)).not.toThrow();
    });

    it("restarts an agent in place", async () => {
        let agent = (await apiClient.listAgents()).find(
            (entry) => entry.name === AGENT_NAME,
        );
        expect(agent).toBeDefined();
        if (!agent) return;
        if (agent.status !== "connected") {
            await agent.start();
            await apiClient.waitForConnectedAgentNames([AGENT_NAME], 15000);
            agent = (await apiClient.listAgents()).find(
                (entry) => entry.name === AGENT_NAME,
            );
            // Starting must retain the configured inventory record for the restart request.
            expect(agent).toBeDefined();
            if (!agent) return;
        }
        const detailsBefore = await agent.getDetails();
        const loadedBefore = (
            readFileSync(agentLogPath, "utf8").match(/Starting agent/g) ?? []
        ).length;

        const response = await agent.restart();
        // The control response must be flushed before the agent replaces itself.
        expect(response.restarting).toBe(true);

        await waitForValue({
            timeoutMs: 30000,
            description: "agent startup log after restart",
            predicate: async () => {
                const loadedAfter = (
                    readFileSync(agentLogPath, "utf8").match(
                        /Starting agent/g,
                    ) ?? []
                ).length;
                return loadedAfter > loadedBefore || undefined;
            },
        });
        const restartedAgent = (await apiClient.listAgents()).find(
            (entry) => entry.name === AGENT_NAME,
        );
        expect(restartedAgent).toBeDefined();
        if (!restartedAgent) return;
        const detailsAfter = await restartedAgent.getDetails();
        // Self-exec deliberately preserves the PID for watchdog and SSH ownership.
        expect(detailsAfter.pid).toBe(detailsBefore.pid);
    }, 60000);

    it("restarts the server in place and applies a mutated config.toml", async () => {
        writeValidConfig({ includeSecondAgent: true });

        const response = await apiClient.restartServer();
        // Handler acknowledges before graceful shutdown + self-exec.
        expect(response.restarting).toBe(true);

        // Poll until the restarted process is healthy and the new agent is supervised.
        // Never sleep fixed time as the only wait — poll the API.
        await waitForValue({
            timeoutMs: 30000,
            description: "server to come back with both agents after restart",
            predicate: async () => {
                try {
                    const agents = await apiClient.listAgents();
                    const names = agents.map((agent) => agent.name);
                    return (
                        names.includes(AGENT_NAME) &&
                        names.includes(SECOND_AGENT_NAME)
                    );
                } catch {
                    return undefined;
                }
            },
        });

        const agents = await apiClient.listAgents();
        const names = agents.map((agent) => agent.name).sort();
        // Both dormant inventory records prove the mutated config was applied via full startup.
        expect(names).toEqual([AGENT_NAME, SECOND_AGENT_NAME].sort());
        // Restart intentionally resets configured supervisors instead of eagerly launching them.
        expect(agents.every((agent) => agent.status === "stopped")).toBe(true);

        // exec keeps the same PID so ProcessManager.kill still works at teardown.
        expect(() => process.kill(serverPid, 0)).not.toThrow();

        // Optional signal that startup ran again after restart.
        const log = readFileSync(serverLogPath, "utf8");
        const loadedMatches = log.match(/Loaded server config/g) ?? [];
        // First startup plus post-restart startup.
        expect(loadedMatches.length).toBeGreaterThanOrEqual(2);
    }, 60000);
});
