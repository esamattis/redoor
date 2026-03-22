import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import type { TransferProgressEntry } from "@/api-client";
import path from "node:path";
import fs from "node:fs/promises";
import {
    AGENT_PATH,
    SERVER_PATH,
    ProcessManager,
    TempFileManager,
    waitForLogMessage,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "raw-copy-test-agent";

describe("Raw Copy API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let apiClient: ApiClient;
    let serverPid: number;
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
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

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-copy-target-agent-cwd" }),
        });

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

        // Empty directory copies should report zero total bytes.
        expect(completedTransfer.total_bytes).toBe(0);
        // Zero transferred bytes confirm the coordinator handles the empty final-chunk path.
        expect(completedTransfer.transferred_bytes).toBe(0);

        const copiedContent = Buffer.from(
            await testAgent.raw(destPath),
        ).toString("utf-8");

        // Reading the destination back confirms empty-file copies still create the target file.
        expect(copiedContent).toBe("");
    });

    it("should copy a directory on the same agent and preserve nested contents", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-source-dir" });
        const destRoot = tempFiles.tempFile({ suffix: "-dest-dir" });

        await fs.mkdir(path.join(sourceRoot, "nested", "deeper"), {
            recursive: true,
        });
        await fs.mkdir(path.join(sourceRoot, "empty"), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(sourceRoot, "top.txt"),
            "copy directory root file",
            "utf-8",
        );
        await fs.writeFile(
            path.join(sourceRoot, "nested", "deeper", "child.txt"),
            "copy directory nested file",
            "utf-8",
        );

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destRoot },
            sourceRoot,
        );

        const expectedDirectoryBytes =
            Buffer.byteLength("copy directory root file", "utf-8") +
            Buffer.byteLength("copy directory nested file", "utf-8");

        const completedTransfer = await waitForValue({
            description: "completed same-agent directory copy transfer",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // The copy direction check ensures directory copies also stay on the logical copy row.
        expect(completedTransfer.direction).toBe("copy");
        // Source endpoint metadata proves the copy row points at the original directory path.
        expect(completedTransfer.source?.path).toBe(sourceRoot);
        // Destination endpoint metadata proves the copy row points at the destination directory path.
        expect(completedTransfer.dest?.path).toBe(destRoot);
        // Directory copy progress should account for the summed size of all regular files.
        expect(completedTransfer.total_bytes).toBe(expectedDirectoryBytes);
        // Completed directory copies should report all planned bytes as transferred.
        expect(completedTransfer.transferred_bytes).toBe(
            completedTransfer.total_bytes,
        );

        const topFileContent = await fs.readFile(
            path.join(destRoot, "top.txt"),
            "utf-8",
        );
        const nestedFileContent = await fs.readFile(
            path.join(destRoot, "nested", "deeper", "child.txt"),
            "utf-8",
        );
        const emptyDirStat = await fs.stat(path.join(destRoot, "empty"));

        // Reading the copied top-level file confirms the tar stream preserved root entries.
        expect(topFileContent).toBe("copy directory root file");
        // Reading the copied nested file confirms the tar stream preserved nested entries.
        expect(nestedFileContent).toBe("copy directory nested file");
        // The empty directory assertion proves directory-only entries survive the copy.
        expect(emptyDirStat.isDirectory()).toBe(true);
    });

    it("should copy a directory across agents", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-cross-source-dir" });
        const destRoot = tempFiles.tempFile({ suffix: "-cross-dest-dir" });
        const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
        const secondAgentName = "raw-copy-target-agent-dir";

        await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
        await fs.writeFile(
            path.join(sourceRoot, "nested", "file.txt"),
            "cross-agent-directory-copy",
            "utf-8",
        );

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const waitForSecondAgent = waitForLogMessage(
            serverProcess,
            new RegExp(`Agent registered:.*agent_name=${secondAgentName}`),
            10000,
        );

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-copy-target-agent-dir-cwd",
            }),
        });

        await waitForSecondAgent;

        try {
            const secondAgent = await waitForValue({
                description: "second directory copy agent",
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    return agents.find(
                        (agent) => agent.name === secondAgentName,
                    );
                },
            });

            const response = await testAgent.copyTo(
                { agent: secondAgent.id, path: destRoot },
                sourceRoot,
            );

            const completedTransfer = await waitForValue({
                description: "completed cross-agent directory copy transfer",
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "completed",
                    );
                },
            });

            // Recording the destination agent proves cross-agent directory copies keep both endpoints.
            expect(completedTransfer.dest?.agent).toBe(secondAgent.id);

            const copiedContent = await fs.readFile(
                path.join(destRoot, "nested", "file.txt"),
                "utf-8",
            );

            // Comparing destination contents verifies the streamed tar copy stayed lossless across agents.
            expect(copiedContent).toBe("cross-agent-directory-copy");
        } finally {
            processManager.kill(secondAgentPid);
        }
    });

    it("should copy an empty directory", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-empty-source-dir" });
        const destRoot = tempFiles.tempFile({ suffix: "-empty-dest-dir" });

        await fs.mkdir(sourceRoot, { recursive: true });

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destRoot },
            sourceRoot,
        );

        const completedTransfer = await waitForValue({
            description: "completed empty directory copy transfer",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "completed",
                );
            },
        });

        const copiedDirStat = await fs.stat(destRoot);
        const copiedDirEntries = await fs.readdir(destRoot);

        // The logical copy row must complete even when the tar stream contains no file payloads.
        expect(completedTransfer.state).toBe("completed");
        // The destination stat confirms the operation creates the target directory itself.
        expect(copiedDirStat.isDirectory()).toBe(true);
        // An empty entry list proves empty source directories stay empty after copy.
        expect(copiedDirEntries).toHaveLength(0);
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

    it("should reject the same source and destination directory", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-same-dir" });
        await fs.mkdir(sourceRoot, { recursive: true });

        await expect(
            testAgent.copyTo(
                { agent: testAgent.id, path: sourceRoot },
                sourceRoot,
            ),
        ).rejects.toThrow(/different/i);
    });

    it("should reject copying a directory onto an existing destination", async () => {
        const sourceRoot = tempFiles.tempFile({
            suffix: "-existing-dest-source",
        });
        const destRoot = tempFiles.tempFile({
            suffix: "-existing-dest-target",
        });

        await fs.mkdir(sourceRoot, { recursive: true });
        await fs.mkdir(destRoot, { recursive: true });
        await fs.writeFile(
            path.join(sourceRoot, "file.txt"),
            "payload",
            "utf-8",
        );

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destRoot },
            sourceRoot,
        );

        const erroredTransfer = await waitForValue({
            description:
                "errored directory copy transfer with existing destination",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        transfer.state === "errored",
                );
            },
        });

        // Surfacing an errored row proves destination conflicts fail through the logical copy transfer.
        expect(erroredTransfer.state).toBe("errored");
        // Keeping the original destination directory untouched proves directory copies do not merge into existing targets.
        expect(await fs.readdir(destRoot)).toHaveLength(0);
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

        const observedTransfer = await waitForValue({
            description: "large copy transfer progress or completion",
            timeoutMs: 30000,
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === response.copy_request_id &&
                        ((transfer.state === "active" &&
                            transfer.transferred_bytes > BigInt(0)) ||
                            transfer.state === "completed"),
                );
            },
        });

        // Very fast same-agent local copies may complete before the test observes an active row.
        expect(observedTransfer.direction).toBe("copy");

        const completedTransfer =
            observedTransfer.state === "completed"
                ? observedTransfer
                : await waitForValue({
                      description: "completed large copy transfer",
                      timeoutMs: 30000,
                      predicate: async () => {
                          const progress =
                              await apiClient.getTransferProgress();
                          return progress.transfers.find(
                              (transfer: TransferProgressEntry) =>
                                  transfer.request_id ===
                                      response.copy_request_id &&
                                  transfer.state === "completed",
                          );
                      },
                  });

        // The same logical row should represent the copy until completion, even if local copies finish very quickly.
        expect(completedTransfer.request_id).toBe(response.copy_request_id);
    }, 40000);
});
