import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "zx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

describe("Git file bases REST API", () => {
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
            agentName: "git-file-bases-agent",
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        testAgent = setup.testAgent;
        repo = tempFiles.tempDirectory({ suffix: "-git-file-bases" });

        await $({ cwd: repo })`git init --initial-branch=main`;
        await $({ cwd: repo })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;
        await write(".gitignore", "*.log\n");
        await write("modified.txt", "one\ntwo\n");
        await write("staged.txt", "one\ntwo\n");
        await $({ cwd: repo })`git add -A`;
        await $({ cwd: repo })`git commit -m initial`;

        await write("modified.txt", "one\nchanged\n");
        await write("staged.txt", "one\nstaged\n");
        await $({ cwd: repo })`git add staged.txt`;
        await write("staged.txt", "one\nstaged\nunstaged\n");
        await write("untracked.txt", "new\n");
        await write("debug.log", "ignored\n");
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("sends only the index text when nothing is staged", async () => {
        const response = await testAgent.gitFileBases(
            join(repo, "modified.txt"),
        );

        // The browser diffs its own buffer against the index, and HEAD is not sent twice.
        expect(response).toEqual({
            status: "bases",
            index: "one\ntwo\n",
            head: { type: "same_as_index" },
        });
    });

    it("sends both texts when a change is staged", async () => {
        const response = await testAgent.gitFileBases(join(repo, "staged.txt"));

        // HEAD against the index tells staged lines from the unstaged ones on top.
        expect(response).toEqual({
            status: "bases",
            index: "one\nstaged\n",
            head: { type: "text", content: "one\ntwo\n" },
        });
    });

    it("has no bases for untracked files and none at all for ignored ones", async () => {
        // An untracked file is compared with nothing, so every line counts as new.
        expect(
            await testAgent.gitFileBases(join(repo, "untracked.txt")),
        ).toEqual({
            status: "bases",
            index: null,
            head: { type: "same_as_index" },
        });
        // An ignored file gets no gutter.
        expect(await testAgent.gitFileBases(join(repo, "debug.log"))).toEqual({
            status: "ignored",
        });
    });

    it("answers outside a repository without an error", async () => {
        const plain = tempFiles.tempDirectory({ suffix: "-git-bases-plain" });
        await writeFile(join(plain, "plain.txt"), "plain\n");

        const response = await testAgent.gitFileBases(join(plain, "plain.txt"));

        // The editor may ask about any file, so lacking Git state is an answer, not a failure.
        expect(response).toEqual({ status: "outside_worktree" });
    });
});
