import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { Agent, ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "file-diff-test-agent";

describe("File Diff API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let serverPid: number;
    let apiClient: ApiClient;
    let testAgent: Agent;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });
        serverPort = setup.serverPort;
        serverPid = setup.serverPid;
        apiClient = setup.apiClient;
        testAgent = setup.testAgent;
    }, 30000);

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("returns a unified diff for files on the same agent", async () => {
        const leftPath = tempFiles.create("alpha\nbeta\ngamma\n", {
            suffix: "-left.txt",
        });
        const rightPath = tempFiles.create("alpha\nchanged\ngamma\n", {
            suffix: "-right.txt",
        });

        const response = await apiClient.diffFiles(
            { agent: testAgent.id, path: leftPath },
            { agent: testAgent.id, path: rightPath },
        );

        // File paths in the standard header identify the ordered inputs.
        expect(response.unified_diff).toContain(`--- ${leftPath}`);
        expect(response.unified_diff).toContain(`+++ ${rightPath}`);
        // A hunk header proves the response uses unified rather than inline diff syntax.
        expect(response.unified_diff).toContain("@@ -1,3 +1,3 @@");
        // Signed lines preserve the exact replacement needed by patch consumers.
        expect(response.unified_diff).toContain("-beta\n+changed");
    });

    it("returns a unified diff across different agents", async () => {
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }
        const secondAgentName = "file-diff-second-agent";
        const waitForSecondAgent = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${secondAgentName},`,
            ),
            10000,
        );
        const secondAgentPid = processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${serverPort}/ws`,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-second-agent-cwd" }),
        });
        onTestFinished(() => {
            processManager.kill(secondAgentPid);
        });
        await waitForSecondAgent;
        const secondAgent = await waitForValue({
            description: "second diff agent",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) => agent.name === secondAgentName,
                ),
        });
        const leftPath = tempFiles.create("shared\nold\n", {
            suffix: "-cross-left.txt",
        });
        const rightPath = tempFiles.create("shared\nnew\n", {
            suffix: "-cross-right.txt",
        });

        const response = await apiClient.diffFiles(
            { agent: testAgent.id, path: leftPath },
            { agent: secondAgent.id, path: rightPath },
        );

        // Content from both independent websocket streams reaches one server-side comparison.
        expect(response.unified_diff).toContain("-old\n+new");
    });

    it("returns an empty unified diff for identical files", async () => {
        const firstPath = tempFiles.create("same\ncontent\n", {
            suffix: "-same-first.txt",
        });
        const secondPath = tempFiles.create("same\ncontent\n", {
            suffix: "-same-second.txt",
        });

        const response = await apiClient.diffFiles(
            { agent: testAgent.id, path: firstPath },
            { agent: testAgent.id, path: secondPath },
        );

        // No hunks means consumers can treat an empty string as no file changes.
        expect(response.unified_diff).toBe("");
    });

    it("rejects files that fail editable detection", async () => {
        const textPath = tempFiles.create("editable text", { suffix: ".txt" });
        const binaryPath = tempFiles.create(Buffer.from([0xff, 0xfe, 0xfd]), {
            suffix: ".txt",
        });

        const request = apiClient.diffFiles(
            { agent: testAgent.id, path: textPath },
            { agent: testAgent.id, path: binaryPath },
        );

        // Invalid UTF-8 must use the exact same editable gate as file metadata.
        await expect(request).rejects.toThrow(/editable files only/i);
    });

    it("rejects oversized text that fails editable detection", async () => {
        const textPath = tempFiles.create("editable text", { suffix: ".txt" });
        const oversizedPath = tempFiles.create(
            "x".repeat(2 * 1024 * 1024 + 1),
            {
                suffix: ".txt",
            },
        );

        const request = apiClient.diffFiles(
            { agent: testAgent.id, path: textPath },
            { agent: testAgent.id, path: oversizedPath },
        );

        // The editor's 2 MiB memory bound also limits server-side diff inputs.
        await expect(request).rejects.toThrow(/editable files only/i);
    });

    it("rejects relative paths before contacting an agent", async () => {
        const absolutePath = tempFiles.create("editable text", {
            suffix: ".txt",
        });

        const request = apiClient.diffFiles(
            { agent: testAgent.id, path: "relative.txt" },
            { agent: testAgent.id, path: absolutePath },
        );

        // Client-side path validation keeps malformed endpoints out of the REST request.
        await expect(request).rejects.toThrow(/must be absolute/i);
    });
});
