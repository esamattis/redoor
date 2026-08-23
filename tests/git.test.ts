import { access, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "zx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "#ui/api-client";
import type { ErrorResponse } from "#bindings/ErrorResponse";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitDiffResponse } from "#bindings/GitDiffResponse";
import type { GitStatusResponse } from "#bindings/GitStatusResponse";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "git-rest-test-agent";

describe("Git browser REST API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let testAgent: Agent;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });
        serverPort = setup.serverPort;
        testAgent = setup.testAgent;
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Calls a Git endpoint directly so backend coverage does not add UI API-client surface. */
    async function gitRequest<ResponseBody>(
        domain: "context" | "status" | "diff",
        path: string,
        query = "",
    ): Promise<ResponseBody> {
        const encodedPath = path
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");
        const response = await fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/${domain}${encodedPath}${query}`,
            { headers: testAgent.getAuthHeaders() },
        );
        const body: ResponseBody & Partial<ErrorResponse> =
            await response.json();
        if (!response.ok) {
            throw new Error(`${response.status}: ${String(body.error)}`);
        }
        return body;
    }

    /** Fetches typed context while keeping production API-client changes out of backend scope. */
    async function gitContext(path: string): Promise<GitContextResponse> {
        return gitRequest<GitContextResponse>("context", path);
    }

    /** Fetches typed status while keeping production API-client changes out of backend scope. */
    async function gitStatus(path: string): Promise<GitStatusResponse> {
        return gitRequest<GitStatusResponse>("status", path);
    }

    /** Fetches a typed diff while keeping production API-client changes out of backend scope. */
    async function gitDiff(path: string, query = ""): Promise<GitDiffResponse> {
        return gitRequest<GitDiffResponse>("diff", path, query);
    }

    /** Initializes deterministic local identity without relying on the host Git configuration. */
    async function initRepository(repo: string): Promise<void> {
        await $({ cwd: repo })`git init`;
        await $({
            cwd: repo,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;
    }

    it("discovers and classifies tracked, untracked, ignored, and deleted paths", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-context" });
        await initRepository(repo);
        const tracked = join(repo, "tracked.txt");
        const untracked = join(repo, "untracked.txt");
        const ignored = join(repo, "ignored.log");
        await writeFile(tracked, "tracked\n");
        await writeFile(untracked, "untracked\n");
        await writeFile(ignored, "ignored\n");
        await writeFile(join(repo, ".gitignore"), "*.log\n");
        await $({ cwd: repo })`git add tracked.txt .gitignore`;
        await $({ cwd: repo })`git commit -m initial`;

        const trackedContext = await gitContext(tracked);
        // Repository roots let browser navigation retain context across nested paths.
        expect(trackedContext.repository_root).toBe(repo);
        // Clean index membership must still classify a file as tracked.
        expect(trackedContext.tracking_state).toBe("tracked");
        // Status/exclude traversal distinguishes ordinary untracked content.
        expect((await gitContext(untracked)).tracking_state).toBe("untracked");
        // Direct ignored-file inspection remains available even though status omits it.
        expect((await gitContext(ignored)).tracking_state).toBe("ignored");
        const ignoredDiff = await gitDiff(ignored);
        // Ignored files have an explicit result instead of exposing their worktree content.
        expect(ignoredDiff.result.type).toBe("ignored");
        const untrackedDiff = await gitDiff(untracked);
        // Untracked files likewise avoid synthesizing a misleading HEAD comparison.
        expect(untrackedDiff.result.type).toBe("untracked");

        await rm(tracked);
        const deletedContext = await gitContext(tracked);
        // Discovery from the nearest existing parent keeps deleted tracked links useful.
        expect(deletedContext.tracking_state).toBe("deleted");
        await $({ cwd: repo })`git add tracked.txt`;
        const stagedDeletedContext = await gitContext(tracked);
        // A deletion remains deleted after it moves from the worktree side to the index side.
        expect(stagedDeletedContext.tracking_state).toBe("deleted");
        const stagedDeletedDiff = await gitDiff(tracked, "?mode=staged");
        // Staged deletion compares the HEAD blob with a missing index entry.
        expect(stagedDeletedDiff.result).toMatchObject({
            type: "text",
            unified_diff: expect.stringContaining("-tracked"),
        });

        const outside = tempFiles.create("outside\n", { suffix: ".txt" });
        const outsideContext = await gitContext(outside);
        // Outside paths are a normal availability result rather than an API error.
        expect(outsideContext.inside_worktree).toBe(false);
    });

    it("supports linked worktrees and does not execute configured external diff commands", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-linked-main" });
        await initRepository(repo);
        const file = join(repo, "file.txt");
        await writeFile(file, "base\n");
        await $({ cwd: repo })`git add file.txt`;
        await $({ cwd: repo })`git commit -m initial`;
        const linked = tempFiles.tempDirectory({ suffix: "-git-linked" });
        await rm(linked, { recursive: true });
        await $({ cwd: repo })`git worktree add ${linked}`;
        const linkedFile = join(linked, "file.txt");

        const linkedContext = await gitContext(linkedFile);
        // A `.git` indirection file must discover the linked worktree as its own browser root.
        expect(linkedContext.repository_root).toBe(linked);
        // Linked worktree files retain ordinary tracked classification.
        expect(linkedContext.tracking_state).toBe("tracked");

        const marker = join(repo, "external-diff-ran");
        await writeFile(
            join(linked, ".gitattributes"),
            "*.txt diff=redoor-test\n",
        );
        await $({
            cwd: linked,
        })`git config diff.redoor-test.command ${`touch ${marker}`}`;
        await writeFile(linkedFile, "changed\n");
        const response = await gitDiff(linkedFile);
        // Internal bounded formatting still returns the expected changed line.
        expect(response.result).toMatchObject({
            type: "text",
            unified_diff: expect.stringContaining("+changed"),
        });
        // The absent marker proves repository-configured external diff was never executed.
        await expect(access(marker)).rejects.toThrow();

        await writeFile(join(linked, ".gitattributes"), "*.txt -diff\n");
        const binaryByAttribute = await gitDiff(linkedFile);
        // Git's built-in binary attribute is honored without running an external driver.
        expect(binaryByAttribute.result.type).toBe("binary");

        await writeFile(
            join(linked, ".gitattributes"),
            "*.txt diff=redoor-test\n",
        );
        const outsideTarget = tempFiles.create("outside worktree\n", {
            suffix: ".txt",
        });
        await rm(linkedFile);
        await symlink(outsideTarget, linkedFile);
        const symlinkDiff = await gitDiff(linkedFile);
        // Full diffs never follow a worktree symlink into content outside the repository.
        expect(symlinkDiff.result.type).toBe("unsupported_entry");
    });

    it("returns filtered deterministic status and separates full from staged diffs", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-status" });
        const nested = join(repo, "nested");
        await mkdir(nested);
        await initRepository(repo);
        const file = join(nested, "file with ünicode.txt");
        await writeFile(file, "base\n");
        await writeFile(join(repo, "root.txt"), "root\n");
        await $({ cwd: repo })`git add .`;
        await $({ cwd: repo })`git commit -m initial`;
        await writeFile(file, "staged\n");
        await $({ cwd: repo })`git add nested`;
        await writeFile(file, "worktree\n");
        await writeFile(join(nested, "new.txt"), "new\n");
        await writeFile(join(repo, "root.txt"), "changed root\n");

        const nestedStatus = await gitStatus(nested);
        const entries = nestedStatus.entries;
        // Literal directory-prefix filtering excludes changed siblings at repository root.
        expect(entries.map((entry) => entry.repository_relative_path)).toEqual([
            "nested/file with ünicode.txt",
            "nested/new.txt",
        ]);
        // One path can simultaneously expose staged and unstaged modifications.
        expect(entries[0]).toMatchObject({
            index_state: "modified",
            worktree_state: "modified",
        });
        // Individual untracked files are explicit rather than collapsed directories.
        expect(entries[1]).toMatchObject({ worktree_state: "added" });

        const full = await gitDiff(file);
        const staged = await gitDiff(file, "?mode=staged");
        if (full.result.type !== "text" || staged.result.type !== "text") {
            throw new Error("modified text files should produce text diffs");
        }
        const fullPatch = full.result.unified_diff;
        const stagedPatch = staged.result.unified_diff;
        // Full mode compares HEAD directly with current worktree content.
        expect(fullPatch).toContain("+worktree");
        // Staged mode stops at the index and excludes later worktree edits.
        expect(stagedPatch).toContain("+staged");
        expect(stagedPatch).not.toContain("worktree");
        // Git-compatible labels retain Unicode and spaces without invoking external diff tools.
        expect(fullPatch).toContain("+++ b/nested/file with ünicode.txt");
    });

    it("handles unborn and detached HEAD plus bounded diff outcomes", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-edge" });
        await initRepository(repo);
        const added = join(repo, "added.txt");
        await writeFile(added, "added\n");
        await $({ cwd: repo })`git add added.txt`;

        const unbornStatus = await gitStatus(repo);
        // Unborn repositories report their intended branch without requiring a commit object.
        expect(unbornStatus.branch_name).toBeTruthy();
        const unbornDiff = await gitDiff(added, "?mode=staged");
        // An empty HEAD tree makes staged additions render as ordinary additions.
        expect(unbornDiff.result).toMatchObject({
            type: "text",
            unified_diff: expect.stringContaining("+added"),
        });

        await $({ cwd: repo })`git commit -m initial`;
        await $({ cwd: repo })`git checkout --detach`;
        const detachedStatus = await gitStatus(repo);
        // Detached context exposes an object ID instead of inventing a branch label.
        expect(detachedStatus.branch_name).toBeNull();
        expect(detachedStatus.detached_head_id).toMatch(/^[0-9a-f]{40}$/);

        const binary = join(repo, "binary.dat");
        await writeFile(binary, Buffer.from([0, 1, 2]));
        await $({ cwd: repo })`git add binary.dat`;
        const binaryDiff = await gitDiff(binary, "?mode=staged");
        // Binary classification prevents an empty textual patch from hiding changed bytes.
        expect(binaryDiff.result.type).toBe("binary");

        const oversized = join(repo, "oversized.txt");
        await writeFile(oversized, "x".repeat(2 * 1024 * 1024 + 1));
        await $({ cwd: repo })`git add oversized.txt`;
        const oversizedDiff = await gitDiff(oversized, "?mode=staged");
        // Object headers enforce the input bound before a large blob is decompressed.
        expect(oversizedDiff.result.type).toBe("too_large");
    });

    it("rejects invalid modes and bare repository status", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-invalid" });
        await initRepository(repo);
        await expect(
            gitDiff(join(repo, "file.txt"), "?mode=unknown"),
        ).rejects.toThrow(/400.*full.*staged/i);

        const bare = tempFiles.tempDirectory({ suffix: "-git-bare" });
        // Reinitialize the empty fixture as bare to exercise worktree rejection.
        await $({ cwd: bare })`git init --bare`;
        await expect(gitStatus(bare)).rejects.toThrow(/non-bare Git worktree/i);
    });

    it("reports conflicts, non-UTF-8 omissions, and deterministic truncation while control stays responsive", async () => {
        const repo = tempFiles.tempDirectory({ suffix: "-git-bounded" });
        await initRepository(repo);
        const conflict = join(repo, "conflict.txt");
        await writeFile(conflict, "base\n");
        await $({ cwd: repo })`git add conflict.txt`;
        await $({ cwd: repo })`git commit -m initial`;
        await $({ cwd: repo })`git checkout -b other`;
        await writeFile(conflict, "other\n");
        await $({ cwd: repo })`git commit -am other`;
        await $({ cwd: repo })`git checkout -`;
        await writeFile(conflict, "main\n");
        await $({ cwd: repo })`git commit -am main`;
        await expect($({ cwd: repo })`git merge other`).rejects.toBeInstanceOf(
            Error,
        );

        const conflictStatus = await gitStatus(repo);
        const conflictEntry = conflictStatus.entries.find(
            (entry) => entry.repository_relative_path === "conflict.txt",
        );
        // Unmerged index stages become an explicit conflict marker for grouping in clients.
        expect(conflictEntry?.conflict_state).toBe("conflicted");
        const conflictDiff = await gitDiff(conflict, "?mode=staged");
        // A multi-stage index has no unambiguous staged text source.
        expect(conflictDiff.result.type).toBe("unsupported_entry");
        await $({ cwd: repo })`git merge --abort`;

        const many = join(repo, "many");
        await mkdir(many);
        if (process.platform === "linux") {
            const invalidUtf8Path = Buffer.concat([
                Buffer.from(`${many}/invalid-`),
                Buffer.from([0xff]),
            ]);
            await writeFile(invalidUtf8Path, "not utf8\n");
        }
        await Promise.all(
            Array.from({ length: 5_001 }, (_, index) =>
                writeFile(
                    join(many, `entry-${String(index).padStart(4, "0")}`),
                    "x",
                ),
            ),
        );
        const statusPromise = gitStatus(many);
        const echoPromise = testAgent.echo("control-lane");
        const firstResult = await Promise.race([
            statusPromise.then(() => "status"),
            echoPromise.then(() => "echo"),
        ]);
        // The lightweight control command completes before the already-started large status walk.
        expect(firstResult).toBe("echo");
        const [boundedStatus, echo] = await Promise.all([
            statusPromise,
            echoPromise,
        ]);
        // The status response never exceeds its named authoritative entry limit.
        expect(boundedStatus.entries).toHaveLength(5_000);
        // Additional matching entries are represented explicitly rather than silently dropped.
        expect(boundedStatus.truncated).toBe(true);
        if (process.platform === "linux") {
            // Invalid UTF-8 paths are counted instead of being linked through lossy conversion.
            expect(
                Number(boundedStatus.omitted_non_utf8_entries),
            ).toBeGreaterThan(0);
        }
        // The echoed payload also confirms the concurrent command was routed successfully.
        expect(echo.message).toBe("control-lane");
        const paths = boundedStatus.entries.map((entry) =>
            String(entry.repository_relative_path),
        );
        // BTree ordering makes truncation stable across filesystem enumeration order.
        expect(paths).toEqual([...paths].sort());
    });
});
