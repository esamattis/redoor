import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import type { TransferProgressEntry } from "@/api-client";
import path from "node:path";
import {
    ProcessManager,
    TempFileManager,
    waitForLogMessage,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "raw-copy-test-agent";

describe("Raw Copy API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let apiClient: ApiClient;
    let serverPid: number;
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.cleanup();
    });

    beforeAll(async () => {
        const projectRoot = path.join(__dirname, "..");

        const setup = await startServerAndAgent({
            processManager,
            serverPath: SERVER_PATH,
            agentPath: AGENT_PATH,
            agentName: AGENT_NAME,
            projectRoot,
        });

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(() => {
        processManager.killAll();
    });

    it("should copy a file on the same agent and expose a single copy row", async () => {
        const sourceContent = "copy me across the same agent";
        const sourcePath = tempFiles.create(sourceContent, { suffix: ".txt" });
        const destPath = tempFiles.tempFile({ suffix: ".txt" });

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destPath },
            sourcePath,
        );

        // Returning a public request id immediately gives callers a stable progress handle.
        expect(response.copy_request_id).toBeTypeOf("number");

        const completedTransfer = await waitForValue({
            description: "completed copy transfer",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // The copy direction check ensures copy jobs stay distinct from upload/download rows.
        expect(completedTransfer.direction).toBe("copy");
        // Source endpoint metadata proves the UI can render the origin side of the copy.
        expect(completedTransfer.source?.path).toBe(sourcePath);
        // Destination endpoint metadata proves the UI can render the target side of the copy.
        expect(completedTransfer.dest?.path).toBe(destPath);
        // Matching byte counts confirm the logical row tracks the full copied payload.
        expect(completedTransfer.transferred_bytes).toBe(
            completedTransfer.total_bytes,
        );

        const copyRelatedRows = (
            await apiClient.getTransferProgress()
        ).transfers.filter(
            (transfer: TransferProgressEntry) =>
                transfer.request_id === response.copy_request_id ||
                transfer.source?.path === sourcePath ||
                transfer.dest?.path === destPath,
        );

        // Only one visible progress row confirms internal upload/download legs stay hidden.
        expect(copyRelatedRows).toHaveLength(1);

        const copiedContent = Buffer.from(
            await testAgent.raw(destPath),
        ).toString("utf-8");

        // Reading the destination file back verifies the copy preserved the original bytes.
        expect(copiedContent).toBe(sourceContent);
    });

    it("should copy a file across agents", async () => {
        const sourceContent = "cross-agent-copy".repeat(4096);
        const sourcePath = tempFiles.create(sourceContent, { suffix: ".txt" });
        const destPath = tempFiles.tempFile({ suffix: ".txt" });
        const projectRoot = path.join(__dirname, "..");
        const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
        const secondAgentName = "raw-copy-target-agent";

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const waitForSecondAgent = waitForLogMessage(
            serverProcess,
            new RegExp(`Agent registered:.*agent_name=${secondAgentName}`),
            10000,
        );

        const secondAgentPid = processManager.spawn(
            AGENT_PATH,
            [wsUrl, secondAgentName],
            projectRoot,
        );

        await waitForSecondAgent;

        try {
            const secondAgent = await waitForValue({
                description: "second copy agent",
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    return agents.find(
                        (agent) => agent.name === secondAgentName,
                    );
                },
            });

            const response = await testAgent.copyTo(
                { agent: secondAgent.id, path: destPath },
                sourcePath,
            );

            const completedTransfer = await waitForValue({
                description: "completed cross-agent copy transfer",
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "completed",
                    );
                },
            });

            // Recording the destination agent proves the logical copy row keeps both endpoints.
            expect(completedTransfer.dest?.agent).toBe(secondAgent.id);

            const copiedContent = Buffer.from(
                await secondAgent.raw(destPath),
            ).toString("utf-8");

            // Comparing destination contents verifies the streamed cross-agent copy stayed lossless.
            expect(copiedContent).toBe(sourceContent);
        } finally {
            processManager.kill(secondAgentPid);
        }
    });

    it("should copy an empty file", async () => {
        const sourcePath = tempFiles.create("", { suffix: ".txt" });
        const destPath = tempFiles.tempFile({ suffix: ".txt" });

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destPath },
            sourcePath,
        );

        const completedTransfer = await waitForValue({
            description: "completed empty copy transfer",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // Zero transferred bytes confirm the coordinator handles the empty final-chunk path.
        expect(completedTransfer.transferred_bytes).toBe(0);

        const copiedContent = Buffer.from(
            await testAgent.raw(destPath),
        ).toString("utf-8");

        // Reading the destination back confirms empty-file copies still create the target file.
        expect(copiedContent).toBe("");
    });

    it("should reject missing source files", async () => {
        await expect(
            testAgent.copyTo(
                {
                    agent: testAgent.id,
                    path: tempFiles.tempFile({ suffix: ".txt" }),
                },
                "/tmp/redoor-missing-copy-source.txt",
            ),
        ).rejects.toThrow(/not found|no such file/i);
    });

    it("should reject the same source and destination", async () => {
        const sourcePath = tempFiles.create("same-source-and-dest", {
            suffix: ".txt",
        });

        await expect(
            testAgent.copyTo(
                { agent: testAgent.id, path: sourcePath },
                sourcePath,
            ),
        ).rejects.toThrow(/different/i);
    });

    it("should return quickly while a large copy is still in progress", async () => {
        const sourceContent = "0123456789abcdef".repeat(4 * 1024 * 1024);
        const sourcePath = tempFiles.create(sourceContent, { suffix: ".bin" });
        const destPath = tempFiles.tempFile({ suffix: ".bin" });
        const startedAt = Date.now();

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destPath },
            sourcePath,
        );
        const elapsedMs = Date.now() - startedAt;

        // A fast response shows the API only starts background work instead of waiting for copy completion.
        expect(elapsedMs).toBeLessThan(1000);

        const activeTransfer = await waitForValue({
            description: "active large copy transfer",
            timeoutMs: 30000,
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > BigInt(0),
                );
            },
        });

        // Observing an active row after the HTTP response proves the copy continues in the background.
        expect(activeTransfer.direction).toBe("copy");

        const completedTransfer = await waitForValue({
            description: "completed large copy transfer",
            timeoutMs: 30000,
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // Completion after the active observation confirms the same logical row spans the whole lifecycle.
        expect(completedTransfer.request_id).toBe(response.copy_request_id);
    }, 40000);
});
