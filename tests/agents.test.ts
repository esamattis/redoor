import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ApiClient, Agent, isLsDirectoryResponse } from "@/api-client";
import path from "node:path";
import {
    ProcessManager,
    startServerAndAgent,
    waitForLogMessage,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "test-agent";

const processManager = new ProcessManager();

let serverPid: number;
let apiClient: ApiClient;
let wsUrl: string;

beforeAll(async () => {
    const projectRoot = path.join(__dirname, "..");

    const started = await startServerAndAgent({
        processManager,
        serverPath: SERVER_PATH,
        agentPath: AGENT_PATH,
        agentName: AGENT_NAME,
        projectRoot,
    });

    serverPid = started.serverPid;
    apiClient = started.apiClient;
    wsUrl = started.wsUrl;
}, 30000);

afterAll(() => {
    processManager.killAll();
});

describe("Agents API", () => {
    it("should get agent details", async () => {
        const agents = await apiClient.listAgents();
        // Verify at least one agent is connected
        expect(agents.length).toBeGreaterThan(0);

        const testAgent = agents.find((a) => a.name === AGENT_NAME);
        // Verify the test agent is present
        expect(testAgent).toBeDefined();

        const result = await testAgent!.getDetails();
        // Verify agent ID matches
        expect(result.id).toBe(testAgent!.id);
        // Verify agent name matches
        expect(result.name).toBe(AGENT_NAME);
        // Verify PID is positive
        expect(result.pid).toBeGreaterThan(0);
        // Verify CWD is a non-empty string
        expect(result.cwd).toBeDefined();
        expect(result.cwd.length).toBeGreaterThan(0);
        // Verify OS, arch, hostname are non-empty strings
        expect(result.os).toBeDefined();
        expect(result.os.length).toBeGreaterThan(0);
        expect(result.arch).toBeDefined();
        expect(result.arch.length).toBeGreaterThan(0);
        expect(result.hostname).toBeDefined();
        expect(result.hostname.length).toBeGreaterThan(0);
        // Verify load averages are numbers
        expect(result.load_average_one).toBeDefined();
        expect(typeof result.load_average_one).toBe("number");
        expect(result.load_average_five).toBeDefined();
        expect(typeof result.load_average_five).toBe("number");
        expect(result.load_average_fifteen).toBeDefined();
        expect(typeof result.load_average_fifteen).toBe("number");
        // Verify system uptime is a positive number
        expect(result.system_uptime).toBeDefined();
        expect(typeof result.system_uptime).toBe("number");
        expect(result.system_uptime).toBeGreaterThan(0);
        // Verify connected_at is a positive number
        expect(result.connected_at).toBeDefined();
        expect(typeof result.connected_at).toBe("number");
        expect(result.connected_at).toBeGreaterThan(0);
    });

    it("should list directory contents on connected agent", async () => {
        const agents = await apiClient.listAgents();
        // Verify at least one agent is connected
        expect(agents.length).toBeGreaterThan(0);

        const testAgent = agents.find((a) => a.name === AGENT_NAME);
        // Verify test agent is present
        expect(testAgent).toBeDefined();

        const result = await testAgent!.ls("ui/src");
        // Verify result is a directory response
        expect(isLsDirectoryResponse(result)).toBe(true);
        // Verify result contains an array of files
        if (isLsDirectoryResponse(result)) {
            expect(result.files).toBeInstanceOf(Array);
            // Verify directory listing returns files
            expect(result.files.length).toBeGreaterThan(0);
            // Verify file entries contain metadata
            const firstFile = result.files[0]!;
            expect(firstFile.name).toBeDefined();
            expect(typeof firstFile.name).toBe("string");
            expect(firstFile.type).toBeDefined();
            expect(typeof firstFile.type).toBe("string");
            expect(firstFile.type).toMatch(/^(file|directory)$/);
            expect(firstFile.size).toBeDefined();
            expect(typeof firstFile.size).toBe("number");
            expect(firstFile.size).toBeGreaterThanOrEqual(0);
            expect(firstFile.uid).toBeDefined();
            expect(typeof firstFile.uid).toBe("number");
            expect(firstFile.uid).toBeGreaterThan(0);
            expect(firstFile.gid).toBeDefined();
            expect(typeof firstFile.gid).toBe("number");
            expect(firstFile.gid).toBeGreaterThan(0);
            expect(firstFile.owner).toBeDefined();
            expect(
                firstFile.owner === null || typeof firstFile.owner === "string",
            );
            expect(firstFile.group).toBeDefined();
            expect(
                firstFile.group === null || typeof firstFile.group === "string",
            );
        }
    });

    it("should reject duplicate agent names", async () => {
        const DUPLICATE_AGENT_NAME = "duplicate-test-agent";

        const projectRoot = path.join(__dirname, "../..");

        const firstAgentPid = processManager.spawn(
            AGENT_PATH,
            [wsUrl, "--name", DUPLICATE_AGENT_NAME],
            projectRoot,
        );
        const firstAgent = processManager.getProcess(firstAgentPid);
        // Verify first agent was spawned successfully
        expect(firstAgent).toBeDefined();

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        await waitForLogMessage(
            serverProcess,
            /Agent registered: agent_id=duplicate-test-agent/,
        );

        const agentsAfterFirst = await apiClient.listAgents();
        // Verify first agent was registered on server
        expect(
            agentsAfterFirst.some((a) => a.name === DUPLICATE_AGENT_NAME),
        ).toBe(true);

        const secondAgentPid = processManager.spawn(
            AGENT_PATH,
            [wsUrl, "--name", DUPLICATE_AGENT_NAME],
            projectRoot,
        );
        const secondAgent = processManager.getProcess(secondAgentPid);
        // Verify second agent was spawned successfully
        expect(secondAgent).toBeDefined();

        const exitCode = await processManager.waitForExit(secondAgentPid);
        // Verify second agent exited with non-zero code (error)
        expect(exitCode).not.toBe(0);

        await apiClient.waitForAgentNames([AGENT_NAME]);

        const agentsAfterSecond = await apiClient.listAgents();
        // Verify original test agent is still connected
        expect(agentsAfterSecond.some((a) => a.name === AGENT_NAME)).toBe(true);
    });

    it("should echo message back from connected agent", async () => {
        const agents = await apiClient.listAgents();
        // Verify at least one agent is connected
        expect(agents.length).toBeGreaterThan(0);

        const testAgent = agents.find((a) => a.name === AGENT_NAME);
        // Verify the test agent is present
        expect(testAgent).toBeDefined();

        const testMessage = "Hello, World!";
        const result = await testAgent!.echo(testMessage);
        // Verify message is echoed back correctly
        expect(result.message).toBe(testMessage);
    });

    it("should handle concurrent echo requests with random sleep", async () => {
        const agents = await apiClient.listAgents();
        // Verify at least one agent is connected
        expect(agents.length).toBeGreaterThan(0);

        const testAgent = agents.find((a) => a.name === AGENT_NAME);
        // Verify the test agent is present
        expect(testAgent).toBeDefined();

        const CONCURRENT_REQUESTS = 20;
        const uniqueMessages = Array.from(
            { length: CONCURRENT_REQUESTS },
            (_, i) => `concurrent-test-${i}`,
        );

        const promises = uniqueMessages.map((message) =>
            testAgent!.echo(message, true),
        );

        const results = await Promise.all(promises);

        expect(results.length).toBe(CONCURRENT_REQUESTS);

        for (let i = 0; i < results.length; i++) {
            expect(results[i]!.message).toBe(uniqueMessages[i]!);
        }
    });

    it("should return 404 for non-existent agent details", async () => {
        const nonExistentAgentId = "non-existent-agent-id";
        const agent = new Agent(apiClient.baseUrl, {
            id: nonExistentAgentId,
            name: "non-existent",
        });
        // Verify that requesting details for non-existent agent throws an error
        await expect(agent.getDetails()).rejects.toThrow("Agent not found");
    });
});
