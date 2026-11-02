import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    onTestFinished,
} from "vitest";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
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

let secondAgentDir: string;

/** Writes the config with the one managed agent the suite starts with. */
function writeValidConfig() {
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
`,
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

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

describe("process restart APIs", () => {
    it("rejects invalid config without restarting the process", async () => {
        // The server wrote the assigned device ids into the file; restoring it unchanged
        // keeps them, so the devices stay the same across later restarts.
        const valid = readFileSync(configPath, "utf8");
        onTestFinished(() => {
            // Restore a valid config so later tests and teardown see a healthy server.
            writeFileSync(configPath, valid);
        });

        writeFileSync(configPath, "this is not valid toml [[[");

        let restartError: ApiError | undefined;

        try {
            await apiClient.restartServer();
        } catch (error) {
            if (!(error instanceof ApiError)) {
                throw error;
            }

            restartError = error;
        }

        // Invalid TOML must be rejected pre-restart so the operator keeps the running process.
        expect(restartError).toMatchObject({
            status: 400,
            message: expect.stringContaining("Invalid config"),
        });

        // Server must still be serving the previous config (agent still listed).
        const agents = await apiClient.listAgents();
        expect(agents.map((agent) => agent.name)).toContain(AGENT_NAME);

        // PID must be unchanged because we never exec'd.
        expect(() => process.kill(serverPid, 0)).not.toThrow();
    });

    it("replaces a managed agent's daemon on restart", async () => {
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
        const previousConnection = agent.connectionId;
        const response = await agent.restart();
        // The control response confirms the restart before the daemon is replaced.
        expect(response.restarting).toBe(true);

        const detailsAfter = await waitForValue({
            timeoutMs: 30000,
            description: "managed agent to reconnect with a new daemon",
            predicate: async () => {
                const restarted = (await apiClient.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected" &&
                        entry.connectionId !== previousConnection,
                );

                if (!restarted) return undefined;
                const details = await restarted.getDetails();

                return details.pid !== detailsBefore.pid ? details : undefined;
            },
        });

        // A managed daemon cannot re-exec itself, so the server replaces it instead.
        expect(detailsAfter.pid).not.toBe(detailsBefore.pid);
    }, 60000);

    it("restarts the server in place and applies a mutated config.toml", async () => {
        // Appended rather than rewritten, so the running device keeps the id the server
        // assigned to it; a device with a new id would be another device.
        writeFileSync(
            configPath,
            `${readFileSync(configPath, "utf8")}
[[agents]]
local = true
name = "${SECOND_AGENT_NAME}"
home = "${secondAgentDir}"
`,
        );

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
        // Both inventory records prove the mutated config was applied via full startup.
        expect(names).toEqual([AGENT_NAME, SECOND_AGENT_NAME].sort());
        // The device that was running before the restart is started again on its own ...
        await apiClient.waitForConnectedAgentNames([AGENT_NAME], 30000);
        // ... while the newly added one stays stopped until someone starts it.
        expect(
            (await apiClient.listAgents()).find(
                (agent) => agent.name === SECOND_AGENT_NAME,
            )?.status,
        ).toBe("stopped");

        // exec keeps the same PID so ProcessManager.kill still works at teardown.
        expect(() => process.kill(serverPid, 0)).not.toThrow();

        // Optional signal that startup ran again after restart.
        const log = readFileSync(serverLogPath, "utf8");
        const loadedMatches = log.match(/Loaded server config/g) ?? [];
        // First startup plus post-restart startup.
        expect(loadedMatches.length).toBeGreaterThanOrEqual(2);
    }, 60000);
});
