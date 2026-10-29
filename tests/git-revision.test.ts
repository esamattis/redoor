import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "zx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "#ui/api-client";
import type { GitCommitDiffResponse } from "#bindings/GitCommitDiffResponse";
import type { GitRevisionTreeResponse } from "#bindings/GitRevisionTreeResponse";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "git-revision-rest-test-agent";

/** A multi-paragraph body, so the response must keep blank lines between paragraphs. */
const secondCommitBody = `Explains the change.

Across paragraphs.`;

describe("Git revision REST API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let testAgent: Agent;
    let repo: string;
    let firstCommit: string;
    let secondCommit: string;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        serverPort = setup.serverPort;
        testAgent = setup.testAgent;

        repo = tempFiles.tempDirectory({ suffix: "-git-revision" });
        await $({ cwd: repo })`git init -b main`;
        await $({
            cwd: repo,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;

        await mkdir(join(repo, "docs"));
        await writeFile(join(repo, "readme.txt"), "first version\n");
        await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
        await writeFile(join(repo, "docs", "removed.txt"), "soon gone\n");
        await writeFile(join(repo, "binary.dat"), Buffer.from([0, 159, 1]));
        await $({ cwd: repo })`git add .`;
        await $({ cwd: repo })`git commit -m ${"First commit"}`;
        await $({ cwd: repo })`git tag v1`;
        firstCommit = (
            await $({ cwd: repo })`git rev-parse HEAD`
        ).stdout.trim();

        await writeFile(join(repo, "readme.txt"), "second version\n");
        await rm(join(repo, "docs", "removed.txt"));
        await writeFile(join(repo, "docs", "added.txt"), "new file\n");
        await $({ cwd: repo })`git add -A`;
        await $({
            cwd: repo,
        })`git commit -m ${"Second commit"} -m ${secondCommitBody}`;
        secondCommit = (
            await $({ cwd: repo })`git rev-parse HEAD`
        ).stdout.trim();

        // Uncommitted edits must never leak into revision views.
        await writeFile(join(repo, "readme.txt"), "worktree version\n");
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Fetches a Git route with a revision, returning the status so failures can be asserted. */
    async function revisionRequest(
        route: "tree" | "blob" | "commit-diff",
        path: string,
        rev: string,
    ): Promise<Response> {
        const encodedPath = path
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");

        return fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/${route}${encodedPath}?${new URLSearchParams({ rev }).toString()}`,
            { headers: testAgent.getAuthHeaders() },
        );
    }

    it("lists a directory as committed at a tag, branch and commit id", async () => {
        const atTag = await testAgent.gitRevisionTree(join(repo, "docs"), "v1");

        // The tag peels to the first commit, so its summary identifies the revision.
        expect(atTag.commit.id).toBe(firstCommit);
        expect(atTag.commit.summary).toBe("First commit");
        // The requested text is echoed back so the UI can keep showing a branch or tag name.
        expect(atTag.rev).toBe("v1");
        // The deleted file is still listed in the old tree, and the later one is not.
        expect(atTag.entry).toEqual({
            type: "directory",
            entries: [
                { name: "guide.md", kind: "file", size: 8 },
                { name: "removed.txt", kind: "file", size: 10 },
            ],
            truncated: false,
            omitted_non_utf8_entries: 0,
        });

        const atBranch = await testAgent.gitRevisionTree(repo, "main");

        // A branch resolves to its tip.
        expect(atBranch.commit.id).toBe(secondCommit);
        // The root commit's child names its parent, which the banner and diff link to.
        expect(atBranch.commit.parent_ids).toEqual([firstCommit]);
        // The repository root is listed from the commit's own tree.
        expect(atBranch.repository_relative_path).toBe("");

        const atId = await testAgent.gitRevisionTree(
            join(repo, "docs"),
            secondCommit.slice(0, 10),
        );

        // An abbreviated commit id resolves like the full one.
        expect(atId.commit.id).toBe(secondCommit);
        // The newer tree shows the addition and not the deletion.
        expect(
            atId.entry.type === "directory"
                ? atId.entry.entries.map((entry) => entry.name)
                : [],
        ).toEqual(["added.txt", "guide.md"]);
    });

    it("describes files and returns committed text, not the worktree", async () => {
        const readme = await testAgent.gitRevisionTree(
            join(repo, "readme.txt"),
            firstCommit,
        );

        // Small UTF-8 blobs are editable, which opens the read-only editor.
        expect(readme.entry).toMatchObject({
            type: "file",
            size: 14,
            executable: false,
            editable: true,
        });

        const content = await testAgent.gitRevisionContent(
            join(repo, "readme.txt"),
            firstCommit,
        );

        // The content comes from the commit even though the worktree file was changed since.
        expect(content.content).toBe("first version\n");

        const binary = await testAgent.gitRevisionTree(
            join(repo, "binary.dat"),
            "v1",
        );

        // Invalid UTF-8 keeps a binary file out of the editor.
        expect(binary.entry).toMatchObject({ type: "file", editable: false });

        const binaryContent = await revisionRequest(
            "blob",
            join(repo, "binary.dat"),
            "v1",
        );

        // Asking for binary text fails as bad input instead of returning mangled bytes.
        expect(binaryContent.status).toBe(400);
    });

    it("reaches paths deleted from the worktree and rejects missing ones", async () => {
        const removed = await revisionRequest(
            "tree",
            join(repo, "docs", "removed.txt"),
            "v1",
        );

        // A file deleted since the revision is still browsable at that revision.
        expect(removed.status).toBe(200);

        const missing = await revisionRequest(
            "tree",
            join(repo, "docs", "added.txt"),
            "v1",
        );

        // A path the revision lacks is reported as missing, like the worktree browser.
        expect(missing.status).toBe(404);

        const unknown = await revisionRequest("tree", repo, "no-such-branch");

        // An unknown revision is bad input rather than a missing path.
        expect(unknown.status).toBe(400);

        const control = await revisionRequest("tree", repo, "main\nfake");

        // Control characters are rejected before any agent work.
        expect(control.status).toBe(400);

        const outside = await revisionRequest(
            "tree",
            tempFiles.tempDirectory({ suffix: "-not-a-repository" }),
            "main",
        );

        // Paths outside a repository have no revisions.
        expect(outside.status).toBe(400);
    });

    it("diffs a commit against its parent, scoped to the browsed path", async () => {
        const whole: GitCommitDiffResponse = await testAgent.gitCommitDiff(
            repo,
            secondCommit,
        );

        // The commit is compared with its only parent.
        expect(whole.parent_id).toBe(firstCommit);
        // The body is the message below the summary, trimmed and with its paragraphs kept.
        expect(whole.body).toBe(secondCommitBody);
        // Every changed file is listed in path order with its change kind.
        expect(
            whole.files.map((file) => [
                file.repository_relative_path,
                file.change,
            ]),
        ).toEqual([
            ["docs/added.txt", "added"],
            ["docs/removed.txt", "deleted"],
            ["readme.txt", "modified"],
        ]);

        const readme = whole.files.find(
            (file) => file.repository_relative_path === "readme.txt",
        );

        // Files carry absolute worktree paths so the browser can link to them.
        expect(readme?.path).toBe(join(repo, "readme.txt"));
        // The patch replaces the committed line, not the uncommitted worktree text.
        expect(readme?.result).toMatchObject({ type: "text" });
        expect(
            readme?.result.type === "text" ? readme.result.unified_diff : "",
        ).toContain("-first version\n+second version");

        const docs = await testAgent.gitCommitDiff(
            join(repo, "docs"),
            secondCommit,
        );

        // A directory scopes the diff to its own subtree.
        expect(docs.files.map((file) => file.repository_relative_path)).toEqual(
            ["docs/added.txt", "docs/removed.txt"],
        );

        const single = await testAgent.gitCommitDiff(
            join(repo, "readme.txt"),
            secondCommit,
        );

        // A file path diffs only that file.
        expect(
            single.files.map((file) => file.repository_relative_path),
        ).toEqual(["readme.txt"]);

        const root: GitCommitDiffResponse = await testAgent.gitCommitDiff(
            repo,
            firstCommit,
        );

        // A root commit has no parent and adds every file.
        expect(root.parent_id).toBeNull();
        // A summary-only message has an empty body rather than a missing one.
        expect(root.body).toBe("");
        expect(root.files.every((file) => file.change === "added")).toBe(true);

        const binary = root.files.find(
            (file) => file.repository_relative_path === "binary.dat",
        );

        // Binary content has an explicit outcome instead of a garbled patch.
        expect(binary?.result).toEqual({ type: "binary" });
    });

    it("diffs a range of commits as one change compared with its start", async () => {
        const range: GitCommitDiffResponse = await testAgent.gitCommitDiff(
            repo,
            `${firstCommit}..${secondCommit}`,
        );

        // The range names its newer end and is compared with its start.
        expect(range.commit.id).toBe(secondCommit);
        expect(range.parent_id).toBe(firstCommit);
        // The start is described, so the view can name both ends instead of one message.
        expect(range.range?.base?.id).toBe(firstCommit);
        expect(range.range?.base?.summary).toBe("First commit");
        // A one-commit range has exactly that commit's changes.
        expect(
            range.files.map((file) => [
                file.repository_relative_path,
                file.change,
            ]),
        ).toEqual([
            ["docs/added.txt", "added"],
            ["docs/removed.txt", "deleted"],
            ["readme.txt", "modified"],
        ]);

        const single = await testAgent.gitCommitDiff(repo, secondCommit);

        // A single revision is not a range, so the view keeps the commit's own header.
        expect(single.range).toBeNull();

        const fromRoot: GitCommitDiffResponse = await testAgent.gitCommitDiff(
            repo,
            `${firstCommit}^..${secondCommit}`,
        );

        // The parent of a root commit starts the range at the empty tree, so a run of
        // commits reaching the first one still has a base.
        expect(fromRoot.parent_id).toBeNull();
        expect(fromRoot.range).toEqual({ base: null });
        // The commits combine: a file added and removed inside the range is not listed, and
        // everything else counts as added.
        expect(
            fromRoot.files.map((file) => [
                file.repository_relative_path,
                file.change,
            ]),
        ).toEqual([
            ["binary.dat", "added"],
            ["docs/added.txt", "added"],
            ["docs/guide.md", "added"],
            ["readme.txt", "added"],
        ]);

        const readme = fromRoot.files.find(
            (file) => file.repository_relative_path === "readme.txt",
        );

        // The combined patch shows the end state, not the intermediate first version.
        expect(
            readme?.result.type === "text" ? readme.result.unified_diff : "",
        ).toContain("+second version");

        const scoped = await testAgent.gitCommitDiff(
            join(repo, "docs"),
            `v1..${secondCommit}`,
        );

        // A range is scoped to the browsed path like a single commit, and takes ref names.
        expect(
            scoped.files.map((file) => file.repository_relative_path),
        ).toEqual(["docs/added.txt", "docs/removed.txt"]);

        const tree = await testAgent.gitRevisionTree(
            repo,
            `${firstCommit}..${secondCommit}`,
        );

        // Browsing a range shows the files at its newer end.
        expect(tree.commit.id).toBe(secondCommit);

        const symmetric = await revisionRequest(
            "commit-diff",
            repo,
            `${firstCommit}...${secondCommit}`,
        );

        // A symmetric range is refused rather than misread as a plain range.
        expect(symmetric.status).toBe(400);
        expect(await symmetric.text()).toContain("not supported");

        const unknownStart = await revisionRequest(
            "commit-diff",
            repo,
            `no-such-branch..${secondCommit}`,
        );

        // Both sides must resolve; an unknown start is bad input like any unknown revision.
        expect(unknownStart.status).toBe(400);

        const beyondRoot = await revisionRequest(
            "commit-diff",
            repo,
            `${secondCommit}~3..${secondCommit}`,
        );

        // Only the parent of a root commit means the empty tree; an ancestor further back
        // than that is still an unknown revision.
        expect(beyondRoot.status).toBe(400);
    });

    /** Creates a repository with a test identity, so each scenario owns its history. */
    async function createRepository(suffix: string): Promise<string> {
        const directory = tempFiles.tempDirectory({ suffix });
        await $({ cwd: directory })`git init -b main`;
        await $({
            cwd: directory,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: directory })`git config user.name Redoor Tests`;

        return directory;
    }

    /** Commits everything in a repository and returns the new commit id. */
    async function commitAll(directory: string, message: string) {
        await $({ cwd: directory })`git add -A`;
        await $({ cwd: directory })`git commit -m ${message}`;

        return (await $({ cwd: directory })`git rev-parse HEAD`).stdout.trim();
    }

    it("rejects revisions that name a blob or tree instead of a commit", async () => {
        const blobId = (
            await $({ cwd: repo })`git rev-parse ${`${firstCommit}:readme.txt`}`
        ).stdout.trim();

        const blob = await revisionRequest("tree", repo, blobId);

        // A blob id is refused from its object header, as invalid input rather than a missing path.
        expect(blob.status).toBe(400);
        expect(await blob.text()).toContain("does not name a commit");

        const treeId = (
            await $({ cwd: repo })`git rev-parse ${`${firstCommit}^{tree}`}`
        ).stdout.trim();

        const tree = await revisionRequest("tree", repo, treeId);

        // A tree id is refused the same way, since only commits have a history to browse.
        expect(tree.status).toBe(400);
    });

    it("lists both sides when a file and a directory replace each other", async () => {
        const replaced = await createRepository("-git-revision-replaced");
        await writeFile(join(replaced, "config"), "file\n");
        await commitAll(replaced, "Config file");
        await rm(join(replaced, "config"));
        await mkdir(join(replaced, "config"));
        await writeFile(join(replaced, "config", "settings"), "nested\n");
        const toDirectory = await commitAll(replaced, "Config directory");

        const fileToDirectory = await testAgent.gitCommitDiff(
            join(replaced, "config"),
            toDirectory,
        );

        // Scoping to the path must keep the removed file next to the directory that replaced it.
        expect(
            fileToDirectory.files.map((file) => [
                file.repository_relative_path,
                file.change,
            ]),
        ).toEqual([
            ["config", "deleted"],
            ["config/settings", "added"],
        ]);

        await rm(join(replaced, "config"), { recursive: true });
        await writeFile(join(replaced, "config"), "file again\n");
        const toFile = await commitAll(replaced, "Config file again");

        const directoryToFile = await testAgent.gitCommitDiff(
            join(replaced, "config"),
            toFile,
        );

        // The reverse replacement keeps the added file next to the removed directory contents.
        expect(
            directoryToFile.files.map((file) => [
                file.repository_relative_path,
                file.change,
            ]),
        ).toEqual([
            ["config", "added"],
            ["config/settings", "deleted"],
        ]);
    });

    it("stops collecting commit changes at the response limit", async () => {
        const many = await createRepository("-git-revision-many");
        await mkdir(join(many, "files"));
        await Promise.all(
            Array.from({ length: 140 }, (_, index) =>
                writeFile(
                    join(
                        many,
                        "files",
                        `${String(index).padStart(3, "0")}.txt`,
                    ),
                    `${index}\n`,
                ),
            ),
        );
        const commit = await commitAll(many, "Many files");

        const diff = await testAgent.gitCommitDiff(many, commit);

        // More changes than one response carries are reported instead of silently dropped.
        expect(diff.truncated).toBe(true);
        // The response is capped at the per-request file limit.
        expect(diff.files).toHaveLength(128);
        const paths = diff.files.map((file) => file.repository_relative_path);
        // The kept files are still shown in path order.
        expect(paths).toEqual([...paths].sort());
    });

    it("resolves a superproject revision on a checked-out submodule path", async () => {
        const library = await createRepository("-git-revision-library");
        await writeFile(join(library, "lib.txt"), "library\n");
        const libraryCommit = await commitAll(library, "Library");

        const superproject = await createRepository("-git-revision-super");
        await writeFile(join(superproject, "app.txt"), "app\n");
        await $({
            cwd: superproject,
        })`git -c protocol.file.allow=always submodule add ${library} lib`;
        const superCommit = await commitAll(superproject, "Add library");

        const gitlink = await testAgent.gitRevisionTree(
            join(superproject, "lib"),
            superCommit,
        );

        // The submodule checkout does not know the superproject commit, so the superproject
        // resolves it and shows the gitlink it recorded.
        expect(gitlink.repository_root).toBe(superproject);
        expect(gitlink.entry).toEqual({
            type: "submodule",
            commit_id: libraryCommit,
        });

        const inside = await testAgent.gitRevisionTree(
            join(superproject, "lib"),
            libraryCommit,
        );

        // The submodule's own commits are still browsed inside the submodule.
        expect(inside.repository_root).toBe(join(superproject, "lib"));
        expect(
            inside.entry.type === "directory"
                ? inside.entry.entries.map((entry) => entry.name)
                : [],
        ).toEqual(["lib.txt"]);
    });

    it("keeps the revision route responses typed for the browser", async () => {
        const response = await revisionRequest("tree", repo, "v1");
        const body: GitRevisionTreeResponse = await response.json();

        // The raw REST shape matches the generated binding the UI consumes.
        expect(body.entry.type).toBe("directory");
        expect(body.repository_root).toBe(repo);
    });
});
