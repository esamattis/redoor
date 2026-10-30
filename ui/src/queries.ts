import {
    infiniteQueryOptions,
    keepPreviousData,
    queryOptions,
    isCancelledError,
    type FetchQueryOptions,
    type InvalidateOptions,
    type Query,
    type QueryClient,
    type QueryKey,
} from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { CaseSensitivity } from "#bindings/CaseSensitivity";
import type { Agent, ApiClient } from "#ui/api-client";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { GitBranchScope } from "#bindings/GitBranchScope";
import type { GitRefSort } from "#bindings/GitRefSort";
import type {
    ManagedAgentFormConfiguration,
    ManagedAgentKind,
} from "#ui/components/managed-agent-form";
import { WorktreeStatusBatcher } from "#ui/worktree-status-batcher";

/**
 * Keeps cache refreshes from turning an otherwise valid route load into an error.
 * More than one refresh can cancel successive fetches, so a fixed retry count
 * would still occasionally surface a normal TanStack Query cancellation.
 */
export async function fetchQueryUncancelled<
    TQueryFnData,
    TError = Error,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
>(
    queryClient: QueryClient,
    options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<TData> {
    for (;;) {
        try {
            return await queryClient.fetchQuery(options);
        } catch (error) {
            if (!isCancelledError(error)) {
                throw error;
            }
        }
    }
}

/** The router context route loaders receive, which is enough to prime the query cache. */
export type QueryContext = { api: ApiClient; queryClient: QueryClient };

/**
 * Tags the editor's device text, which only the editor refetches (on focus and reload).
 * Agent-wide invalidation skips it so unrelated mutations do not download open files again.
 */
const EDITOR_BUFFER_META = { editorBuffer: true } as const;

/** Describes the filters shared by recursive path and content search keys and options. */
type RecursiveSearchParams = {
    query: string;
    timeoutSeconds: number;
    includeHidden: boolean;
    respectGitignore: boolean;
    caseSensitivity: CaseSensitivity;
};

/** Extends the shared filters with the entry-type filter only path search has. */
export type FileSearchParams = RecursiveSearchParams & {
    directoriesOnly: boolean;
};

/** Extends the shared filters with the line-oriented options only content grep has. */
export type ContentGrepParams = RecursiveSearchParams & {
    regex: boolean;
    contextSize: number;
};

/**
 * Centralizes cache keys so loaders, components, and mutations share server state.
 *
 * Everything that belongs to one agent lives under `agent(id)`, so one prefix refreshes or
 * drops a whole agent. The inventory list is deliberately a sibling (`agents()`) and not
 * the parent: refreshing the list must not mark every agent's files stale.
 */
export const queryKeys = {
    all: ["server-state"] as const,
    /** The inventory list of all agents, kept as plain `AgentInfoResponse` data. */
    agents: () => [...queryKeys.all, "agents"] as const,
    /** Prefix of every agent's subtree, for refreshing all agents at once. */
    allAgentData: () => [...queryKeys.all, "agent"] as const,
    /** Prefix of everything cached for one agent. */
    agent: (agentId: string) => [...queryKeys.allAgentData(), agentId] as const,
    agentDetails: (agentId: string) =>
        [...queryKeys.agent(agentId), "details"] as const,
    /** Editable TOML settings of a managed agent. */
    agentConfiguration: (agentId: string) =>
        [...queryKeys.agent(agentId), "configuration"] as const,
    /** Host key an SSH device presents right now, probed over the network. */
    sshHostKey: (agentId: string) =>
        [...queryKeys.agent(agentId), "ssh-host-key"] as const,
    agentLoggingLevel: (agentId: string) =>
        [...queryKeys.agent(agentId), "logging-level"] as const,
    accounts: (agentId: string) =>
        [...queryKeys.agent(agentId), "accounts"] as const,
    trash: (agentId: string) => [...queryKeys.agent(agentId), "trash"] as const,
    /** Prefix of everything addressed by a filesystem path on one agent. */
    filesystem: (agentId: string) =>
        [...queryKeys.agent(agentId), "filesystem"] as const,
    /** Prefix of every cached directory or file `ls` result of one agent. */
    browserListings: (agentId: string) =>
        [...queryKeys.filesystem(agentId), "listing"] as const,
    browserListing: (agentId: string, path: string) =>
        [...queryKeys.browserListings(agentId), path] as const,
    metadata: (agentId: string, path: string) =>
        [...queryKeys.filesystem(agentId), "metadata", path] as const,
    /** Editor bytes; their query options carry `EDITOR_BUFFER_META`. */
    fileContent: (agentId: string, path: string) =>
        [...queryKeys.filesystem(agentId), "content", path] as const,
    git: (agentId: string) => [...queryKeys.agent(agentId), "git"] as const,
    gitContext: (agentId: string, path: string) =>
        [...queryKeys.git(agentId), "context", path] as const,
    gitStatus: (agentId: string, path: string) =>
        [...queryKeys.git(agentId), "status", path] as const,
    gitDiff: (agentId: string, files: string[], mode: GitDiffMode) =>
        [...queryKeys.git(agentId), "diff", files, mode] as const,
    gitRevisionTree: (agentId: string, path: string, rev: string) =>
        [...queryKeys.git(agentId), "revision-tree", rev, path] as const,
    gitRevisionContent: (agentId: string, path: string, rev: string) =>
        [...queryKeys.git(agentId), "revision-content", rev, path] as const,
    gitCommitDiff: (agentId: string, path: string, rev: string) =>
        [...queryKeys.git(agentId), "commit-diff", rev, path] as const,
    gitCommitNeighbors: (agentId: string, path: string, rev: string) =>
        [...queryKeys.git(agentId), "commit-neighbors", rev, path] as const,
    gitLog: (agentId: string, path: string, rev: string | null) =>
        [...queryKeys.git(agentId), "log", rev, path] as const,
    gitRefs: (agentId: string, repositoryRoot: string, list: GitRefListOrder) =>
        [
            ...queryKeys.git(agentId),
            "refs",
            list.kind,
            list.kind === "branches" ? list.scope : null,
            list.sort,
            repositoryRoot,
        ] as const,
    gitWorktrees: (agentId: string, repositoryRoot: string) =>
        [...queryKeys.git(agentId), "worktrees", repositoryRoot] as const,
    gitWorktreeStatus: (agentId: string, worktreePath: string) =>
        [...queryKeys.git(agentId), "worktree-status", worktreePath] as const,
    fileSearch: (agentId: string, path: string, search: FileSearchParams) =>
        [...queryKeys.agent(agentId), "file-search", path, search] as const,
    contentGrep: (agentId: string, path: string, search: ContentGrepParams) =>
        [...queryKeys.agent(agentId), "content-grep", path, search] as const,
    transfers: () => [...queryKeys.all, "transfers"] as const,
    /** Resumable partials, rediscovered from the connected destination agents. */
    partials: () => [...queryKeys.all, "partials"] as const,
    serverInfo: () => [...queryKeys.all, "server-info"] as const,
    protocolMismatches: () =>
        [...queryKeys.all, "protocol-mismatches"] as const,
    userState: () => [...queryKeys.all, "user-state"] as const,
    /** An open file's stored editor buffer, keyed like the open files list. */
    editorBuffer: (key: string) =>
        [...queryKeys.all, "editor-buffer", key] as const,
    accessTokens: () => [...queryKeys.all, "access-tokens"] as const,
    serverLoggingLevel: () =>
        [...queryKeys.all, "server-logging-level"] as const,
};

/** Tells server mirrors, which a refresh may replace, from editor working copies. */
function isServerMirror(query: Query): boolean {
    return query.meta?.editorBuffer !== true;
}

/**
 * Marks one agent's cached data stale and refetches whatever is on screen. Mutations and
 * server events share this single entry point after changing an agent's state, so no
 * caller has to know which keys a change might touch. Editor buffers are excluded: only
 * the editor decides when its clean text may be replaced.
 */
export function invalidateAgentData(
    queryClient: QueryClient,
    agentId: string,
    options?: InvalidateOptions,
): Promise<void> {
    return queryClient.invalidateQueries(
        {
            queryKey: queryKeys.agent(agentId),
            predicate: isServerMirror,
        },
        options,
    );
}

/** Refreshes every agent's cached data when a change cannot be attributed to one agent. */
export function invalidateAllAgentData(
    queryClient: QueryClient,
): Promise<void> {
    return queryClient.invalidateQueries({
        queryKey: queryKeys.allAgentData(),
        predicate: isServerMirror,
    });
}

/**
 * How long the inventory is trusted without a refetch. Server events invalidate it, so
 * this only bounds how long a missed event can leave outdated state on screen.
 */
const AGENTS_STALE_MS = 30_000;

/** Load and uptime drift continuously, but not fast enough to refetch on every mount. */
const AGENT_DETAILS_STALE_MS = 10_000;

/** Trash changes only through user actions or other tools, so a short window is enough. */
const TRASH_STALE_MS = 5_000;

/** How often the inventory refreshes while a managed agent starts, which pushes no event. */
const MANAGED_STARTUP_POLL_MS = 1000;

/**
 * Shares the retained agent inventory between navigation and status refreshes.
 * While a managed agent is starting, its provisioning steps change without a server
 * event, so the list polls until startup settles.
 */
export function agentsQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.agents(),
        queryFn: () => api.listAgentInfos(),
        staleTime: AGENTS_STALE_MS,
        refetchInterval: (query) =>
            query.state.data?.some(
                (agent) => agent.managed && agent.status === "starting",
            )
                ? MANAGED_STARTUP_POLL_MS
                : false,
    });
}

/**
 * Resolves one agent's request client by id from the inventory cache, fetching it when absent
 * or stale. Loaders use this instead of reading a parent route's data so every route depends
 * on the query cache alone. A missing id throws `notFound()`, because the device page renders
 * one "device not found" view for a deleted device and for an unknown name alike.
 */
export async function loadAgent(
    context: QueryContext,
    agentId: string,
): Promise<Agent> {
    const infos = await fetchQueryUncancelled(
        context.queryClient,
        agentsQueryOptions(context.api),
    );

    const info = infos.find((entry) => entry.id === agentId);

    if (!info) {
        throw notFound();
    }

    return context.api.agentFor(info);
}

/**
 * Finds the device a device URL addresses. URLs carry the name because people read and type
 * them, but an exact id also matches first, the same rule the REST API follows, so a link
 * built from an id still opens the device. Names cannot look like ids, so the two never
 * collide.
 */
function findDeviceInfo(
    infos: AgentInfoResponse[],
    nameOrId: string,
): AgentInfoResponse | undefined {
    return (
        infos.find((entry) => entry.id === nameOrId) ??
        infos.find((entry) => entry.name === nameOrId)
    );
}

/**
 * Resolves the device in a device URL to its request client, so the device route can pin the
 * page to that id. A miss refetches once before giving up: the cached inventory may predate
 * a device that was just added or renamed elsewhere, and "device not found" must not be shown
 * for a device that exists. Throws `notFound()` when the server does not know the name either.
 */
export async function loadAgentByName(
    context: QueryContext,
    deviceName: string,
): Promise<Agent> {
    const cached = findDeviceInfo(
        await fetchQueryUncancelled(
            context.queryClient,
            agentsQueryOptions(context.api),
        ),
        deviceName,
    );

    const info =
        cached ??
        findDeviceInfo(
            await fetchQueryUncancelled(context.queryClient, {
                ...agentsQueryOptions(context.api),
                staleTime: 0,
            }),
            deviceName,
        );

    if (!info) {
        throw notFound();
    }

    return context.api.agentFor(info);
}

/**
 * Loads the device a device page was opened for, from the id its parent route resolved. Child
 * loaders use this instead of resolving the URL name again, so a page left open across a
 * rename keeps acting on the same device even when a child route reloads.
 */
export async function loadDeviceRouteAgent(
    context: QueryContext,
    parentMatchPromise: Promise<{ loaderData?: { deviceId: string } }>,
): Promise<Agent> {
    const deviceId = (await parentMatchPromise).loaderData?.deviceId;

    if (deviceId === undefined) {
        throw notFound();
    }

    return loadAgent(context, deviceId);
}

/**
 * Resolves an agent's request client from the cached inventory, for long-lived owners such
 * as the upload queue that run outside components and loaders. Undefined while the agent is
 * absent from the inventory.
 */
export function findCachedAgent(
    queryClient: QueryClient,
    api: ApiClient,
    agentId: string,
): Agent | undefined {
    const info = queryClient
        .getQueryData(agentsQueryOptions(api).queryKey)
        ?.find((entry) => entry.id === agentId);

    return info ? api.agentFor(info) : undefined;
}

/** Shares live agent facts (load, uptime, mounts) between route loaders and pages. */
export function agentDetailsQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.agentDetails(agent.id),
        queryFn: () => agent.getDetails(),
        staleTime: AGENT_DETAILS_STALE_MS,
    });
}

/** Shares a managed agent's TOML settings between the edit loader and its form. */
export function agentConfigurationQueryOptions(
    api: ApiClient,
    agentId: string,
    kind: ManagedAgentKind,
) {
    return queryOptions({
        queryKey: queryKeys.agentConfiguration(agentId),
        queryFn: async (): Promise<ManagedAgentFormConfiguration> =>
            kind === "local"
                ? {
                      kind,
                      value: await api.getLocalAgentConfiguration(agentId),
                  }
                : {
                      kind,
                      value: await api.getSshAgentConfiguration(agentId),
                  },
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * Probes the host key an SSH device presents. The answer is what the user confirms before
 * any credential is sent, so it is never served from cache: every confirmation step asks
 * the device again instead of trusting an earlier probe. A failed probe is not retried
 * because each attempt is a network round trip the user is waiting on.
 */
export function sshHostKeyQueryOptions(api: ApiClient, agentId: string) {
    return queryOptions({
        queryKey: queryKeys.sshHostKey(agentId),
        queryFn: () => api.getSshHostKey(agentId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/** Shares only secret-free token metadata between the settings loader and page. */
export function accessTokensQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.accessTokens(),
        queryFn: () => api.listAccessTokens(),
    });
}

/** Shares transfer state between the application shell and interactive polling. */
export function transfersQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.transfers(),
        queryFn: () => api.getTransferProgress(),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * How often a transfer someone is waiting on is rechecked between server events. The events
 * are throttled to every few seconds while bytes move, which is too coarse for a progress
 * readout or for noticing completion promptly.
 */
export const WATCHED_TRANSFER_POLL_MS = 500;

/**
 * The transfers list for a surface that follows one operation it just started. It is the same
 * cache entry the shell and `transfers_changed` use, so server events refresh it at once, and
 * a short poll fills the gaps. Retries are off so a failed read reaches the surface at once
 * instead of leaving it waiting.
 */
export function watchedTransfersQueryOptions(api: ApiClient) {
    return queryOptions({
        ...transfersQueryOptions(api),
        staleTime: 0,
        retry: false,
        refetchInterval: WATCHED_TRANSFER_POLL_MS,
        refetchIntervalInBackground: true,
    });
}

/** How often the device list rechecks for refused agents, which push no UI events. */
const PROTOCOL_MISMATCH_POLL_MS = 10_000;

/**
 * Polls refused agent connections: a mismatched agent never registers, so no refresh event
 * announces it and the list has to be fetched periodically while the page is open.
 */
export function protocolMismatchesQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.protocolMismatches(),
        queryFn: () => api.listProtocolMismatches(),
        refetchInterval: PROTOCOL_MISMATCH_POLL_MS,
    });
}

/** Shares server identity with route loaders and restart readiness checks. */
export function serverInfoQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.serverInfo(),
        queryFn: () => api.getServerInfo(),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares the effective server threshold between its route loader and runtime mutation. */
export function serverLoggingLevelQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.serverLoggingLevel(),
        queryFn: () => api.getServerLoggingLevel(),
    });
}

/** Shares one connected agent's effective threshold without mixing it into inventory. */
export function agentLoggingLevelQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.agentLoggingLevel(agent.id),
        queryFn: () => agent.getLoggingLevel(),
    });
}

/**
 * Reads a file's device text once so the loader and the editor share it.
 * Infinite staleTime keeps later fetchQuery/preload/invalidation off the wire.
 * The editor refetches it on focus and reload; Save writes the cache. It is only the device
 * side: the editor workspace decides what new device text may do to the file's buffer.
 */
export function fileContentQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.fileContent(agent.id, path),
        queryFn: async () => {
            const response = await agent.download(path);

            return response.text();
        },
        staleTime: Number.POSITIVE_INFINITY,
        meta: EDITOR_BUFFER_META,
    });
}

/** Shares one canonical browser listing so background actions can refresh its mounted view. */
export function browserListingQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.browserListing(agent.id, path),
        queryFn: () => agent.ls(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares a file's open-mode facts and download tokens between its loader and detail views. */
export function metadataQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.metadata(agent.id, path),
        queryFn: () => agent.metadata(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares repository discovery between the loader and conditional browser tabs. */
export function gitContextQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.gitContext(agent.id, path),
        queryFn: () => agent.gitContext(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares one bounded directory status result with route preloading. */
export function gitStatusQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.gitStatus(agent.id, path),
        queryFn: () => agent.gitStatus(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Keeps ordered full and staged file comparisons in distinct cache entries. */
export function gitDiffQueryOptions(
    agent: Agent,
    files: string[],
    mode: GitDiffMode,
) {
    return queryOptions({
        queryKey: queryKeys.gitDiff(agent.id, files, mode),
        queryFn: () => agent.gitDiff(files, mode),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** The most files one diff request may name, matching the server's `GitDiffRequest::MAX_FILES`. */
const GIT_DIFF_MAX_FILES = 128;

/** Which files of a diff list to fetch, and in which comparison mode. */
type GitDiffBatchOptions = {
    queryClient: QueryClient;
    agent: Agent;
    files: string[];
    mode: GitDiffMode;
};

/**
 * Fetches many files' comparisons in as few requests as the server accepts and files each
 * result under that file's own single-file diff query, the one a file fetches when it is
 * expanded alone. A file's cached diff stays on screen while it is refetched.
 */
function fetchGitDiffBatches(options: GitDiffBatchOptions, staleTime: number) {
    for (
        let start = 0;
        start < options.files.length;
        start += GIT_DIFF_MAX_FILES
    ) {
        const batch = options.files.slice(start, start + GIT_DIFF_MAX_FILES);
        const response = options.agent.gitDiff(batch, options.mode);

        batch.forEach((path, index) => {
            void options.queryClient.prefetchQuery({
                ...gitDiffQueryOptions(options.agent, [path], options.mode),
                staleTime,
                // The response keeps the request order, so the file's position finds its diff.
                queryFn: async () => {
                    const diff = (await response).diffs[index];

                    return { diffs: diff === undefined ? [] : [diff] };
                },
            });
        });
    }
}

/** Reads the cache state of one file's single-file diff query. */
function gitDiffQueryState(options: GitDiffBatchOptions, path: string) {
    return options.queryClient.getQueryState(
        queryKeys.gitDiff(options.agent.id, [path], options.mode),
    );
}

/**
 * Fetches the diffs of files not cached yet in batches. Files already cached or loading are
 * skipped, so expanding every file after opening a few requests only the rest, and the
 * expanded files then find their diffs loading instead of each starting a request of its own.
 */
export function prefetchGitDiffs(options: GitDiffBatchOptions) {
    const missing = options.files.filter((path) => {
        const state = gitDiffQueryState(options, path);

        return state?.data === undefined && state?.fetchStatus !== "fetching";
    });

    fetchGitDiffBatches(
        { ...options, files: missing },
        Number.POSITIVE_INFINITY,
    );
}

/**
 * Refetches the cached diffs of the given files in batches. Worktree diffs never go stale on
 * their own, so without this, coming back to a list after editing a file would show its patch
 * from before the edit. Only cached files are refetched, because a file without a cached diff
 * fetches it when it is expanded, and the cached patches stay on screen meanwhile, so the
 * list keeps the height the restored scroll position was measured in until the new ones land.
 */
export function refreshCachedGitDiffs(options: GitDiffBatchOptions) {
    const cached = options.files.filter((path) => {
        const state = gitDiffQueryState(options, path);

        return state?.data !== undefined && state.fetchStatus !== "fetching";
    });

    fetchGitDiffBatches({ ...options, files: cached }, 0);
}

/**
 * Shares a path's committed tree entry between the route loader and revision views. A
 * branch name can move, so a refresh still refetches it, but nothing else needs to.
 */
export function gitRevisionTreeQueryOptions(
    agent: Agent,
    path: string,
    rev: string,
) {
    return queryOptions({
        queryKey: queryKeys.gitRevisionTree(agent.id, path, rev),
        queryFn: () => agent.gitRevisionTree(path, rev),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * Committed text for the read-only editor, primed by the loader like worktree content. It is
 * keyed by the commit id the tree resolved, never by a branch name: a branch can move while
 * this stays cached, which would show old text under the new commit's banner.
 */
export function gitRevisionContentQueryOptions(
    agent: Agent,
    path: string,
    commitId: string,
) {
    return queryOptions({
        queryKey: queryKeys.gitRevisionContent(agent.id, path, commitId),
        queryFn: async () => {
            const response = await agent.gitRevisionContent(path, commitId);

            return response.content;
        },
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * The changes of a commit or a range, scoped to the browsed path. Keyed by the revision
 * `commitDiffRevision` pins to the resolved commit, like the content, so the cached diff can
 * never belong to an older commit than the banner shows.
 */
export function gitCommitDiffQueryOptions(
    agent: Agent,
    path: string,
    diffRevision: string,
) {
    return queryOptions({
        queryKey: queryKeys.gitCommitDiff(agent.id, path, diffRevision),
        queryFn: () => agent.gitCommitDiff(path, diffRevision),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * The commits before and after a commit in the path's history. Unlike the diff it is not
 * cached for good: the newer commit is found from HEAD, which moves with every commit.
 */
export function gitCommitNeighborsQueryOptions(
    agent: Agent,
    path: string,
    commitId: string,
) {
    return queryOptions({
        queryKey: queryKeys.gitCommitNeighbors(agent.id, path, commitId),
        queryFn: () => agent.gitCommitNeighbors(path, commitId),
    });
}

/** Rows per page of the Git history, branch and tag lists; more load on request. */
export const GIT_LIST_PAGE_SIZE = 100;

/** Names the two ref listings the Git view offers. */
export type GitRefListKind = "branches" | "tags";

/**
 * Which ref listing to read and in which order, kept together because both pick the rows.
 * Only branches have a scope, since tags are never remote-tracking.
 */
export type GitRefListOrder =
    | { kind: "branches"; scope: GitBranchScope; sort: GitRefSort }
    | { kind: "tags"; sort: GitRefSort };

/**
 * The commits that changed a path, a page at a time. `rev` is a resolved commit id, never a
 * branch name or HEAD, for the same reason the commit diff is keyed by id: every page then
 * walks the same history even if a branch moves between pages, and a moved HEAD is a new
 * query. `null` is only for a branch without commits, which has no history to page through.
 */
export function gitLogQueryOptions(
    agent: Agent,
    path: string,
    rev: string | null,
) {
    return infiniteQueryOptions({
        queryKey: queryKeys.gitLog(agent.id, path, rev),
        queryFn: (context) =>
            agent.gitLog(path, {
                rev,
                skip: context.pageParam,
                limit: GIT_LIST_PAGE_SIZE,
            }),
        initialPageParam: 0,
        getNextPageParam: (lastPage, allPages) =>
            lastPage.has_more
                ? allPages.reduce(
                      (count, page) => count + page.commits.length,
                      0,
                  )
                : undefined,
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * The repository's branches or tags, a page at a time, most recently committed first or by
 * name. The agent sorts, because pages are offsets into one order. They are asked for at
 * the repository root the page resolved, because a path inside a nested repository, such as
 * a submodule browsed at a superproject commit, would list the nested repository's refs
 * instead.
 */
export function gitRefsQueryOptions(
    agent: Agent,
    repositoryRoot: string,
    list: GitRefListOrder,
) {
    return infiniteQueryOptions({
        queryKey: queryKeys.gitRefs(agent.id, repositoryRoot, list),
        queryFn: (context) =>
            agent.gitRefs(repositoryRoot, list.kind, {
                sort: list.sort,
                scope: list.kind === "branches" ? list.scope : undefined,
                skip: context.pageParam,
                limit: GIT_LIST_PAGE_SIZE,
            }),
        initialPageParam: 0,
        getNextPageParam: (lastPage, allPages) =>
            lastPage.has_more
                ? allPages.reduce((count, page) => count + page.refs.length, 0)
                : undefined,
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * Every checkout of the repository, main first and then the most recently active. Asked for
 * at the repository root the page resolved, like the refs, and refetched on navigation
 * because checkouts change under the page.
 */
export function gitWorktreesQueryOptions(agent: Agent, repositoryRoot: string) {
    return queryOptions({
        queryKey: queryKeys.gitWorktrees(agent.id, repositoryRoot),
        queryFn: () => agent.gitWorktrees(repositoryRoot),
    });
}

/**
 * The uncommitted change counts of one checkout in the worktree list. Each row has its own
 * query so the list shows before every checkout has been walked, while the batcher sends the
 * rows that ask together as one request, so a long list takes a single browser connection.
 * The signal lets leaving the list cancel the request and the agent's walks.
 */
export function gitWorktreeStatusQueryOptions(
    agent: Agent,
    worktreePath: string,
) {
    return queryOptions({
        queryKey: queryKeys.gitWorktreeStatus(agent.id, worktreePath),
        queryFn: (context) =>
            WorktreeStatusBatcher.forAgent(agent).load(
                worktreePath,
                context.signal,
            ),
    });
}

/**
 * Primes the first page of the Git list a route is about to show. Failures stay in the
 * query, so the list reports them inside its tab instead of failing the whole page. Refs
 * and worktrees move, so navigation refetches them; history is keyed by commit id and never
 * changes.
 */
export async function prefetchGitList(options: {
    queryClient: QueryClient;
    agent: Agent;
    path: string;
    repositoryRoot: string;
    /** The commit history starts at: the browsed commit, or HEAD in the worktree. */
    commitId: string | null;
    tab: "commits" | "worktrees" | GitRefListKind;
    /** The order of a branch or tag list; absent is the default recent order. */
    refSort: GitRefSort | undefined;
    /** Which branches the branch list shows; absent is the default local branches. */
    branchScope: "local" | "remote" | undefined;
}) {
    const { queryClient, agent, path, repositoryRoot, commitId, tab } = options;

    if (tab === "commits") {
        await queryClient.prefetchInfiniteQuery({
            ...gitLogQueryOptions(agent, path, commitId),
            staleTime: commitId === null ? 0 : Number.POSITIVE_INFINITY,
        });
    } else if (tab === "worktrees") {
        await queryClient.prefetchQuery({
            ...gitWorktreesQueryOptions(agent, repositoryRoot),
            staleTime: 0,
        });
    } else {
        const sort = options.refSort ?? "recent";

        await queryClient.prefetchInfiniteQuery({
            ...gitRefsQueryOptions(
                agent,
                repositoryRoot,
                tab === "branches"
                    ? {
                          kind: tab,
                          scope: options.branchScope ?? "local",
                          sort,
                      }
                    : { kind: tab, sort },
            ),
            staleTime: 0,
        });
    }
}

/** Shares one agent-scoped account catalog so path changes reuse the same query. */
export function agentAccountsQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.accounts(agent.id),
        queryFn: () => agent.accounts(),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares fresh trash inventory between route navigation and restore mutations. */
export function trashQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.trash(agent.id),
        queryFn: () => agent.listTrash(),
        staleTime: TRASH_STALE_MS,
    });
}

/** Cancels obsolete recursive searches while retaining results during a new request. */
export function fileSearchQueryOptions(
    agent: Agent,
    path: string,
    search: FileSearchParams,
) {
    return queryOptions({
        queryKey: queryKeys.fileSearch(agent.id, path, search),
        queryFn: ({ signal }) =>
            agent.searchFiles(path, search.query, {
                timeoutSeconds: search.timeoutSeconds,
                includeHidden: search.includeHidden,
                respectGitignore: search.respectGitignore,
                caseSensitivity: search.caseSensitivity,
                directoriesOnly: search.directoriesOnly,
                signal,
            }),
        enabled: search.query.trim() !== "",
        placeholderData: keepPreviousData,
    });
}

/** Cancels superseded content searches and keeps prior matches visible while replacing them. */
export function contentGrepQueryOptions(
    agent: Agent,
    path: string,
    search: ContentGrepParams,
) {
    return queryOptions({
        queryKey: queryKeys.contentGrep(agent.id, path, search),
        queryFn: ({ signal }) =>
            agent.grepContent(path, search.query, {
                timeoutSeconds: search.timeoutSeconds,
                includeHidden: search.includeHidden,
                respectGitignore: search.respectGitignore,
                fixedString: !search.regex,
                caseSensitivity: search.caseSensitivity,
                beforeContext: search.contextSize,
                afterContext: search.contextSize,
                signal,
            }),
        enabled: search.query.trim() !== "",
        placeholderData: keepPreviousData,
    });
}

/** Polling also rediscovers partials when a destination reconnects after a crash. */
export function partialsQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.partials(),
        queryFn: () => api.listPartials(),
        refetchInterval: 5000,
    });
}
