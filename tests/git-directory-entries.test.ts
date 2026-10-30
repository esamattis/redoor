import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "zx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent } from "#ui/api-client";
import type { GitDirectoryEntriesResponse } from "#bindings/GitDirectoryEntriesResponse";
import type { GitDirectoryEntryState } from "#bindings/GitDirectoryEntryState";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

describe("Git directory entries REST API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let testAgent: Agent;
    let repo: string;

    /** Writes a file below the repository, creating its parent directories. */
    async function write(relative: string, contents: string): Promise<void> {
        const path = join(repo, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
    }

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: "git-directory-entries-agent",
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        testAgent = setup.testAgent;
        repo = tempFiles.tempDirectory({ suffix: "-git-entries" });

        await $({ cwd: repo })`git init --initial-branch=main`;
        await $({ cwd: repo })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;
        await write(
            ".gitignore",
            `node_modules/
*.log
`,
        );
        await write("clean.txt", "clean");
        await write("modified.txt", "one");
        await write("staged.txt", "one");
        await write("src/lib.rs", "one");
        await write("src/deep/mod.rs", "one");
        await $({ cwd: repo })`git add -A`;
        await $({ cwd: repo })`git commit -m initial`;

        await write("modified.txt", "two");
        await write("staged.txt", "two");
        await $({ cwd: repo })`git add staged.txt`;
        await write("added.txt", "new");
        await $({ cwd: repo })`git add added.txt`;
        await write("untracked.txt", "new");
        await write("debug.log", "ignored");
        await write("node_modules/pkg/index.js", "ignored");
        await write("src/lib.rs", "two");
        await write("src/deep/mod.rs", "two");
        await write("src/deep/new.rs", "new");
        await write("src/trace.log", "ignored");
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** The state listed for `name`, or undefined for a clean tracked entry. */
    function stateOf(
        response: GitDirectoryEntriesResponse,
        name: string,
    ): GitDirectoryEntryState | undefined {
        if (response.status !== "entries") {
            throw new Error(`Expected entries, got ${response.status}`);
        }

        return response.entries.find((entry) => entry.name === name)?.state;
    }

    it("reports the state of each file in the directory", async () => {
        const response = await testAgent.gitDirectoryEntries(repo);

        // A clean tracked file has nothing to show, so it is left out of the answer.
        expect(stateOf(response, "clean.txt")).toBeUndefined();
        // An unstaged edit differs on the worktree side only.
        expect(stateOf(response, "modified.txt")).toMatchObject({
            type: "changed",
            index_state: "unmodified",
            worktree_state: "modified",
            conflicted: false,
        });
        // A staged edit differs on the index side only.
        expect(stateOf(response, "staged.txt")).toMatchObject({
            type: "changed",
            index_state: "modified",
            worktree_state: "unmodified",
        });
        // A staged new file is an addition rather than an untracked file.
        expect(stateOf(response, "added.txt")).toMatchObject({
            type: "changed",
            index_state: "added",
        });
        // New and ignored files are told apart.
        expect(stateOf(response, "untracked.txt")).toEqual({ type: "untracked" });
        expect(stateOf(response, "debug.log")).toEqual({ type: "ignored" });
    });

    it("summarizes what a child directory contains", async () => {
        const response = await testAgent.gitDirectoryEntries(repo);

        // An ignored directory is ignored as a whole instead of being walked.
        expect(stateOf(response, "node_modules")).toEqual({ type: "ignored" });
        // Changes at any depth count towards the child they lie in; ignored files do not.
        expect(stateOf(response, "src")).toEqual({
            type: "contains_changes",
            most_severe: "changed",
            changed: 2,
            untracked: 1,
            conflicted: 0,
            truncated: false,
        });
    });

    it("scopes a subdirectory to its own entries", async () => {
        const response = await testAgent.gitDirectoryEntries(join(repo, "src"));

        // Entries are keyed by their name in the browsed directory.
        expect(stateOf(response, "lib.rs")).toMatchObject({ type: "changed" });
        expect(stateOf(response, "trace.log")).toEqual({ type: "ignored" });
        // Changes outside the browsed directory never leak into it.
        expect(stateOf(response, "modified.txt")).toBeUndefined();
    });

    it("answers inside an ignored directory that everything is ignored", async () => {
        const response = await testAgent.gitDirectoryEntries(
            join(repo, "node_modules", "pkg"),
        );

        // The browser marks every row ignored from this one answer.
        expect(response).toEqual({ status: "ignored" });
    });

    it("answers outside a repository without an error", async () => {
        const plain = tempFiles.tempDirectory({ suffix: "-git-entries-plain" });

        const response = await testAgent.gitDirectoryEntries(plain);

        // Any directory can be browsed, so lacking Git state is an answer, not a failure.
        expect(response).toEqual({ status: "outside_worktree" });
    });
});
