import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "zx";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { Agent } from "#ui/api-client";
import type { GitCommitNeighborsResponse } from "#bindings/GitCommitNeighborsResponse";
import type { GitLogResponse } from "#bindings/GitLogResponse";
import type { GitRefListResponse } from "#bindings/GitRefListResponse";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "git-history-rest-test-agent";

describe("Git history, branch and tag REST API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let testAgent: Agent;
    let repo: string;

    /** Commit ids by the name each was created under, oldest first by commit time. */
    const commits: Record<"a" | "b" | "c" | "d" | "merge", string> = {
        a: "",
        b: "",
        c: "",
        d: "",
        merge: "",
    };

    /** Runs git in `cwd` with fixed dates, so commit-time ordering is deterministic. */
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

    /** Reads the commit id a revision names in the test repository. */
    async function revParse(rev: string): Promise<string> {
        return (await $({ cwd: repo })`git rev-parse ${rev}`).stdout.trim();
    }

    /** Creates an empty repository with an identity, so commits need no global config. */
    async function createRepository(suffix: string): Promise<string> {
        const directory = tempFiles.tempDirectory({ suffix });
        await $({ cwd: directory })`git init -b main`;
        await $({
            cwd: directory,
        })`git config user.email redoor-tests@example.invalid`;
        await $({ cwd: directory })`git config user.name Redoor Tests`;

        return directory;
    }

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        serverPort = setup.serverPort;
        testAgent = setup.testAgent;

        // main: a -> b -> c -> merge, with feature branching from b to d.
        repo = await createRepository("-git-history");
        await mkdir(join(repo, "docs"));
        await writeFile(join(repo, "readme.txt"), "first\n");
        await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
        await git(repo, 1000)`git add .`;
        await git(repo, 1000)`git commit -m ${"Add readme and guide"}`;
        commits.a = await revParse("HEAD");

        await writeFile(join(repo, "docs", "guide.md"), "# Guide v2\n");
        await git(repo, 2000)`git commit -am ${"Update guide"}`;
        commits.b = await revParse("HEAD");

        await git(repo, 2000)`git branch feature`;
        await writeFile(join(repo, "readme.txt"), "second\n");
        await git(repo, 3000)`git commit -am ${"Update readme"}`;
        commits.c = await revParse("HEAD");

        await git(repo, 3000)`git checkout feature`;
        await writeFile(join(repo, "docs", "feature.txt"), "feature\n");
        await git(repo, 2500)`git add .`;
        await git(repo, 2500)`git commit -m ${"Add feature notes"}`;
        commits.d = await revParse("HEAD");

        await git(repo, 4000)`git checkout main`;
        await git(repo, 4000)`git merge --no-ff feature -m ${"Merge feature"}`;
        commits.merge = await revParse("HEAD");

        // Tags: lightweight on a, annotated on c, and one naming a blob, which has no history.
        await git(repo, 4000)`git tag v1 ${commits.a}`;
        await git(repo, 4000)`git tag -a v2 -m ${"Release 2"} ${commits.c}`;
        const blob = await revParse(`${commits.a}:readme.txt`);
        await git(repo, 4000)`git tag blob-tag ${blob}`;

        // A remote-tracking branch and the symbolic origin/HEAD that points at it.
        await $({
            cwd: repo,
        })`git update-ref refs/remotes/origin/main ${commits.a}`;
        await $({
            cwd: repo,
        })`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`;
    }, 30_000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Fetches a Git list route with raw query values, so rejected input can be asserted. */
    async function listRequest(
        route: "log" | "branches" | "tags" | "commit-neighbors",
        path: string,
        query: Record<string, string>,
    ): Promise<Response> {
        const encodedPath = path
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");

        return fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${encodeURIComponent(testAgent.id)}/git/${route}${encodedPath}?${new URLSearchParams(query).toString()}`,
            { headers: testAgent.getAuthHeaders() },
        );
    }

    /** Lists the ids of a whole log from HEAD or a revision in one page. */
    async function logIds(path: string, rev: string | null = null) {
        const log = await testAgent.gitLog(path, { rev, skip: 0, limit: 100 });

        return log.commits.map((commit) => commit.id);
    }

    it("lists every commit from HEAD newest first", async () => {
        const log = await testAgent.gitLog(repo, {
            rev: null,
            skip: 0,
            limit: 100,
        });

        // Commit time orders the walk across both sides of the merge, like `git log`.
        expect(log.commits.map((commit) => commit.id)).toEqual([
            commits.merge,
            commits.c,
            commits.d,
            commits.b,
            commits.a,
        ]);
        // The repository root is not a path filter.
        expect(log.repository_relative_path).toBe("");
        // The whole history fits the page.
        expect(log.has_more).toBe(false);
        // Rows carry the summary the list shows.
        expect(log.commits[0]?.summary).toBe("Merge feature");
        expect(log.commits[0]?.parent_ids).toEqual([commits.c, commits.d]);
    });

    it("limits history to commits that changed a directory or file", async () => {
        // The merge brought nothing new to docs beyond the feature commit, so it is left out.
        expect(await logIds(join(repo, "docs"))).toEqual([
            commits.d,
            commits.b,
            commits.a,
        ]);
        // A file lists only the commits that changed it, including the one that added it.
        expect(await logIds(join(repo, "docs", "guide.md"))).toEqual([
            commits.b,
            commits.a,
        ]);
        // A file changed on the side branch lists that commit, not the merge.
        expect(await logIds(join(repo, "docs", "feature.txt"))).toEqual([
            commits.d,
        ]);

        const scoped = await testAgent.gitLog(join(repo, "docs"), {
            rev: null,
            skip: 0,
            limit: 100,
        });

        // The scope is reported so the browser can say which path the list covers.
        expect(scoped.repository_relative_path).toBe("docs");
    });

    it("starts history at a revision instead of HEAD", async () => {
        // A tag starts the walk at its commit, leaving out everything after it.
        expect(await logIds(repo, "v1")).toEqual([commits.a]);
        // An annotated tag is peeled to the commit it names.
        expect(await logIds(repo, "v2")).toEqual([
            commits.c,
            commits.b,
            commits.a,
        ]);
        // A path filter applies to a revision's history too.
        expect(await logIds(join(repo, "readme.txt"), commits.merge)).toEqual([
            commits.c,
            commits.a,
        ]);
    });

    it("pages through history in walk order", async () => {
        const first = await testAgent.gitLog(repo, {
            rev: null,
            skip: 0,
            limit: 2,
        });

        // The first page holds the newest commits and says more follow.
        expect(first.commits.map((commit) => commit.id)).toEqual([
            commits.merge,
            commits.c,
        ]);
        expect(first.has_more).toBe(true);

        const middle = await testAgent.gitLog(repo, {
            rev: null,
            skip: 2,
            limit: 2,
        });

        // The offset continues exactly where the previous page ended.
        expect(middle.commits.map((commit) => commit.id)).toEqual([
            commits.d,
            commits.b,
        ]);
        expect(middle.has_more).toBe(true);

        const last = await testAgent.gitLog(repo, {
            rev: null,
            skip: 4,
            limit: 2,
        });

        // The last page is short and ends the list.
        expect(last.commits.map((commit) => commit.id)).toEqual([commits.a]);
        expect(last.has_more).toBe(false);

        const scoped = await testAgent.gitLog(join(repo, "docs"), {
            rev: null,
            skip: 1,
            limit: 1,
        });

        // Offsets count matching commits, not every commit walked.
        expect(scoped.commits.map((commit) => commit.id)).toEqual([commits.b]);
        expect(scoped.has_more).toBe(true);
    });

    /** Reads the ids of the commits on either side of `rev` in the history of `path`. */
    async function neighborIds(path: string, rev: string) {
        const neighbors = await testAgent.gitCommitNeighbors(path, rev);

        return {
            older: neighbors.older?.id ?? null,
            newer: neighbors.newer?.id ?? null,
        };
    }

    it("finds the commits on either side of a commit", async () => {
        // The first commit has nothing before it, and the next change is its child.
        expect(await neighborIds(repo, commits.a)).toEqual({
            older: null,
            newer: commits.b,
        });
        // Next follows the walk order the Commits list shows, which reaches the side branch
        // first because it was committed earlier than main's next commit.
        expect(await neighborIds(repo, commits.b)).toEqual({
            older: commits.a,
            newer: commits.d,
        });
        // Previous only ever steps to an ancestor, so a commit on main skips the side branch.
        expect(await neighborIds(repo, commits.c)).toEqual({
            older: commits.b,
            newer: commits.merge,
        });
        // Main's newer commit does not contain the side branch commit, so next is the merge.
        expect(await neighborIds(repo, commits.d)).toEqual({
            older: commits.b,
            newer: commits.merge,
        });
        // HEAD has nothing after it.
        expect(await neighborIds(repo, commits.merge)).toEqual({
            older: commits.c,
            newer: null,
        });
        // A branch name resolves like the commit it points at.
        expect(await neighborIds(repo, "feature")).toEqual({
            older: commits.b,
            newer: commits.merge,
        });
    });

    it("steps only between commits that changed the browsed path", async () => {
        // A commit that did not touch the file still finds the file's changes around it.
        expect(await neighborIds(join(repo, "readme.txt"), commits.b)).toEqual({
            older: commits.a,
            newer: commits.c,
        });
        // The merge kept main's readme, so it is not a change of the file.
        expect(await neighborIds(join(repo, "readme.txt"), commits.c)).toEqual({
            older: commits.a,
            newer: null,
        });
        // A directory steps over commits that changed only files outside it.
        expect(await neighborIds(join(repo, "docs"), commits.b)).toEqual({
            older: commits.a,
            newer: commits.d,
        });
    });

    it("has no next commit for a commit HEAD does not contain", async () => {
        const tree = await revParse(`${commits.a}^{tree}`);

        // A commit no ref points at, newer than HEAD, so the walk from HEAD never meets it.
        const unreachable = (
            await git(
                repo,
                5000,
            )`git commit-tree ${tree} -p ${commits.a} -m ${"Unreachable"}`
        ).stdout.trim();

        // Previous still walks its own ancestors, but only HEAD defines what comes next.
        expect(await neighborIds(repo, unreachable)).toEqual({
            older: commits.a,
            newer: null,
        });
    });

    it("rejects unknown revisions and paths outside a repository for neighbours", async () => {
        // An unknown revision is bad input, like everywhere else in revision browsing.
        expect(
            (
                await listRequest("commit-neighbors", repo, {
                    rev: "no-such-branch",
                })
            ).status,
        ).toBe(400);

        const outside = tempFiles.tempDirectory({
            suffix: "-git-neighbors-outside",
        });

        // A path outside a repository has no history to step through.
        expect(
            (await listRequest("commit-neighbors", outside, { rev: "HEAD" }))
                .status,
        ).toBe(400);

        const neighbors: GitCommitNeighborsResponse = await (
            await listRequest("commit-neighbors", repo, { rev: commits.c })
        ).json();

        // The raw REST shape matches the generated binding the UI consumes.
        expect(neighbors.older?.summary).toBe("Update guide");
        expect(neighbors.newer?.summary).toBe("Merge feature");
    });

    it("keeps history for a path deleted from the worktree", async () => {
        const deleted = join(repo, "docs", "feature.txt");
        await rm(deleted);
        onTestFinished(async () => {
            await writeFile(deleted, "feature\n");
        });

        // History is read from commits, so an uncommitted deletion does not hide it.
        expect(await logIds(deleted)).toEqual([commits.d]);
    });

    it("returns an empty history for a repository without commits", async () => {
        const unborn = await createRepository("-git-history-unborn");

        const log = await testAgent.gitLog(unborn, {
            rev: null,
            skip: 0,
            limit: 100,
        });

        // An unborn HEAD is an empty list rather than an error.
        expect(log.commits).toEqual([]);
        expect(log.has_more).toBe(false);

        const branches = await testAgent.gitRefs(unborn, "branches", {
            sort: "recent",
            skip: 0,
            limit: 100,
        });

        // The unborn branch has no ref yet, so nothing is listed.
        expect(branches.refs).toEqual([]);
        expect(branches.total).toBe(0);
    });

    it("lists local and remote branches by their latest commit", async () => {
        const branches = await testAgent.gitRefs(
            join(repo, "docs"),
            "branches",
            {
                sort: "recent",
                skip: 0,
                limit: 100,
            },
        );

        // Newest commit first; the symbolic origin/HEAD is skipped as a duplicate.
        expect(
            branches.refs.map((ref) => [ref.name, ref.full_name, ref.kind]),
        ).toEqual([
            ["main", "refs/heads/main", "branch"],
            ["feature", "refs/heads/feature", "branch"],
            ["origin/main", "refs/remotes/origin/main", "remote_branch"],
        ]);
        // Only the checked-out branch is marked as HEAD.
        expect(branches.refs.map((ref) => ref.is_head)).toEqual([
            true,
            false,
            false,
        ]);
        // origin/HEAD names main, so the local main is the default branch.
        expect(branches.refs.map((ref) => ref.is_default)).toEqual([
            true,
            false,
            false,
        ]);
        // Each row carries its commit for the summary and the changes link.
        expect(branches.refs[0]?.commit.id).toBe(commits.merge);
        expect(branches.total).toBe(3);
        expect(branches.has_more).toBe(false);
    });

    it("lists only local or only remote-tracking branches on request", async () => {
        const local = await testAgent.gitRefs(repo, "branches", {
            sort: "recent",
            scope: "local",
            skip: 0,
            limit: 100,
        });

        // The local scope leaves remote-tracking branches out of the rows and the count, so
        // paging stays consistent with what the browser shows.
        expect(local.refs.map((ref) => [ref.name, ref.kind])).toEqual([
            ["main", "branch"],
            ["feature", "branch"],
        ]);
        expect(local.total).toBe(2);
        // The default branch is still marked when only local branches are read.
        expect(local.refs[0]?.is_default).toBe(true);

        const remote = await testAgent.gitRefs(repo, "branches", {
            sort: "recent",
            scope: "remote",
            skip: 0,
            limit: 100,
        });

        // The remote scope lists only remote-tracking branches, still without origin/HEAD.
        expect(remote.refs.map((ref) => [ref.name, ref.kind])).toEqual([
            ["origin/main", "remote_branch"],
        ]);
        expect(remote.total).toBe(1);
        expect(remote.has_more).toBe(false);

        const all = await testAgent.gitRefs(repo, "branches", {
            sort: "recent",
            scope: "all",
            skip: 0,
            limit: 100,
        });

        // The explicit all scope matches the default listing, which the compare picker uses.
        expect(all.total).toBe(3);
    });

    it("lists tags peeled to commits and pages them", async () => {
        const tags = await testAgent.gitRefs(repo, "tags", {
            sort: "recent",
            skip: 0,
            limit: 100,
        });

        // The annotated tag points at a newer commit, and the blob tag is left out.
        expect(tags.refs.map((ref) => [ref.name, ref.commit.id])).toEqual([
            ["v2", commits.c],
            ["v1", commits.a],
        ]);
        // Links use the full name so a tag never resolves to a same-named branch.
        expect(tags.refs[0]?.full_name).toBe("refs/tags/v2");
        expect(tags.refs[0]?.kind).toBe("tag");

        const second = await testAgent.gitRefs(repo, "tags", {
            sort: "recent",
            skip: 1,
            limit: 1,
        });

        // A later page continues the same order and reports the full count.
        expect(second.refs.map((ref) => ref.name)).toEqual(["v1"]);
        expect(second.total).toBe(2);
        expect(second.has_more).toBe(false);

        const first = await testAgent.gitRefs(repo, "tags", {
            sort: "recent",
            skip: 0,
            limit: 1,
        });

        // A page that leaves refs behind says so.
        expect(first.has_more).toBe(true);
    });

    it("lists branches and tags by name", async () => {
        const branches = await testAgent.gitRefs(repo, "branches", {
            sort: "name",
            skip: 0,
            limit: 100,
        });

        // The default branch leads even though feature sorts before it by name, and local
        // branches lead remote-tracking ones.
        expect(branches.refs.map((ref) => ref.name)).toEqual([
            "main",
            "feature",
            "origin/main",
        ]);
        // The order does not change which refs are counted.
        expect(branches.total).toBe(3);

        const tags = await testAgent.gitRefs(repo, "tags", {
            sort: "name",
            skip: 0,
            limit: 100,
        });

        // The older v1 now leads, and the blob tag is still left out.
        expect(tags.refs.map((ref) => ref.name)).toEqual(["v1", "v2"]);

        const second = await testAgent.gitRefs(repo, "tags", {
            sort: "name",
            skip: 1,
            limit: 1,
        });

        // Later pages continue the name order rather than the recent one.
        expect(second.refs.map((ref) => ref.name)).toEqual(["v2"]);
        expect(second.has_more).toBe(false);
    });

    it("keeps the default branch first in either order", async () => {
        const branched = await createRepository("-git-history-default-branch");
        await git(branched, 1000)`git commit --allow-empty -q -m ${"Root"}`;
        await git(branched, 2000)`git branch alpha`;
        await git(branched, 2000)`git checkout -q alpha`;
        await git(branched, 2000)`git commit --allow-empty -q -m ${"Alpha"}`;
        await git(branched, 3000)`git checkout -q -b zeta`;
        await git(branched, 3000)`git commit --allow-empty -q -m ${"Zeta"}`;

        /** Lists the branch names of the repository in an order. */
        async function branchNames(sort: "recent" | "name") {
            const branches = await testAgent.gitRefs(branched, "branches", {
                sort,
                skip: 0,
                limit: 100,
            });

            return branches.refs.map((ref) => ref.name);
        }

        // Without a remote, main is the default and stays above the newer branches.
        expect(await branchNames("recent")).toEqual(["main", "zeta", "alpha"]);
        // By name, main still leads alpha.
        expect(await branchNames("name")).toEqual(["main", "alpha", "zeta"]);

        const firstPage = await testAgent.gitRefs(branched, "branches", {
            sort: "name",
            skip: 0,
            limit: 1,
        });

        // The default branch is pinned in the order itself, so only the first page has it.
        expect(firstPage.refs.map((ref) => ref.name)).toEqual(["main"]);
        expect(firstPage.has_more).toBe(true);

        await $({
            cwd: branched,
        })`git update-ref refs/remotes/origin/zeta zeta`;
        await $({
            cwd: branched,
        })`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/zeta`;

        // The remote's HEAD names the project's default, which wins over the name main, and
        // the local branch of that name is the one pinned.
        expect(await branchNames("name")).toEqual([
            "zeta",
            "alpha",
            "main",
            "origin/zeta",
        ]);
    });

    it("rejects invalid pages, revisions and paths", async () => {
        // An empty page would make loading more loop forever.
        expect((await listRequest("log", repo, { limit: "0" })).status).toBe(
            400,
        );
        // Oversized pages would outgrow a control frame.
        expect((await listRequest("tags", repo, { limit: "501" })).status).toBe(
            400,
        );
        // Offsets are bounded so ref listings cannot hold unbounded rows.
        expect(
            (await listRequest("branches", repo, { skip: "1000001" })).status,
        ).toBe(400);
        // Only the known orders are accepted, so a typo does not silently fall back.
        expect(
            (await listRequest("tags", repo, { sort: "newest" })).status,
        ).toBe(400);
        // Only the known branch scopes are accepted, so a typo does not list every branch.
        expect(
            (await listRequest("branches", repo, { scope: "origin" })).status,
        ).toBe(400);
        // Unknown revisions are bad input, like in revision browsing.
        expect(
            (await listRequest("log", repo, { rev: "no-such-branch" })).status,
        ).toBe(400);

        const outside = tempFiles.tempDirectory({
            suffix: "-git-history-outside",
        });

        // Paths outside a repository have no history or refs.
        expect((await listRequest("log", outside, {})).status).toBe(400);
        expect((await listRequest("branches", outside, {})).status).toBe(400);
    });

    it("keeps the list route responses typed for the browser", async () => {
        const log: GitLogResponse = await (
            await listRequest("log", repo, { limit: "1" })
        ).json();

        // The raw REST shape matches the generated binding the UI consumes.
        expect(log.repository_root).toBe(repo);
        expect(log.commits).toHaveLength(1);

        const tags: GitRefListResponse = await (
            await listRequest("tags", repo, {})
        ).json();

        // The default page size covers this small repository.
        expect(tags.refs).toHaveLength(2);
        // Without a sort the listing is most recently committed first.
        expect(tags.refs.map((ref) => ref.name)).toEqual(["v2", "v1"]);
    });
});
