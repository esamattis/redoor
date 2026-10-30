import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
    createFileRoute,
    redirect,
    retainSearchParams,
    useRouter,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { agentStartStatesAtom } from "#ui/agent-start-state";
import { type ApiClient, type Agent } from "#ui/api-client";
import type { LsDirectoryResponse } from "#bindings/LsDirectoryResponse";
import type { LsFileResponse } from "#bindings/LsFileResponse";
import type { LsEntry } from "#bindings/LsEntry";
import {
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsResponse,
} from "#ui/ls-response";
import {
    browserLineSchema,
    browserSearchSchema,
    type BrowserSearch,
    type FileSortColumn,
} from "#ui/browser-search";
import { optionalBooleanSchema } from "#ui/agent-search";
import { useUserState } from "#ui/user-state";
import { AgentLifecycle } from "#ui/components/agent-lifecycle";
import { RouteError } from "#ui/components/route-error";
import {
    BrowserHeader,
    UnavailablePathState,
    gitTabHead,
    type BrowserView,
    type GitTabHead,
} from "#ui/components/browser/navigation";
import { ViewToolbarSlotProvider } from "#ui/components/browser/view-toolbar-slot";
import { MissingPathCreationForm } from "#ui/components/browser/missing-path";
import { DirectoryFilesActions } from "#ui/components/browser/directory-actions";
import { SelectedFilesCard } from "#ui/components/browser/selected-files-card";
import { FileList } from "#ui/components/browser/file-list";
import { WaitingUploads } from "#ui/components/browser/upload-queue";
import {
    DirectoryDetailView,
    FileDetailView,
} from "#ui/components/browser/metadata";
import { RevisionDetailView } from "#ui/components/browser/revision-details";
import { SyncView } from "#ui/components/browser/sync";
import { GitDirectoryView, GitFileView } from "#ui/components/browser/git";
import { GitView, WorktreeGitView } from "#ui/components/browser/git-view";
import { FileEditView, FileImageView } from "#ui/components/browser/file-views";
import {
    GitCommitView,
    RevisionBanner,
    RevisionListingNotice,
    revisionListing,
    revisionListingEntries,
    type RevisionListing,
} from "#ui/components/browser/revision";
import {
    getImmediateParentPath,
    getPathLoadError,
    sortFileEntries,
    type FileSort,
    type PathLoadError,
} from "#ui/components/browser/utils";
import {
    agentAccountsQueryOptions,
    agentDetailsQueryOptions,
    browserListingQueryOptions,
    fetchQueryUncancelled,
    fileContentQueryOptions,
    gitContextQueryOptions,
    loadDeviceRouteAgent,
    metadataQueryOptions,
    queryKeys,
} from "#ui/queries";
import { useAgents, useRequiredAgent } from "#ui/use-agents";
import { invalidateDeviceViews } from "#ui/use-active-agent";
import { useBrowserRefreshTriggers } from "#ui/components/browser/refresh";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { MountPoint } from "#bindings/MountPoint";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import {
    isEditableRevisionEntry,
    loadRevision,
} from "#ui/browser-revision-loader";
import { prefetchWorktreeGitView } from "#ui/browser-git-loader";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import { getBaseName } from "#ui/utils/path";

/** Reads line from the raw query so the loader can preserve it without adding line to loaderDeps. */
function lineFromLocationSearch(searchStr: string): number | undefined {
    const params = new URLSearchParams(
        searchStr.startsWith("?") ? searchStr.slice(1) : searchStr,
    );

    const value = params.get("line");

    return value === null ? undefined : browserLineSchema.parse(value);
}

/** The route's own parameters, which every redirect needs to stay on the same entry. */
type BrowserParams = { deviceName: string; _splat?: string };

/** What the route knows while its agent cannot serve paths yet, so only the URL is retained. */
function lifecycleData(agent: Agent, path: string) {
    return {
        kind: "lifecycle" as const,
        agentId: agent.id,
        path,
        lsResult: null,
    };
}

/** What the route renders for a path that resolved to a file or a directory. */
function resolvedData(agent: Agent, path: string, lsResult: LsResponse) {
    return {
        kind: "connected" as const,
        agentId: agent.id,
        path,
        lsResult,
        pathError: null,
    };
}

/**
 * What the route renders for a path that did not resolve. It carries the error and no
 * listing, so breadcrumbs stay available to correct the path.
 */
function unresolvedData(agent: Agent, path: string, pathError: PathLoadError) {
    return {
        kind: "connected" as const,
        agentId: agent.id,
        path,
        lsResult: null,
        pathError,
    };
}

/** Leaves the Git view of a path that is outside every repository, which has nothing to show. */
function redirectOutsideWorktree(
    params: BrowserParams,
    view: BrowserSearch["view"],
    gitContext: GitContextResponse,
) {
    if (view === "git" && gitContext.status === "outside_worktree") {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params,
            search: {},
            replace: true,
        });
    }
}

export const Route = createFileRoute("/_app/agents/$deviceName/browser/$")({
    validateSearch: browserSearchSchema,
    // Every link into the browser keeps the browsed revision, so the tree, details and diffs
    // of history can be navigated like the worktree. Leaving history removes it explicitly.
    // The full-window editor is kept the same way, so switching open files stays in it.
    search: { middlewares: [retainSearchParams(["rev", "fullWindow"])] },
    loaderDeps: ({ search }) => ({
        view: search.view,
        diffMode: search.diffMode,
        rev: search.rev,
        gitTab: search.gitTab,
        refSort: search.refSort,
        branchScope: search.branchScope,
    }),
    loader: async ({ context, deps, params, location, parentMatchPromise }) => {
        const agent = await loadDeviceRouteAgent(context, parentMatchPromise);
        const path = `/${params._splat ?? ""}`;

        if (agent.status !== "connected" || agent.cwd === null) {
            // Retain the full URL until the agent connects and the path can be resolved.
            return lifecycleData(agent, path);
        }

        const rawSearch = new URLSearchParams(
            location.searchStr.startsWith("?")
                ? location.searchStr.slice(1)
                : location.searchStr,
        );

        if (rawSearch.has("diff")) {
            throw redirect({
                to: "/agents/$deviceName/browser/$",
                params,
                search: {
                    view: deps.view,
                    line: lineFromLocationSearch(location.searchStr),
                },
                replace: true,
            });
        }

        if (deps.rev !== undefined) {
            // The view, Git tab and ref order come along with the narrowed revision.
            return loadRevision({
                context,
                agent,
                params,
                path,
                ...deps,
                rev: deps.rev,
            });
        }

        const gitContextPromise = fetchQueryUncancelled(context.queryClient, {
            ...gitContextQueryOptions(agent, path),
            staleTime: 0,
        });

        // Mount points label the listing's capacity footer.
        const detailsPromise = fetchQueryUncancelled(
            context.queryClient,
            agentDetailsQueryOptions(agent),
        );

        const listingPromise = fetchQueryUncancelled(context.queryClient, {
            ...browserListingQueryOptions(agent, path),
            // Route invalidation is an explicit refresh even if the mounted listing is retained.
            staleTime: 0,
        });

        // Missing paths still resolve the route so breadcrumbs stay available for correction.
        try {
            const [gitContext, lsResult] = await Promise.all([
                gitContextPromise,
                listingPromise,
                detailsPromise,
            ]);

            redirectOutsideWorktree(params, deps.view, gitContext);

            // Canonicalize the cache identity so aliases refresh the listing the route actually displays.
            context.queryClient.setQueryData(
                queryKeys.browserListing(agent.id, lsResult.path),
                lsResult,
            );

            const metadata = isLsFileResponse(lsResult)
                ? await fetchQueryUncancelled(context.queryClient, {
                      ...metadataQueryOptions(agent, lsResult.path),
                      staleTime: 0,
                  })
                : null;

            if (isLsFileResponse(lsResult)) {
                replaceUnsupportedFileView(params, deps.view, metadata);
                replaceDefaultMarkdownPreview({
                    params,
                    view: deps.view,
                    filePath: lsResult.path,
                    metadata,
                    line: lineFromLocationSearch(location.searchStr),
                    preview: optionalBooleanSchema.parse(
                        rawSearch.get("preview"),
                    ),
                    currentSearch: location.search,
                });

                if (
                    wantsFileContentView(deps.view) &&
                    metadata?.editable === true
                ) {
                    await fetchQueryUncancelled(
                        context.queryClient,
                        fileContentQueryOptions(agent, lsResult.path),
                    );
                }
            }

            if (deps.view === "details" && agent.isRoot) {
                await fetchQueryUncancelled(
                    context.queryClient,
                    agentAccountsQueryOptions(agent),
                );
            }

            if (
                deps.view === "git" &&
                gitContext.status === "inside_worktree"
            ) {
                await prefetchWorktreeGitView({
                    context,
                    agent,
                    path: lsResult.path,
                    isDirectory: isLsDirectoryResponse(lsResult),
                    gitContext,
                    deps,
                });
            }

            return resolvedData(agent, path, lsResult);
        } catch (error) {
            const pathError = getPathLoadError(error);

            if (!pathError) {
                throw error;
            }

            const [gitContext] = await Promise.all([
                gitContextPromise,
                detailsPromise,
            ]);

            if (
                deps.view === "git" &&
                gitContext.status === "inside_worktree" &&
                gitContext.entry_type === "missing" &&
                gitContext.tracking_state === "deleted"
            ) {
                await prefetchWorktreeGitView({
                    context,
                    agent,
                    path,
                    isDirectory: false,
                    gitContext,
                    deps,
                });

                return unresolvedData(agent, path, pathError);
            }

            redirectOutsideWorktree(params, deps.view, gitContext);

            return unresolvedData(agent, path, pathError);
        }
    },
    component: FileBrowser,
    errorComponent: RouteError,
});

/** Fixes browser navigation chrome in one route-level frame for every path type and view. */
function BrowserRouteShell(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    entryType: "directory" | "file";
    activeView: BrowserView;
    /** What the Git tab names, or null to hide it outside a worktree. */
    gitHead: GitTabHead | null;
    editable?: boolean;
    /** Bounds the route to the overlay viewport so CodeMirror, not the page, scrolls. */
    fillAvailableHeight?: boolean;
    pathUnavailable?: boolean;
    startEditingPath?: boolean;
    /** Shown under the breadcrumbs, such as the browsed Git revision. */
    banner?: ReactNode;
    readOnly?: boolean;
    children: ReactNode;
}) {
    return (
        // The header and the view are siblings, so the toolbar slot they share sits above both.
        <ViewToolbarSlotProvider>
            <div
                className={
                    props.fillAvailableHeight === true
                        ? "absolute inset-x-0 top-[var(--top-chrome-height,0px)] bottom-[var(--bottom-chrome-height,0px)] flex min-h-0 flex-col overflow-hidden p-2 @4xl:p-4"
                        : "flex min-h-full flex-col p-2 @4xl:p-4"
                }
            >
                <BrowserHeader
                    agent={props.agent}
                    path={props.path}
                    parentPath={props.parentPath}
                    entryType={props.entryType}
                    activeView={props.activeView}
                    editable={props.editable}
                    gitHead={props.gitHead}
                    pathUnavailable={props.pathUnavailable}
                    startEditingPath={props.startEditingPath}
                    banner={props.banner}
                    readOnly={props.readOnly}
                />
                <div
                    className={
                        props.fillAvailableHeight === true
                            ? "-mx-2 -mb-2 flex min-h-0 flex-1 flex-col overflow-hidden @4xl:-mx-4 @4xl:-mb-4"
                            : "-mx-2 -mb-2 @4xl:-mx-4 @4xl:-mb-4"
                    }
                >
                    {props.children}
                </div>
            </div>
        </ViewToolbarSlotProvider>
    );
}

/**
 * Shows connection controls at the bookmarked URL until filesystem commands are available.
 * Availability follows the live inventory, so a disconnect swaps the view immediately and a
 * reconnect resolves the path again instead of waiting for a reload event.
 */
function FileBrowser() {
    const data = Route.useLoaderData();
    const router = useRouter();
    const agent = useRequiredAgent(data.agentId);
    const isAvailable = agent.status === "connected" && agent.cwd !== null;
    const needsResolution = isAvailable && data.kind === "lifecycle";

    useEffect(() => {
        // The loader found the agent offline, so it resolved no path. Run it again now that
        // the agent can serve one, which also applies the path-dependent redirects.
        if (needsResolution) {
            void invalidateDeviceViews(router);
        }
    }, [needsResolution, router]);

    if (!isAvailable) {
        return <AgentLifecycle agent={agent} preserveDestination />;
    }

    if (data.kind === "lifecycle") {
        return (
            <p role="status" className="p-8 text-sm text-slate-400">
                Opening path...
            </p>
        );
    }

    if (data.kind === "revision") {
        return <RevisionFileBrowser data={data} agent={agent} />;
    }

    return <ConnectedFileBrowser data={data} agent={agent} />;
}

/** The revision banner already names the browsed commit, so the Git tab keeps a plain label. */
const revisionGitHead: GitTabHead = { type: "revision" };

/**
 * Browses a path as committed at a Git revision. Everything is read-only: the listing has
 * no file operations, the editor cannot save, and the Git view shows the commit's changes.
 */
function RevisionFileBrowser(props: {
    data: Extract<ReturnType<typeof Route.useLoaderData>, { kind: "revision" }>;
    agent: Agent;
}) {
    const data = props.data;
    const agent = props.agent;
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    useBrowserRefreshTriggers(agent.id);

    const parentPath = getImmediateParentPath(data.path);

    const banner = (
        <RevisionBanner
            agent={agent}
            path={data.path}
            rev={data.rev}
            commit={data.tree?.commit ?? data.deletion?.commit ?? null}
        />
    );

    if (data.deletion !== null) {
        const deletesOneFile =
            data.deletion.files.length === 1 &&
            data.deletion.files[0]?.path === data.path;

        return (
            <BrowserRouteShell
                agent={agent}
                path={data.path}
                parentPath={parentPath}
                entryType={deletesOneFile ? "file" : "directory"}
                activeView="git"
                gitHead={revisionGitHead}
                banner={banner}
                readOnly
            >
                <GitView
                    agent={agent}
                    path={data.path}
                    tab={search.gitTab}
                    repository={{
                        root: data.deletion.repository_root,
                        relativePath: data.deletion.repository_relative_path,
                    }}
                    reference={{
                        type: "revision",
                        rev: data.rev,
                        commit: data.deletion.commit,
                    }}
                    changes={
                        <GitCommitView
                            agent={agent}
                            path={data.path}
                            rev={data.rev}
                            commitId={data.deletion.commit.id}
                        />
                    }
                />
            </BrowserRouteShell>
        );
    }

    if (data.tree === null) {
        const pathError = data.error.pathError;

        return (
            <BrowserRouteShell
                agent={agent}
                path={data.path}
                parentPath={parentPath}
                entryType="directory"
                activeView="files"
                gitHead={revisionGitHead}
                pathUnavailable
                startEditingPath={false}
                banner={banner}
                readOnly
            >
                {pathError === null ? (
                    <p
                        role="alert"
                        className="m-2 rounded-lg border border-red-900/60 bg-red-950/20 p-4 text-sm text-red-200 @4xl:m-4"
                    >
                        {data.error.message}
                    </p>
                ) : (
                    <UnavailablePathState
                        agent={agent}
                        path={data.path}
                        parentPath={parentPath}
                        error={pathError}
                    />
                )}
            </BrowserRouteShell>
        );
    }

    const tree = data.tree;
    const isDirectory = tree.entry.type === "directory";
    const editable = isEditableRevisionEntry(tree);

    const activeView: BrowserView =
        search.view ?? (isDirectory ? "files" : "view");

    const isEditView = activeView === "view" && editable;
    const fileName = getBaseName(data.path);

    const content =
        activeView === "git" ? (
            <GitView
                agent={agent}
                path={data.path}
                tab={search.gitTab}
                repository={{
                    root: tree.repository_root,
                    relativePath: tree.repository_relative_path,
                }}
                reference={{
                    type: "revision",
                    rev: data.rev,
                    commit: tree.commit,
                }}
                changes={
                    <GitCommitView
                        agent={agent}
                        path={data.path}
                        rev={data.rev}
                        commitId={tree.commit.id}
                    />
                }
            />
        ) : activeView === "details" ? (
            <RevisionDetailView agent={agent} tree={tree} />
        ) : tree.entry.type === "directory" ? (
            <>
                <RevisionListingNotice entry={tree.entry} />
                <DirectoryListing
                    agent={agent}
                    directoryPath={tree.path}
                    files={revisionListingEntries(tree.entry.entries)}
                    revision={revisionListing(tree.commit.id, tree.entry)}
                />
            </>
        ) : editable ? (
            <FileEditView
                key={`${agent.id}:${tree.commit.id}:${data.path}`}
                agent={agent}
                fileName={fileName}
                filePath={data.path}
                revision={tree.commit.id}
                repositoryRoot={tree.repository_root}
                mimeType="text/plain"
                downloadUrl={agent.getGitDownloadUrl(data.path, tree.commit.id)}
                scrollToLine={search.line}
                preview={search.preview === true}
                onPreviewChange={(preview) =>
                    navigate({
                        search: (previous) => ({ ...previous, preview }),
                    })
                }
            />
        ) : (
            <RevisionDetailView agent={agent} tree={tree} />
        );

    return (
        <BrowserRouteShell
            agent={agent}
            path={data.path}
            parentPath={parentPath}
            entryType={isDirectory ? "directory" : "file"}
            activeView={activeView}
            editable={editable}
            gitHead={revisionGitHead}
            fillAvailableHeight={isEditView}
            banner={banner}
            readOnly
        >
            {content}
        </BrowserRouteShell>
    );
}

/** Mounts filesystem subscriptions only after the agent can serve the requested path. */
function ConnectedFileBrowser(props: {
    data: Extract<
        ReturnType<typeof Route.useLoaderData>,
        { kind: "connected" }
    >;
    agent: Agent;
}) {
    const data = props.data;
    const agent = props.agent;
    const setStartStates = useSetAtom(agentStartStatesAtom);
    useEffect(() => {
        // Completing startup here must not leave a later disconnect showing optimistic progress.
        setStartStates((states) => {
            if (!states[data.agentId]) return states;
            const next = { ...states };
            delete next[data.agentId];

            return next;
        });
    }, [data.agentId, setStartStates]);
    const { api } = Route.useRouteContext();
    const { path, lsResult, pathError } = data;
    const search = Route.useSearch();
    const diffMode = useGitDiffMode();
    useBrowserRefreshTriggers(agent.id);

    // The loader primed this, and refreshes replace it in place without reloading the route.
    const { data: gitContext } = useSuspenseQuery(
        gitContextQueryOptions(agent, path),
    );

    const parentPath = getImmediateParentPath(path);
    const gitHead = gitTabHead(gitContext);

    if (
        pathError?.type === "missing" &&
        search.view === "git" &&
        gitContext.status === "inside_worktree" &&
        gitContext.entry_type === "missing" &&
        gitContext.tracking_state === "deleted"
    ) {
        return (
            <BrowserRouteShell
                agent={agent}
                path={path}
                parentPath={parentPath}
                entryType="file"
                activeView="git"
                gitHead={gitHead}
            >
                <WorktreeGitView
                    agent={agent}
                    path={path}
                    tab={search.gitTab}
                    context={gitContext}
                    changes={
                        <GitFileView
                            agent={agent}
                            path={path}
                            context={gitContext}
                            mode={diffMode.mode}
                            onModeChange={diffMode.setMode}
                        />
                    }
                />
            </BrowserRouteShell>
        );
    }

    if (pathError) {
        return (
            <BrowserRouteShell
                agent={agent}
                path={path}
                parentPath={parentPath}
                entryType="directory"
                activeView="files"
                gitHead={gitHead}
                pathUnavailable
                startEditingPath={pathError.type !== "missing"}
            >
                {pathError.type === "missing" ? (
                    <MissingPathCreationForm
                        key={path}
                        agent={agent}
                        path={path}
                    />
                ) : (
                    <UnavailablePathState
                        agent={agent}
                        path={path}
                        parentPath={parentPath}
                        error={pathError}
                    />
                )}
            </BrowserRouteShell>
        );
    }

    if (lsResult !== null && isLsDirectoryResponse(lsResult)) {
        return (
            <DirectoryBrowserPage
                api={api}
                agent={agent}
                path={path}
                parentPath={parentPath}
                loadedListing={lsResult}
                gitContext={gitContext}
            />
        );
    }

    if (lsResult !== null && isLsFileResponse(lsResult)) {
        return (
            <FileBrowserPage
                api={api}
                agent={agent}
                path={path}
                parentPath={parentPath}
                loadedListing={lsResult}
                gitContext={gitContext}
            />
        );
    }

    return null;
}

/**
 * Keeps the Git comparison in the URL: the loader reads it to prefetch the right diff, and
 * switching it replaces the history entry because it is a view of the same page. Full is the
 * default, so it is omitted from the URL.
 */
function useGitDiffMode() {
    const navigate = Route.useNavigate();
    const search = Route.useSearch();

    return {
        mode: search.diffMode ?? "full",
        setMode: (mode: GitDiffMode) =>
            navigate({
                search: (previous) => ({
                    ...previous,
                    diffMode: mode === "full" ? undefined : mode,
                }),
                replace: true,
            }),
    };
}

/**
 * Reads the listing the loader resolved from the query cache, so a refresh or an edit made
 * elsewhere reaches the page without reloading the route. The loader's copy only identifies
 * the entry and covers the moment before the cache has anything newer.
 */
function useLiveListing<T extends LsResponse>(
    agent: Agent,
    loaded: T,
    isExpected: (listing: LsResponse) => listing is T,
): T {
    const { data } = useQuery(browserListingQueryOptions(agent, loaded.path));

    return data !== undefined && isExpected(data) ? data : loaded;
}

/** Picks the view for one file from its live metadata, which shares the route's cache. */
function FileBrowserPage(props: {
    api: ApiClient;
    agent: Agent;
    path: string;
    parentPath: string | null;
    loadedListing: LsFileResponse;
    gitContext: GitContextResponse;
}) {
    const agent = props.agent;
    const path = props.path;
    const navigate = Route.useNavigate();
    const search = Route.useSearch();
    const diffMode = useGitDiffMode();
    const agents = useAgents();

    const lsResult = useLiveListing(
        agent,
        props.loadedListing,
        isLsFileResponse,
    );

    const { data: metadata } = useSuspenseQuery(
        metadataQueryOptions(agent, lsResult.path),
    );

    const fileName = getBaseName(path);
    const downloadUrl = agent.getRawUrl(lsResult.path);
    const editable = metadata.editable;
    const viewableImage = metadata.viewable_image;

    // A file's default representation is its content, named "view" in the tab strip.
    const activeView = search.view ?? "view";
    const isEditView = activeView === "view" && editable;

    const content =
        activeView === "git" ? (
            <WorktreeGitView
                agent={agent}
                path={lsResult.path}
                tab={search.gitTab}
                context={props.gitContext}
                changes={
                    <GitFileView
                        agent={agent}
                        path={lsResult.path}
                        context={props.gitContext}
                        mode={diffMode.mode}
                        onModeChange={diffMode.setMode}
                    />
                }
            />
        ) : activeView === "sync" ? (
            <SyncView
                key={`${agent.id}:${lsResult.path}`}
                api={props.api}
                sourceAgent={agent}
                agents={agents}
                sourcePath={lsResult.path}
                entryType="file"
            />
        ) : activeView === "view" && editable ? (
            <FileEditView
                key={`${agent.id}:${lsResult.path}`}
                agent={agent}
                fileName={fileName}
                filePath={lsResult.path}
                repositoryRoot={
                    props.gitContext.status === "inside_worktree"
                        ? props.gitContext.repository_root
                        : null
                }
                mimeType={metadata.mime_type}
                downloadUrl={agent.getRawUrl(lsResult.path, {
                    download: true,
                })}
                scrollToLine={search.line}
                preview={search.preview === true}
                onPreviewChange={(preview) =>
                    navigate({
                        search: (previous) => ({
                            ...previous,
                            preview,
                        }),
                    })
                }
            />
        ) : activeView === "view" && viewableImage ? (
            <FileImageView
                agent={agent}
                path={path}
                fileName={fileName}
                downloadUrl={downloadUrl}
            />
        ) : (
            <FileDetailView
                key={lsResult.path}
                agent={agent}
                path={path}
                fileName={fileName}
                lsResult={lsResult}
                downloadUrl={downloadUrl}
            />
        );

    return (
        <BrowserRouteShell
            agent={agent}
            path={path}
            parentPath={props.parentPath}
            entryType="file"
            activeView={activeView}
            editable={editable}
            gitHead={gitTabHead(props.gitContext)}
            fillAvailableHeight={isEditView}
        >
            {content}
        </BrowserRouteShell>
    );
}

/** Owns directory-only filtering and representation selection outside file dispatch. */
function DirectoryBrowserPage(props: {
    api: ApiClient;
    agent: Agent;
    path: string;
    parentPath: string | null;
    loadedListing: LsDirectoryResponse;
    gitContext: GitContextResponse;
}) {
    const agents = useAgents();
    const search = Route.useSearch();

    const lsResult = useLiveListing(
        props.agent,
        props.loadedListing,
        isLsDirectoryResponse,
    );

    // A directory's default representation is its listing.
    const activeView = search.view ?? "files";

    return (
        <BrowserRouteShell
            agent={props.agent}
            path={props.path}
            parentPath={props.parentPath}
            entryType="directory"
            activeView={activeView}
            gitHead={gitTabHead(props.gitContext)}
        >
            {activeView === "git" ? (
                <WorktreeGitView
                    agent={props.agent}
                    path={lsResult.path}
                    tab={search.gitTab}
                    context={props.gitContext}
                    changes={
                        <GitDirectoryView
                            agent={props.agent}
                            path={lsResult.path}
                        />
                    }
                />
            ) : activeView === "details" ? (
                <DirectoryDetailView
                    key={lsResult.path}
                    agent={props.agent}
                    path={props.path}
                    directoryName={getBaseName(props.path)}
                    lsResult={lsResult}
                />
            ) : activeView === "sync" ? (
                <SyncView
                    key={`${props.agent.id}:${lsResult.path}`}
                    api={props.api}
                    sourceAgent={props.agent}
                    agents={agents}
                    sourcePath={lsResult.path}
                    entryType="directory"
                />
            ) : (
                <>
                    <WaitingUploads
                        agentId={props.agent.id}
                        destinationPath={lsResult.path}
                    />
                    <SelectedFilesCard
                        api={props.api}
                        agents={agents}
                        destinationAgent={props.agent}
                        directoryPath={lsResult.path}
                        destinationEntries={lsResult.files}
                    />
                    <DirectoryListing
                        agent={props.agent}
                        directoryPath={lsResult.path}
                        files={lsResult.files}
                    />
                </>
            )}
        </BrowserRouteShell>
    );
}

/**
 * The file list with its toolbar, shared by working directories and Git revisions so both
 * look and behave the same. A revision passes `revision`, which disables every action that
 * would write into the directory while selection and downloads read the commit.
 */
function DirectoryListing(props: {
    agent: Agent;
    directoryPath: string;
    files: LsEntry[];
    revision?: RevisionListing;
}) {
    const [userState, setUserState] = useUserState();
    const navigate = Route.useNavigate();
    const search = Route.useSearch();

    const { data: details } = useSuspenseQuery(
        agentDetailsQueryOptions(props.agent),
    );

    const showHiddenFiles = userState.showHiddenFiles;

    const directories = sortFileEntries(
        props.files.filter((file) => file.type === "directory"),
    );

    const regularFiles = sortFileEntries(
        props.files.filter((file) => file.type === "file"),
    );

    const sort: FileSort | null =
        search.sort === undefined
            ? null
            : { column: search.sort, direction: search.order ?? "ascending" };

    /** Keeps the order in the URL so it survives a reload and can be shared. */
    const changeSort = (column: FileSortColumn) => {
        const direction =
            sort?.column === column && sort.direction === "ascending"
                ? "descending"
                : "ascending";

        void navigate({
            search: (previous) => ({
                ...previous,
                sort: column,
                order: direction === "descending" ? direction : undefined,
            }),
            replace: true,
        });
    };

    return (
        <FileList
            key={props.directoryPath}
            agent={props.agent}
            directoryPath={props.directoryPath}
            files={[...directories, ...regularFiles]}
            showHiddenFiles={showHiddenFiles}
            sort={sort}
            onSort={changeSort}
            revision={props.revision}
            mountPoint={getMountPointForPath(
                details.mount_points,
                props.directoryPath,
            )}
            actions={
                <DirectoryFilesActions
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    showHiddenFiles={showHiddenFiles}
                    revision={props.revision?.commitId}
                    onToggleHiddenFiles={() =>
                        setUserState((current) => ({
                            ...current,
                            showHiddenFiles: !current.showHiddenFiles,
                        }))
                    }
                />
            }
        />
    );
}

/** Content is the file default view. */
function wantsFileContentView(view: BrowserSearch["view"]) {
    return view === undefined;
}

/** Replaces history so a content URL for a file without viewable content does not stay on the stack. */
function replaceUnsupportedFileView(
    params: BrowserParams,
    view: BrowserSearch["view"],
    metadata: MetadataResponse | null,
) {
    const canShowContent =
        metadata?.editable === true || metadata?.viewable_image === true;

    if (wantsFileContentView(view) && !canShowContent) {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params,
            search: { view: "details" },
            replace: true,
        });
    }
}

/** Makes rendered markdown the canonical first view while line bookmarks stay in the editor. */
function replaceDefaultMarkdownPreview(options: {
    params: BrowserParams;
    view: BrowserSearch["view"];
    filePath: string;
    metadata: MetadataResponse | null;
    line: BrowserSearch["line"];
    preview: BrowserSearch["preview"];
    currentSearch: BrowserSearch;
}) {
    if (
        !wantsFileContentView(options.view) ||
        options.metadata?.editable !== true ||
        syntaxLanguageFromFileName(options.filePath) !== "markdown" ||
        options.line !== undefined ||
        options.preview !== undefined
    ) {
        return;
    }

    throw redirect({
        to: "/agents/$deviceName/browser/$",
        params: options.params,
        search: { ...options.currentSearch, preview: true },
        replace: true,
    });
}

/** Selects the most specific filesystem mount containing the browsed directory. */
function getMountPointForPath(
    mountPoints: MountPoint[],
    path: string,
): MountPoint | null {
    return (
        mountPoints
            .filter(
                (mountPoint) =>
                    mountPoint.path === "/" ||
                    path === mountPoint.path ||
                    path.startsWith(`${mountPoint.path}/`),
            )
            .sort((left, right) => right.path.length - left.path.length)[0] ??
        null
    );
}
