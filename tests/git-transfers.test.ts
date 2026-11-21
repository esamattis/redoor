import {
    chmod,
    mkdir,
    open,
    readFile,
    lstat,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { $ } from "zx";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import type { Agent, ApiClient } from "#ui/api-client";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import {
    agentRegisteredPattern,
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "git-transfers-test-agent";

describe("Git history downloads and copies", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let serverPid: number;
    let apiClient: ApiClient;
    let testAgent: Agent;
    let repo: string;
    let firstCommit: string;
    /** Larger than one 64 KiB stream frame, so streams span many frames. */
    const largeContent = randomBytes(300 * 1024);
    /** Characters that cannot appear unencoded in a quoted header value. */
    const oddName = 'odd "name"\\\nä.txt';

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

        repo = tempFiles.tempDirectory({ suffix: "-git-transfers" });
        await $({ cwd: repo })`git init -b main`;
        await $({
            cwd: repo,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;

        await mkdir(join(repo, "docs", "nested"), { recursive: true });
        await writeFile(join(repo, "readme.txt"), "first version\n");
        await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
        await writeFile(join(repo, "docs", "nested", "deep.txt"), "deep\n");
        await writeFile(join(repo, "large.bin"), largeContent);
        await writeFile(join(repo, oddName), "odd\n");
        await writeFile(join(repo, "run.sh"), "#!/bin/sh\n");
        await chmod(join(repo, "run.sh"), 0o755);
        await symlink("readme.txt", join(repo, "link"));
        await $({ cwd: repo })`git add .`;
        await $({ cwd: repo })`git commit -m ${"First commit"}`;
        firstCommit = (
            await $({ cwd: repo })`git rev-parse HEAD`
        ).stdout.trim();

        await writeFile(join(repo, "readme.txt"), "second version\n");
        await writeFile(join(repo, "docs", "guide.md"), "# Guide v2\n");
        await $({ cwd: repo })`git commit -am ${"Second commit"}`;
        // Packing makes the history reads go through pack files rather than loose objects.
        await $({ cwd: repo })`git gc -q`;

        // Uncommitted edits must never leak into history downloads or copies.
        await writeFile(join(repo, "readme.txt"), "worktree version\n");
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Requests a history download of `path` at `rev`. */
    async function gitDownload(path: string, rev: string): Promise<Response> {
        const encodedPath = path
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");

        return fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/download${encodedPath}?${new URLSearchParams({ rev }).toString()}`,
            { headers: testAgent.getAuthHeaders() },
        );
    }

    /** Waits until the copy settles and returns its final progress row. */
    async function settledCopy(transferId: number) {
        return waitForValue({
            description: "settled history copy",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();

                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === transferId &&
                        (transfer.state === "completed" ||
                            transfer.state === "errored"),
                );
            },
        });
    }

    it("downloads a file as committed, not as in the worktree", async () => {
        const response = await gitDownload(join(repo, "readme.txt"), "HEAD~1");

        // A committed file streams successfully.
        expect(response.status).toBe(200);
        // History downloads are always attachments named after the file.
        expect(response.headers.get("content-disposition")).toBe(
            "attachment; filename=\"readme.txt\"; filename*=UTF-8''readme.txt",
        );
        // The body is the first commit's content, not HEAD's or the worktree's.
        expect(await response.text()).toBe("first version\n");

        const large = await gitDownload(join(repo, "large.bin"), firstCommit);

        // The length is known from the object header before streaming starts.
        expect(large.headers.get("content-length")).toBe(
            String(largeContent.length),
        );
        // A multi-frame blob read from a pack arrives byte for byte.
        expect(
            Buffer.from(await large.arrayBuffer()).equals(largeContent),
        ).toBe(true);
    });

    it("names downloads of files whose names cannot be quoted in a header", async () => {
        const response = await gitDownload(join(repo, oddName), firstCommit);

        // A name with quotes, a backslash, a newline and non-ASCII still downloads.
        expect(response.status).toBe(200);
        // The exact name is percent-encoded, with an ASCII stand-in for old clients.
        expect(response.headers.get("content-disposition")).toBe(
            `attachment; filename="odd _name____.txt"; filename*=UTF-8''${encodeURIComponent(oddName)}`,
        );
        // The body is the committed content.
        expect(await response.text()).toBe("odd\n");
    });

    it("reports unsupported delta sizes as a client error", async () => {
        const deltaRepo = tempFiles.tempDirectory({ suffix: "-large-history-delta" });
        const filePath = join(deltaRepo, "large.bin");
        const file = await open(filePath, "w");

        // Sparse fixture creation avoids buffering the large committed file in the test.
        onTestFinished(() => file.close());
        await file.truncate(65 * 1024 * 1024);
        await $({ cwd: deltaRepo })`git init -b main`;
        await $({ cwd: deltaRepo })`git config core.bigFileThreshold 128m`;
        await $({ cwd: deltaRepo })`git add .`;
        await $({ cwd: deltaRepo })`git -c user.email=t@t -c user.name=t commit -m first`;
        await writeFile(filePath, "changed", { flag: "a" });
        await $({ cwd: deltaRepo })`git -c user.email=t@t -c user.name=t commit -am second`;
        await $({ cwd: deltaRepo })`git gc -q --aggressive`;

        const statuses: number[] = [];

        for (const rev of ["HEAD", "HEAD~1"]) {
            const response = await gitDownload(filePath, rev);
            statuses.push(response.status);

            if (response.status === 400) {
                // An unsupported size keeps its explanation through the full HTTP pipeline.
                expect((await response.json()).error).toContain("stored as a Git delta");
            } else {
                // The undeltified base is streamable; cancel without buffering its body.
                await response.body?.cancel();
            }
        }

        // Git stores one version as a base and the other as an oversized delta.
        expect(statuses.sort((left, right) => left - right)).toEqual([200, 400]);
    }, 30_000);

    it("downloads a directory as a gzipped tar rooted at the directory", async () => {
        const response = await gitDownload(join(repo, "docs"), firstCommit);

        // Directories stream like worktree directory downloads.
        expect(response.status).toBe(200);
        // The archive is named after the directory.
        expect(response.headers.get("content-disposition")).toBe(
            "attachment; filename=\"docs.tar.gz\"; filename*=UTF-8''docs.tar.gz",
        );

        const archive = join(
            tempFiles.tempDirectory({ suffix: "-history-archive" }),
            "docs.tar.gz",
        );

        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
        const extracted = tempFiles.tempDirectory({ suffix: "-extracted" });
        await $`tar -xzf ${archive} -C ${extracted}`;

        // The committed version of each file is in the archive under the directory's name.
        expect(
            await readFile(join(extracted, "docs", "guide.md"), "utf8"),
        ).toBe("# Guide\n");
        // Nested directories are archived recursively.
        expect(
            await readFile(
                join(extracted, "docs", "nested", "deep.txt"),
                "utf8",
            ),
        ).toBe("deep\n");
    });

    it("refuses symlinks and reports missing paths", async () => {
        const link = await gitDownload(join(repo, "link"), firstCommit);

        // A symlink has no content a download or copy could write.
        expect(link.status).toBe(400);

        const missing = await gitDownload(join(repo, "nope.txt"), firstCommit);

        // A path the revision does not contain is not found, like a missing worktree path.
        expect(missing.status).toBe(404);

        const unknown = await gitDownload(
            join(repo, "readme.txt"),
            "no-such-ref",
        );

        // An unknown revision is a client error.
        expect(unknown.status).toBe(400);
    });

    it("restores a committed file over its working copy", async () => {
        const target = join(repo, "readme.txt");

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: target },
            target,
            { on_existing: "override", sourceRev: firstCommit },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // Copying a revision onto its own working path is how a file is restored.
        expect(transfer.state).toBe("completed");
        // The progress total is the committed file's size.
        expect(transfer.total_bytes).toBe("first version\n".length);
        // The working file now holds the committed content.
        expect(await readFile(target, "utf8")).toBe("first version\n");
    });

    it("restores a deleted executable file as executable", async () => {
        const destination = join(
            tempFiles.tempDirectory({ suffix: "-history-executable" }),
            "run.sh",
        );

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destination },
            join(repo, "run.sh"),
            { sourceRev: firstCommit },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // A committed executable copies to a new path like any file.
        expect(transfer.state).toBe("completed");
        // Git's 100755 mode survives, so the restored script can still run.
        expect((await stat(destination)).mode & 0o111).not.toBe(0);
    });

    it("refuses to restore a revision onto its working path without override", async () => {
        const target = join(repo, "docs", "guide.md");

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: target },
            target,
            { sourceRev: firstCommit },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // The default conflict policy still protects an existing destination.
        expect(transfer.state).toBe("errored");
        // The working file is untouched.
        expect(await readFile(target, "utf8")).toBe("# Guide v2\n");
    });

    it("copies a committed directory on the same device", async () => {
        const destination = join(
            tempFiles.tempDirectory({ suffix: "-history-copy" }),
            "docs-v1",
        );

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destination },
            join(repo, "docs"),
            { sourceRev: firstCommit },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // A same-device history copy streams through the server and completes.
        expect(transfer.state).toBe("completed");
        // The destination is the directory itself, with no extra root level inside.
        expect(await readFile(join(destination, "guide.md"), "utf8")).toBe(
            "# Guide\n",
        );
        // Nested content is copied too.
        expect(
            await readFile(join(destination, "nested", "deep.txt"), "utf8"),
        ).toBe("deep\n");
    });

    it("refuses to replace a directory that contains the repository", async () => {
        await expect(
            testAgent.copyTo({ agent: testAgent.id, path: repo }, repo, {
                on_existing: "override",
                sourceRev: firstCommit,
            }),
            // A committed tree has no .git, so replacing the root would delete the repository.
        ).rejects.toThrow(/\.git directory/);

        const alias = join(
            tempFiles.tempDirectory({ suffix: "-repository-alias" }),
            "alias",
        );

        await symlink(dirname(repo), alias);

        await expect(
            testAgent.copyTo(
                { agent: testAgent.id, path: join(alias, basename(repo)) },
                repo,
                { on_existing: "override", sourceRev: firstCommit },
            ),
            // A symlinked parent names the same repository, which a lexical check would miss.
        ).rejects.toThrow(/\.git directory/);
    });

    it("replaces a final symlink without touching its repository target", async () => {
        const destination = join(
            tempFiles.tempDirectory({ suffix: "-history-symlink" }),
            "repository-link",
        );

        await symlink(repo, destination);

        const response = await testAgent.copyTo(
            { agent: testAgent.id, path: destination },
            join(repo, "docs"),
            { on_existing: "override", sourceRev: firstCommit },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // Override replaces the link entry, so a safe destination must pass the guard.
        expect(transfer.state).toBe("completed");
        // The link is now an independent copy of the committed directory.
        expect((await lstat(destination)).isDirectory()).toBe(true);
        expect(await readFile(join(destination, "guide.md"), "utf8")).toBe(`# Guide
`);
        // The repository the link used to name retains its metadata.
        expect((await stat(join(repo, ".git"))).isDirectory()).toBe(true);
    });

    it("copies a committed file to another device", async () => {
        const secondAgentName = "git-transfers-target-agent";
        const serverProcess = processManager.getProcess(serverPid);

        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const waitForSecondAgent = waitForLogMessage(
            serverProcess,
            agentRegisteredPattern(secondAgentName),
            10_000,
        );

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${serverPort}`,
            name: secondAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-target-agent-cwd" }),
        });

        onTestFinished(() => {
            processManager.kill(secondAgentPid);
        });

        await waitForSecondAgent;

        const secondAgent = await waitForValue({
            description: "second history copy agent",
            predicate: async () => {
                const agents = await apiClient.listAgents();

                return agents.find((agent) => agent.name === secondAgentName);
            },
        });

        const destination = join(
            tempFiles.tempDirectory({ suffix: "-cross-device" }),
            "large.bin",
        );

        const response = await testAgent.copyTo(
            { agent: secondAgent.id, path: destination },
            join(repo, "large.bin"),
            { sourceRev: "main" },
        );

        const transfer = await settledCopy(response.copy_request_id);

        // A branch name resolves to its commit and the copy completes across devices.
        expect(transfer.state).toBe("completed");
        // The copy row keeps both endpoints for the transfers view.
        expect(transfer.dest?.agent).toBe(secondAgent.id);
        // The multi-frame committed file arrives intact on the other device.
        expect(
            Buffer.from(await secondAgent.raw(destination)).equals(
                largeContent,
            ),
        ).toBe(true);
    });
});
