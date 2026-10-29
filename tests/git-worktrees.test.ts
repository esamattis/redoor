import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "zx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "#ui/api-client";
import type { GitWorktreeListResponse } from "#bindings/GitWorktreeListResponse";
import type { GitWorktreeStatusRequest } from "#bindings/GitWorktreeStatusRequest";
import type { GitWorktreeStatusResponse } from "#bindings/GitWorktreeStatusResponse";
import type { GitWorktreeStatusResult } from "#bindings/GitWorktreeStatusResult";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "git-worktrees-rest-test-agent";

describe("Git worktree list and status REST API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let testAgent: Agent;
    let repo: string;
    let worktrees: Record<"feature" | "detached" | "missing", string>;
    let commits: Record<"base" | "feature", string>;

    /** Runs git in `cwd` with fixed dates, so activity ordering is deterministic. */
    function git(cwd: string, seconds: number) {
        const date = `@${seconds} +0000`;

        return $({
            cwd,
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: date,
                GIT_COMMITTER_DATE: date,
            },
        });
    }

    /** Reads the commit id HEAD names in a checkout. */
    async function head(cwd: string): Promise<string> {
        return (await $({ cwd })`git rev-parse HEAD`).stdout.trim();
    }

    /** Fetches the worktree list raw, so rejected paths and the JSON shape can be asserted. */
    async function worktreesRequest(path: string): Promise<Response> {
        const encodedPath = path
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");

        return fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/worktrees${encodedPath}`,
            { headers: testAgent.getAuthHeaders() },
        );
    }

    /** Posts a raw worktree status body, so malformed requests can be asserted. */
    async function worktreeStatusRequest(
        body: GitWorktreeStatusRequest,
    ): Promise<Response> {
        return fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/worktree-status`,
            {
                method: "POST",
                headers: {
                    ...testAgent.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            },
        );
    }

    /** Indexes a status response by requested path, since walks finish in any order. */
    function resultsByPath(
        response: GitWorktreeStatusResponse,
    ): Map<string, GitWorktreeStatusResult> {
        return new Map(
            response.statuses.map((entry) => [entry.path, entry.result]),
        );
    }

    /** Sets when a checkout's index was last written, which the list reads as activity. */
    async function setIndexTime(gitDir: string, seconds: number) {
        await utimes(join(gitDir, "index"), seconds, seconds);
    }

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        serverPort = setup.serverPort;
        testAgent = setup.testAgent;

        repo = tempFiles.tempDirectory({ suffix: "-git-worktrees" });
        await $({ cwd: repo })`git init -b main`;
        await $({
            cwd: repo,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: repo })`git config user.name Redoor Tests`;
        await writeFile(join(repo, "readme.txt"), "first\n");
        await git(repo, 1000)`git add .`;
        await git(repo, 1000)`git commit -m ${"Initial commit"}`;

        const parent = tempFiles.tempDirectory({ suffix: "-linked" });
        worktrees = {
            feature: join(parent, "feature"),
            detached: join(parent, "detached"),
            missing: join(parent, "missing"),
        };

        // A branch worktree with a newer commit than its index write, so its activity is
        // its commit time, and an uncommitted edit.
        await git(repo, 1000)`git worktree add -b feature ${worktrees.feature}`;
        await writeFile(join(worktrees.feature, "readme.txt"), "feature\n");
        await git(worktrees.feature, 3000)`git commit -am ${"Feature work"}`;
        await writeFile(join(worktrees.feature, "readme.txt"), "edited\n");
        await $({ cwd: repo })`git worktree lock ${worktrees.feature}`;

        // A detached worktree on the old commit whose index write is the newest activity,
        // with an untracked file.
        await git(
            repo,
            1000,
        )`git worktree add --detach ${worktrees.detached} main`;
        await writeFile(join(worktrees.detached, "notes.txt"), "notes\n");

        // A registered worktree whose directory was deleted outside Git.
        await git(repo, 1000)`git worktree add -b gone ${worktrees.missing}`;
        await rm(worktrees.missing, { recursive: true });

        // Git wrote every index just now, so pin their times after the last Git command to
        // make the activity order deterministic.
        await setIndexTime(join(repo, ".git"), 1000);
        await setIndexTime(join(repo, ".git", "worktrees", "feature"), 2000);
        await setIndexTime(join(repo, ".git", "worktrees", "detached"), 5000);

        commits = {
            base: await head(repo),
            feature: await head(worktrees.feature),
        };
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("lists the main worktree first and then the most recently active", async () => {
        const list = await testAgent.gitWorktrees(repo);

        // Main leads despite the oldest activity, the newest index write beats a newer
        // commit, and the missing checkout trails because nobody can work in it.
        expect(list.worktrees.map((worktree) => worktree.path)).toEqual([
            repo,
            worktrees.detached,
            worktrees.feature,
            worktrees.missing,
        ]);
        expect(list.repository_root).toBe(repo);
        expect(list.truncated).toBe(false);

        const [main, detached, feature, missing] = list.worktrees;

        // The main checkout is marked as the one the request came from.
        expect(main).toMatchObject({
            is_main: true,
            is_current: true,
            branch_name: "main",
            last_activity_at: 1000,
            locked: false,
            missing: false,
        });
        expect(main?.head_commit?.id).toBe(commits.base);

        // A detached HEAD has no branch, and its index write is newer than its commit.
        expect(detached).toMatchObject({
            is_main: false,
            is_current: false,
            branch_name: null,
            last_activity_at: 5000,
        });
        expect(detached?.head_commit?.id).toBe(commits.base);

        // The lock is reported, and the newer commit time wins over the older index write.
        expect(feature).toMatchObject({
            branch_name: "feature",
            last_activity_at: 3000,
            locked: true,
            missing: false,
        });
        expect(feature?.head_commit?.summary).toBe("Feature work");

        // A deleted checkout keeps its branch from the registration.
        expect(missing).toMatchObject({
            branch_name: "gone",
            missing: true,
        });
    });

    it("counts the tracked and untracked changes of several checkouts in one request", async () => {
        const outside = tempFiles.tempDirectory({
            suffix: "-git-worktree-status-outside",
        });

        const results = resultsByPath(
            await testAgent.gitWorktreeStatus([
                repo,
                worktrees.detached,
                worktrees.feature,
                outside,
            ]),
        );

        // Small checkouts all fit the agent's time budget, so every path is answered.
        expect(results.size).toBe(4);
        // The main checkout has no uncommitted work.
        expect(results.get(repo)).toEqual({
            type: "counted",
            changed: 0,
            untracked: 0,
            truncated: false,
        });
        // New files count as untracked, not changed.
        expect(results.get(worktrees.detached)).toEqual({
            type: "counted",
            changed: 0,
            untracked: 1,
            truncated: false,
        });
        // A tracked edit counts as changed.
        expect(results.get(worktrees.feature)).toEqual({
            type: "counted",
            changed: 1,
            untracked: 0,
            truncated: false,
        });
        // A path outside any repository fails on its own without hiding the other counts.
        expect(results.get(outside)?.type).toBe("failed");
    });

    it("counts a repeated path once", async () => {
        const response = await testAgent.gitWorktreeStatus([
            worktrees.feature,
            repo,
            worktrees.feature,
            repo,
        ]);

        // Repeated rows collapse, so one request cannot walk a checkout many times.
        expect(response.statuses.map((entry) => entry.path).sort()).toEqual(
            [repo, worktrees.feature].sort(),
        );
    });

    it("lists the same worktrees from inside a linked worktree", async () => {
        const nested = join(worktrees.feature, "src");
        await mkdir(nested, { recursive: true });

        const list = await testAgent.gitWorktrees(nested);

        // The order does not depend on which checkout the request came from.
        expect(list.worktrees.map((worktree) => worktree.path)).toEqual([
            repo,
            worktrees.detached,
            worktrees.feature,
            worktrees.missing,
        ]);
        // Only the checkout containing the requested path is current.
        expect(
            list.worktrees
                .filter((worktree) => worktree.is_current)
                .map((worktree) => worktree.path),
        ).toEqual([worktrees.feature]);
        // The response names the checkout the request resolved, like the other Git lists.
        expect(list.repository_root).toBe(worktrees.feature);
    });

    it("returns the generated JSON shapes and rejects paths outside a repository", async () => {
        const response = await worktreesRequest(repo);

        // The route answers plain GETs at a filesystem path.
        expect(response.status).toBe(200);

        const list: GitWorktreeListResponse = await response.json();

        // The raw REST shape matches the generated binding the UI consumes.
        expect(list.worktrees[0]?.is_main).toBe(true);

        const outside = tempFiles.tempDirectory({
            suffix: "-git-worktrees-outside",
        });

        // A path outside a repository has no worktrees to list.
        expect((await worktreesRequest(outside)).status).toBe(400);

        const nested = join(worktrees.feature, "src");
        await mkdir(nested, { recursive: true });
        const statusResponse = await worktreeStatusRequest({ paths: [nested] });

        // A path inside a checkout counts the whole checkout, not just that directory.
        expect(statusResponse.status).toBe(200);
        const status: GitWorktreeStatusResponse = await statusResponse.json();
        expect(status).toEqual({
            statuses: [
                {
                    path: nested,
                    result: {
                        type: "counted",
                        changed: 1,
                        untracked: 0,
                        truncated: false,
                    },
                },
            ],
        });

        // A relative path is rejected before it reaches the agent.
        expect(
            (await worktreeStatusRequest({ paths: ["relative/path"] })).status,
        ).toBe(400);
        // A request must name at least one checkout.
        expect((await worktreeStatusRequest({ paths: [] })).status).toBe(400);

        // A request may name at most every row the list can show.
        const tooMany = Array.from(
            { length: 202 },
            (_, index) => `${outside}/w${index}`,
        );

        expect((await worktreeStatusRequest({ paths: tooMany })).status).toBe(
            400,
        );
    });
});
