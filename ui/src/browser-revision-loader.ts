/** Loads the file browser route for a path at a Git revision, apart from the worktree loader. */
import { redirect } from "@tanstack/react-router";
import type { Agent } from "#ui/api-client";
import type { BrowserSearch } from "#ui/browser-search";
import {
    commitDiffRevision,
    revisionRange,
} from "#ui/components/browser/git-parts";
import {
    getPathLoadError,
    type PathLoadError,
} from "#ui/components/browser/utils";
import {
    agentDetailsQueryOptions,
    fetchQueryUncancelled,
    gitCommitDiffQueryOptions,
    gitRevisionContentQueryOptions,
    gitRevisionTreeQueryOptions,
    prefetchGitList,
    type QueryContext,
} from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import type { GitCommitDiffResponse } from "#bindings/GitCommitDiffResponse";
import type { GitRevisionTreeResponse } from "#bindings/GitRevisionTreeResponse";

/**
 * What the route renders for a path at a Git revision. A path the revision lacks, or a
 * revision that does not resolve, keeps the error so the banner and breadcrumbs still render.
 * A path the commit itself deleted has no tree either, but its Git view still shows the
 * deletion, like the worktree's Git view of a deleted file.
 */
function revisionData(
    target: { agent: Agent; path: string; rev: string },
    result:
        | { tree: GitRevisionTreeResponse; error: null; deletion: null }
        | { tree: null; error: null; deletion: GitCommitDiffResponse }
        | {
              tree: null;
              error: { pathError: PathLoadError | null; message: string };
              deletion: null;
          },
) {
    return {
        kind: "revision" as const,
        agentId: target.agent.id,
        path: target.path,
        rev: target.rev,
        ...result,
    };
}

/** True for committed entries the read-only editor can open. */
export function isEditableRevisionEntry(tree: GitRevisionTreeResponse) {
    return tree.entry.type === "file" && tree.entry.editable;
}

/**
 * Resolves the path at a revision and primes the view's query. Views a revision cannot
 * show fall back like the worktree's: content that is not text opens the details, and the
 * Sync view, which writes files, opens the default view.
 */
export async function loadRevision(options: {
    context: QueryContext;
    agent: Agent;
    params: { deviceName: string; _splat?: string };
    path: string;
    rev: string;
    view: BrowserSearch["view"];
    gitTab: BrowserSearch["gitTab"];
    refSort: BrowserSearch["refSort"];
    branchScope: BrowserSearch["branchScope"];
}) {
    const {
        context,
        agent,
        params,
        path,
        rev,
        view,
        gitTab,
        refSort,
        branchScope,
    } = options;

    if (view === "sync") {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params,
            search: { rev },
            replace: true,
        });
    }

    // The listing's footer shows the filesystem the repository lives on, like the worktree.
    const detailsPromise = fetchQueryUncancelled(
        context.queryClient,
        agentDetailsQueryOptions(agent),
    );

    let tree: GitRevisionTreeResponse;

    try {
        tree = await fetchQueryUncancelled(context.queryClient, {
            ...gitRevisionTreeQueryOptions(agent, path, rev),
            // A branch can move, so navigation and refresh always ask again.
            staleTime: 0,
        });
    } catch (error) {
        const pathError = getPathLoadError(error);

        const deletion =
            view === "git" && pathError?.type === "missing"
                ? await loadDeletion(options)
                : null;

        if (deletion !== null) {
            // A list tab refetches on navigation here too, like on any other revision page.
            if (gitTab !== undefined) {
                await prefetchGitList({
                    queryClient: context.queryClient,
                    agent,
                    path,
                    repositoryRoot: deletion.repository_root,
                    commitId: deletion.commit.id,
                    tab: gitTab,
                    refSort,
                    branchScope,
                });
            }

            return revisionData(options, { tree: null, error: null, deletion });
        }

        return revisionData(options, {
            tree: null,
            error: {
                pathError,
                message: getErrorMessage(error, "Failed to read the revision"),
            },
            deletion: null,
        });
    }

    await detailsPromise;

    const isDirectory = tree.entry.type === "directory";

    if (view === undefined && !isDirectory) {
        if (!isEditableRevisionEntry(tree)) {
            throw redirect({
                to: "/agents/$deviceName/browser/$",
                params,
                search: { view: "details", rev },
                replace: true,
            });
        }

        await fetchQueryUncancelled(
            context.queryClient,
            gitRevisionContentQueryOptions(agent, path, tree.commit.id),
        );
    }

    if (view === "git" && gitTab !== undefined) {
        await prefetchGitList({
            queryClient: context.queryClient,
            agent,
            path,
            repositoryRoot: tree.repository_root,
            commitId: tree.commit.id,
            tab: gitTab,
            refSort,
            branchScope,
        });
    } else if (view === "git") {
        await fetchQueryUncancelled(context.queryClient, {
            ...gitCommitDiffQueryOptions(
                agent,
                path,
                commitDiffRevision(rev, tree.commit.id),
            ),
            // A symmetric range keeps its base as typed, usually a branch such as main that
            // moves while HEAD stays put, so its merge base and diff are fetched again on
            // every navigation instead of served from a cache pinned only by HEAD.
            staleTime:
                revisionRange(rev)?.separator === "..."
                    ? 0
                    : Number.POSITIVE_INFINITY,
        });
    }

    return revisionData(options, { tree, error: null, deletion: null });
}

/**
 * Loads the commit's changes for a path missing at the revision. Only a commit that deleted
 * the path has any; for other missing paths the diff is empty and the page reports the path
 * as missing instead. A range is always shown, since a run of commits that created and then
 * deleted the path rightly adds up to no change.
 */
async function loadDeletion(options: {
    context: QueryContext;
    agent: Agent;
    path: string;
    rev: string;
}) {
    try {
        // The revision must be resolved by the agent here because no tree named its commit.
        const diff = await options.agent.gitCommitDiff(
            options.path,
            options.rev,
        );

        if (
            diff.range === null &&
            !diff.files.some((file) => file.change === "deleted")
        ) {
            return null;
        }

        // The view reads the diff by the pinned revision, like every other commit diff.
        options.context.queryClient.setQueryData(
            gitCommitDiffQueryOptions(
                options.agent,
                options.path,
                commitDiffRevision(options.rev, diff.commit.id),
            ).queryKey,
            diff,
        );

        return diff;
    } catch {
        return null;
    }
}
