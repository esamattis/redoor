import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    afterEach,
    onTestFinished,
} from "vitest";
import { ApiClient, Agent } from "#ui/api-client";
import type { TransferProgressEntry } from "#ui/api-client";
import path from "node:path";
import fs from "node:fs/promises";
import {
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
            new RegExp(`Transfer socket registered: agent_id=${secondAgentName},`),
            10000,
        );

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-copy-target-agent-cwd" }),
        });

        onTestFinished(() => {
            processManager.kill(secondAgentPid);
        });

        await waitForSecondAgent;

        const secondAgent = await waitForValue({
            description: "second copy agent",
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((agent) => agent.name === secondAgentName);
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
            new RegExp(`Transfer socket registered: agent_id=${secondAgentName},`),
            10000,
        );

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-copy-target-agent-dir-cwd",
            }),
        });

        onTestFinished(() => {
            processManager.kill(secondAgentPid);
        });

        await waitForSecondAgent;

        const secondAgent = await waitForValue({
            description: "second directory copy agent",
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((agent) => agent.name === secondAgentName);
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

    it("should reject copying a directory onto an existing destination by default", async () => {
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
        // Keeping the original destination directory untouched proves default error mode does not mutate existing targets.
        expect(await fs.readdir(destRoot)).toHaveLength(0);
    });

    describe.each([
        { scope: "same-agent" as const },
        { scope: "cross-agent" as const },
    ])("on_existing directory copy ($scope)", ({ scope }) => {
        let destAgentId: string;
        let secondAgentPid: number | undefined;

        beforeAll(async () => {
            if (scope === "same-agent") {
                destAgentId = testAgent.id;
                return;
            }

            const secondAgentName = "raw-copy-on-existing-target-agent";
            const serverProcess = processManager.getProcess(serverPid);
            if (!serverProcess) {
                throw new Error("Server process not found");
            }

            const waitForSecondAgent = waitForLogMessage(
                serverProcess,
                new RegExp(
                    `Transfer socket registered: agent_id=${secondAgentName},`,
                ),
                10000,
            );

            secondAgentPid = processManager.spawnAgent({
                wsAddress: `ws://127.0.0.1:${serverPort}/ws`,
                name: secondAgentName,
                cwd: tempFiles.tempDirectory({
                    suffix: "-on-existing-target-agent-cwd",
                }),
            });

            await waitForSecondAgent;

            const secondAgent = await waitForValue({
                description: "on_existing cross-agent destination agent",
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    return agents.find((agent) => agent.name === secondAgentName);
                },
            });
            destAgentId = secondAgent.id;
        }, 30000);

        afterAll(() => {
            if (secondAgentPid !== undefined) {
                processManager.kill(secondAgentPid);
            }
        });

        it("should error when on_existing is error and destination exists", async () => {
            const sourceRoot = tempFiles.tempFile({
                suffix: `-on-existing-error-source-${scope}`,
            });
            const destRoot = tempFiles.tempFile({
                suffix: `-on-existing-error-dest-${scope}`,
            });

            await fs.mkdir(sourceRoot, { recursive: true });
            await fs.mkdir(destRoot, { recursive: true });
            await fs.writeFile(
                path.join(sourceRoot, "from-source.txt"),
                "source-payload",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "keep-me.txt"),
                "dest-only",
                "utf-8",
            );

            const response = await testAgent.copyTo(
                { agent: destAgentId, path: destRoot },
                sourceRoot,
                { on_existing: "error" },
            );

            const erroredTransfer = await waitForValue({
                description: `${scope} errored copy with on_existing=error`,
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "errored",
                    );
                },
            });

            // Explicit error mode must fail the logical transfer instead of mutating the destination.
            expect(erroredTransfer.state).toBe("errored");
            // Destination agent identity proves the rejection path matches the scoped copy target.
            expect(erroredTransfer.dest?.agent).toBe(destAgentId);
            // Preserving dest-only content proves error mode leaves the existing tree untouched.
            expect(
                await fs.readFile(path.join(destRoot, "keep-me.txt"), "utf-8"),
            ).toBe("dest-only");
            // Source content must not appear under the destination when the copy is rejected.
            await expect(
                fs.stat(path.join(destRoot, "from-source.txt")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("should replace an existing destination when on_existing is override", async () => {
            const sourceRoot = tempFiles.tempFile({
                suffix: `-on-existing-override-source-${scope}`,
            });
            const destRoot = tempFiles.tempFile({
                suffix: `-on-existing-override-dest-${scope}`,
            });

            await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
            await fs.mkdir(destRoot, { recursive: true });
            await fs.writeFile(
                path.join(sourceRoot, "nested", "file.txt"),
                "source-version",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "old-only.txt"),
                "should-be-removed",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "nested-placeholder.txt"),
                "also-removed",
                "utf-8",
            );

            const response = await testAgent.copyTo(
                { agent: destAgentId, path: destRoot },
                sourceRoot,
                { on_existing: "override" },
            );

            const completedTransfer = await waitForValue({
                description: `${scope} completed override directory copy`,
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "completed",
                    );
                },
            });

            // Destination agent identity proves override ran on the scoped copy path (local or tar stream).
            expect(completedTransfer.dest?.agent).toBe(destAgentId);
            // Override must publish the source tree contents at the destination path.
            expect(
                await fs.readFile(
                    path.join(destRoot, "nested", "file.txt"),
                    "utf-8",
                ),
            ).toBe("source-version");
            // Dest-only files must disappear because override replaces the whole path.
            await expect(
                fs.stat(path.join(destRoot, "old-only.txt")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            await expect(
                fs.stat(path.join(destRoot, "nested-placeholder.txt")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("should merge into an existing destination when on_existing is merge", async () => {
            const sourceRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-source-${scope}`,
            });
            const destRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-dest-${scope}`,
            });

            await fs.mkdir(path.join(sourceRoot, "shared"), { recursive: true });
            await fs.mkdir(path.join(destRoot, "shared"), { recursive: true });
            await fs.writeFile(
                path.join(sourceRoot, "shared", "conflict.txt"),
                "from-source",
                "utf-8",
            );
            await fs.writeFile(
                path.join(sourceRoot, "source-only.txt"),
                "source-only",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "shared", "conflict.txt"),
                "from-dest",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "dest-only.txt"),
                "dest-only",
                "utf-8",
            );

            const response = await testAgent.copyTo(
                { agent: destAgentId, path: destRoot },
                sourceRoot,
                { on_existing: "merge" },
            );

            const completedTransfer = await waitForValue({
                description: `${scope} completed merge directory copy`,
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "completed",
                    );
                },
            });

            // Destination agent identity proves merge ran on the scoped copy path (local or tar stream).
            expect(completedTransfer.dest?.agent).toBe(destAgentId);
            // Conflicting files must take the source contents during merge.
            expect(
                await fs.readFile(
                    path.join(destRoot, "shared", "conflict.txt"),
                    "utf-8",
                ),
            ).toBe("from-source");
            // Source-only files must be added beside existing destination entries.
            expect(
                await fs.readFile(path.join(destRoot, "source-only.txt"), "utf-8"),
            ).toBe("source-only");
            // Dest-only files must survive merge because only overlapping paths are replaced.
            expect(
                await fs.readFile(path.join(destRoot, "dest-only.txt"), "utf-8"),
            ).toBe("dest-only");
        });

        it("should reject merge when the destination root is a symlink", async () => {
            const sourceRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-symlink-root-source-${scope}`,
            });
            const externalRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-symlink-root-external-${scope}`,
            });
            const destRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-symlink-root-dest-${scope}`,
            });

            await fs.mkdir(sourceRoot, { recursive: true });
            await fs.mkdir(externalRoot, { recursive: true });
            await fs.writeFile(
                path.join(sourceRoot, "from-source.txt"),
                "source-payload",
                "utf-8",
            );
            await fs.writeFile(
                path.join(externalRoot, "secret.txt"),
                "external-secret",
                "utf-8",
            );
            await fs.symlink(externalRoot, destRoot);

            const response = await testAgent.copyTo(
                { agent: destAgentId, path: destRoot },
                sourceRoot,
                { on_existing: "merge" },
            );

            const erroredTransfer = await waitForValue({
                description: `${scope} errored merge onto destination root symlink`,
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "errored",
                    );
                },
            });

            // Destination agent identity proves the rejection ran on the scoped copy path.
            expect(erroredTransfer.dest?.agent).toBe(destAgentId);
            // External content must stay untouched so merge never follows the destination root link.
            expect(
                await fs.readFile(path.join(externalRoot, "secret.txt"), "utf-8"),
            ).toBe("external-secret");
            // Source files must not appear outside the requested destination via the symlink target.
            await expect(
                fs.stat(path.join(externalRoot, "from-source.txt")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("should replace nested destination symlinks during merge instead of following them", async () => {
            const sourceRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-nested-symlink-source-${scope}`,
            });
            const externalRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-nested-symlink-external-${scope}`,
            });
            const destRoot = tempFiles.tempFile({
                suffix: `-on-existing-merge-nested-symlink-dest-${scope}`,
            });

            await fs.mkdir(path.join(sourceRoot, "linked"), { recursive: true });
            await fs.mkdir(destRoot, { recursive: true });
            await fs.mkdir(externalRoot, { recursive: true });
            await fs.writeFile(
                path.join(sourceRoot, "linked", "file.txt"),
                "from-source",
                "utf-8",
            );
            await fs.writeFile(
                path.join(externalRoot, "secret.txt"),
                "external-secret",
                "utf-8",
            );
            await fs.writeFile(
                path.join(destRoot, "dest-only.txt"),
                "dest-only",
                "utf-8",
            );
            await fs.symlink(externalRoot, path.join(destRoot, "linked"));

            const response = await testAgent.copyTo(
                { agent: destAgentId, path: destRoot },
                sourceRoot,
                { on_existing: "merge" },
            );

            const completedTransfer = await waitForValue({
                description: `${scope} completed merge that replaces nested symlinks`,
                predicate: async () => {
                    const progress = await apiClient.getTransferProgress();
                    return progress.transfers.find(
                        (transfer: TransferProgressEntry) =>
                            transfer.request_id === response.copy_request_id &&
                            transfer.state === "completed",
                    );
                },
            });

            // Destination agent identity proves nested-symlink merge ran on the scoped copy path.
            expect(completedTransfer.dest?.agent).toBe(destAgentId);
            // Nested symlink targets must become real directories under the destination root.
            const linkedStat = await fs.lstat(path.join(destRoot, "linked"));
            expect(linkedStat.isDirectory()).toBe(true);
            expect(linkedStat.isSymbolicLink()).toBe(false);
            // Source content must land inside the destination tree, not the old link target.
            expect(
                await fs.readFile(
                    path.join(destRoot, "linked", "file.txt"),
                    "utf-8",
                ),
            ).toBe("from-source");
            // Dest-only files must survive merge beside the replaced symlink path.
            expect(
                await fs.readFile(path.join(destRoot, "dest-only.txt"), "utf-8"),
            ).toBe("dest-only");
            // The previous symlink target must remain untouched outside the destination tree.
            expect(
                await fs.readFile(path.join(externalRoot, "secret.txt"), "utf-8"),
            ).toBe("external-secret");
            await expect(
                fs.stat(path.join(externalRoot, "file.txt")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        });
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
