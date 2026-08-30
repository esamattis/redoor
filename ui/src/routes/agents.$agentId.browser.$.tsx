import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import {
    type ApiClient,
    type Agent,
    type LsDirectoryResponse,
} from "#ui/api-client";
import {
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
} from "#ui/ls-response";
import { useUserState } from "#ui/user-state";
import { RouteError } from "#ui/components/route-error";
import {
    BrowserHeader,
    UnavailablePathState,
} from "#ui/components/browser/navigation";
import { MissingPathCreationForm } from "#ui/components/browser/missing-path";
import { DirectoryFilesActions } from "#ui/components/browser/directory-actions";
import { SelectedFilesCard } from "#ui/components/browser/selected-files-card";
import { FileList } from "#ui/components/browser/file-list";
import { UploadQueue } from "#ui/components/browser/upload-queue";
import {
    DirectoryDetailView,
    FileDetailView,
} from "#ui/components/browser/metadata";
import { SyncView } from "#ui/components/browser/sync";
import { GitDirectoryView, GitFileView } from "#ui/components/browser/git";
import { FileEditView, FileImageView } from "#ui/components/browser/file-views";
import {
    getImmediateParentPath,
    getPathLoadError,
    sortFileEntries,
} from "#ui/components/browser/utils";
import {
    agentAccountsQueryOptions,
    browserListingQueryOptions,
    fileContentQueryOptions,
    gitContextQueryOptions,
    gitDiffQueryOptions,
    gitStatusQueryOptions,
    queryKeys,
} from "#ui/queries";
import { useBrowserRefreshTriggers } from "#ui/components/browser/refresh";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { MountPoint } from "#bindings/MountPoint";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";

type BrowserSearch = {
    view?: "details" | "edit" | "diff" | "sync" | "git";
    line?: number;
    preview?: boolean;
};

type BrowserFullSearch = BrowserSearch & {
    q?: string;
    mode?: "content";
    context?: number;
    timeout?: number;
    hidden?: boolean;
    gitignore?: boolean;
    regex?: boolean;
    gitroot?: boolean;
    case?: "smart" | "sensitive" | "insensitive";
};

/** Accepts booleans from router navigation and directly entered query strings. */
const optionalBooleanSchema = z
    .union([
        z.boolean(),
        z.literal("true").transform(() => true),
        z.literal("false").transform(() => false),
    ])
    .optional()
    .catch(undefined);

/** Accepts only 1-based whole line numbers so garbage query values cannot drive the editor. */
const browserLineSchema = z
    .union([
        z.number().int().gte(1),
        z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .transform(Number)
            .pipe(z.number().int().gte(1)),
    ])
    .optional()
    .catch(undefined);

/** Reads line from the raw query so the loader can preserve it without adding line to loaderDeps. */
function lineFromLocationSearch(searchStr: string): number | undefined {
    const params = new URLSearchParams(
        searchStr.startsWith("?") ? searchStr.slice(1) : searchStr,
    );
    const value = params.get("line");
    return value === null ? undefined : browserLineSchema.parse(value);
}

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    validateSearch: (search): BrowserSearch => ({
        view:
            search.view === "details" ||
            search.view === "edit" ||
            search.view === "diff" ||
            search.view === "sync" ||
            search.view === "git"
                ? search.view
                : undefined,
        line: browserLineSchema.parse(search.line),
        preview: optionalBooleanSchema.parse(search.preview),
    }),
    loaderDeps: ({ search }) => ({ view: search.view }),
    loader: async ({ context, deps, params, parentMatchPromise, location }) => {
        const agentMatch = await parentMatchPromise;
        const agentLoaderData = agentMatch.loaderData;
        if (!agentLoaderData) {
            throw new Error("Agent details unavailable");
        }

        const agent = agentLoaderData.agent;
        if (agentLoaderData.kind !== "connected" || agent.cwd === null) {
            throw redirect({
                to: "/agents/$agentId",
                params: { agentId: params.agentId },
            });
        }

        // Legacy ?view=diff bookmarks land on the unified Sync workspace.
        if (deps.view === "diff") {
            throw redirect({
                to: "/agents/$agentId/browser/$",
                params,
                search: { view: "sync" },
                replace: true,
            });
        }

        const rawSearch = new URLSearchParams(
            location.searchStr.startsWith("?")
                ? location.searchStr.slice(1)
                : location.searchStr,
        );
        if (rawSearch.has("diff")) {
            throw redirect({
                to: "/agents/$agentId/browser/$",
                params,
                search: {
                    view: deps.view,
                    line: lineFromLocationSearch(location.searchStr),
                },
                replace: true,
            });
        }

        const path = `/${params._splat ?? ""}`;

        const gitContextPromise = context.queryClient.fetchQuery({
            ...gitContextQueryOptions(agent, path),
            staleTime: 0,
        });
        const listingPromise = context.queryClient.fetchQuery({
            ...browserListingQueryOptions(agent, path),
            // Route invalidation is an explicit refresh even if the mounted listing is retained.
            staleTime: 0,
        });

        // Missing paths still resolve the route so breadcrumbs stay available for correction.
        try {
            const [gitContext, lsResult]: [
                Awaited<ReturnType<Agent["gitContext"]>>,
                LsResponse,
            ] = await Promise.all([gitContextPromise, listingPromise]);
            if (
                deps.view === "git" &&
                gitContext.status === "outside_worktree"
            ) {
                throw redirect({
                    to: "/agents/$agentId/browser/$",
                    params,
                    search: {},
                    replace: true,
                });
            }
            // Canonicalize the cache identity so aliases refresh the listing the route actually displays.
            context.queryClient.setQueryData(
                queryKeys.browserListing(agent.id, lsResult.path),
                lsResult,
            );
            const downloadUrl = isLsFileResponse(lsResult)
                ? agent.getRawUrl(lsResult.path)
                : undefined;
            const metadata = isLsFileResponse(lsResult)
                ? await agent.metadata(lsResult.path)
                : null;
            if (isLsFileResponse(lsResult)) {
                replaceUnsupportedOrLegacyFileView(params, deps.view, metadata);
                replaceLegacyEditFileView(
                    params,
                    deps.view,
                    lineFromLocationSearch(location.searchStr),
                );
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
                    await context.queryClient.fetchQuery(
                        fileContentQueryOptions(agent, lsResult.path),
                    );
                }
            }
            if (deps.view === "details" && agent.isRoot) {
                await context.queryClient.fetchQuery(
                    agentAccountsQueryOptions(agent),
                );
            }
            if (
                deps.view === "git" &&
                gitContext.status === "inside_worktree"
            ) {
                if (isLsDirectoryResponse(lsResult)) {
                    await context.queryClient.fetchQuery({
                        ...gitStatusQueryOptions(agent, lsResult.path),
                        staleTime: 0,
                    });
                } else {
                    await context.queryClient.fetchQuery({
                        ...gitDiffQueryOptions(agent, [lsResult.path], "full"),
                        staleTime: 0,
                    });
                }
            }

            return {
                agent,
                agentId: agent.id,
                agentName: agent.name,
                path,
                lsResult,
                downloadUrl,
                metadata,
                agents: agentLoaderData.agents,
                mountPoints: agentLoaderData.details.mount_points,
                pathError: null,
                gitContext,
            };
        } catch (error) {
            const pathError = getPathLoadError(error);
            if (!pathError) {
                throw error;
            }
            const gitContext = await gitContextPromise;
            if (
                deps.view === "git" &&
                gitContext.status === "inside_worktree" &&
                gitContext.entry_type === "missing" &&
                gitContext.tracking_state === "deleted"
            ) {
                await context.queryClient.fetchQuery({
                    ...gitDiffQueryOptions(agent, [path], "full"),
                    staleTime: 0,
                });
                return {
                    agent,
                    agentId: agent.id,
                    agentName: agent.name,
                    path,
                    lsResult: null,
                    downloadUrl: undefined,
                    metadata: null,
                    agents: agentLoaderData.agents,
                    mountPoints: agentLoaderData.details.mount_points,
                    pathError,
                    gitContext,
                };
            }
            if (
                deps.view === "git" &&
                gitContext.status === "outside_worktree"
            ) {
                throw redirect({
                    to: "/agents/$agentId/browser/$",
                    params,
                    search: {},
                    replace: true,
                });
            }
            return {
                agent,
                agentId: agent.id,
                agentName: agent.name,
                path,
                lsResult: null,
                downloadUrl: undefined,
                metadata: null,
                agents: agentLoaderData.agents,
                mountPoints: agentLoaderData.details.mount_points,
                pathError,
                gitContext,
            };
        }
    },
    component: FileBrowser,
    errorComponent: RouteError,
});

/** Fixes browser navigation chrome in one route-level frame for every path type and view. */
function BrowserRouteShell(props: {
    agent: Agent;
    agentId: string;
    path: string;
    parentPath: string | null;
    entryType: "directory" | "file";
    activeView: "files" | "details" | "view" | "sync" | "git";
    gitAvailable: boolean;
    editable?: boolean;
    /** Bounds the route to the overlay viewport so CodeMirror, not the page, scrolls. */
    fillAvailableHeight?: boolean;
    pathUnavailable?: boolean;
    startEditingPath?: boolean;
    children: ReactNode;
}) {
    return (
        <div
            className={
                props.fillAvailableHeight === true
                    ? "absolute inset-x-0 top-[var(--top-chrome-height,0px)] bottom-[var(--bottom-chrome-height,0px)] flex min-h-0 flex-col overflow-hidden p-2 lg:p-4"
                    : "flex min-h-full flex-col p-2 lg:p-4"
            }
        >
            <BrowserHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                parentPath={props.parentPath}
                entryType={props.entryType}
                activeView={props.activeView}
                editable={props.editable}
                gitAvailable={props.gitAvailable}
                pathUnavailable={props.pathUnavailable}
                startEditingPath={props.startEditingPath}
            />
            <div
                className={`w-full ${
                    props.fillAvailableHeight === true
                        ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                        : ""
                }`}
            >
                {props.children}
            </div>
        </div>
    );
}

function FileBrowser() {
    const data = Route.useLoaderData();
    const { api } = Route.useRouteContext();
    const navigate = Route.useNavigate();
    const { agent, agentId, agentName, path, lsResult, pathError } = data;
    const search = Route.useSearch();
    useBrowserRefreshTriggers();

    const parentPath = getImmediateParentPath(path);
    const gitAvailable = data.gitContext.status === "inside_worktree";

    if (
        pathError?.type === "missing" &&
        search.view === "git" &&
        data.gitContext.status === "inside_worktree" &&
        data.gitContext.entry_type === "missing" &&
        data.gitContext.tracking_state === "deleted"
    ) {
        return (
            <BrowserRouteShell
                agent={agent}
                agentId={agentId}
                path={path}
                parentPath={parentPath}
                entryType="file"
                activeView="git"
                gitAvailable
            >
                <GitFileView
                    agent={agent}
                    path={path}
                    context={data.gitContext}
                />
            </BrowserRouteShell>
        );
    }

    if (pathError) {
        return (
            <BrowserRouteShell
                agent={agent}
                agentId={agentId}
                path={path}
                parentPath={parentPath}
                entryType="directory"
                activeView="files"
                gitAvailable={gitAvailable}
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

    if (isLsDirectoryResponse(lsResult)) {
        return (
            <DirectoryBrowserPage
                api={api}
                agent={agent}
                agents={data.agents}
                agentId={agentId}
                agentName={agentName}
                path={path}
                parentPath={parentPath}
                lsResult={lsResult}
                mountPoints={data.mountPoints}
                view={search.view}
                gitAvailable={gitAvailable}
            />
        );
    }

    if (isLsFileResponse(lsResult)) {
        const fileName = path.split("/").pop() || lsResult.path;
        const downloadUrl = data.downloadUrl;
        if (!downloadUrl) {
            return <RouteError error={new Error("Download URL unavailable")} />;
        }

        const editable = data.metadata?.editable === true;
        const viewableImage = data.metadata?.viewable_image === true;

        const activeView =
            search.view === "git"
                ? "git"
                : search.view === "sync"
                  ? "sync"
                  : search.view === "details"
                    ? "details"
                    : "view";
        const isEditView = activeView === "view" && editable;
        const content =
            activeView === "git" ? (
                <GitFileView
                    agent={agent}
                    path={lsResult.path}
                    context={data.gitContext}
                />
            ) : activeView === "sync" ? (
                <SyncView
                    key={`${agentId}:${lsResult.path}`}
                    api={api}
                    sourceAgent={agent}
                    agents={data.agents}
                    sourcePath={lsResult.path}
                    entryType="file"
                />
            ) : activeView === "view" && editable ? (
                <FileEditView
                    key={`${agentId}:${lsResult.path}`}
                    agent={agent}
                    fileName={fileName}
                    filePath={lsResult.path}
                    mimeType={data.metadata?.mime_type ?? "text/plain"}
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
                    agent={agent}
                    path={path}
                    fileName={fileName}
                    lsResult={lsResult}
                    downloadUrl={downloadUrl}
                    initialOneTimeTokens={data.metadata?.one_time_tokens ?? []}
                />
            );

        return (
            <BrowserRouteShell
                agent={agent}
                agentId={agentId}
                path={path}
                parentPath={parentPath}
                entryType="file"
                activeView={activeView}
                editable={editable}
                gitAvailable={gitAvailable}
                fillAvailableHeight={isEditView}
            >
                {content}
            </BrowserRouteShell>
        );
    }

    return null;
}

/** Owns directory-only filtering and representation selection outside file dispatch. */
function DirectoryBrowserPage(props: {
    api: ApiClient;
    agent: Agent;
    agents: Agent[];
    agentId: string;
    agentName: string;
    path: string;
    parentPath: string | null;
    lsResult: LsDirectoryResponse;
    mountPoints: MountPoint[];
    view?: "details" | "edit" | "diff" | "sync" | "git";
    gitAvailable: boolean;
}) {
    const [userState, setUserState] = useUserState();
    const listingQuery = useQuery(
        browserListingQueryOptions(props.agent, props.lsResult.path),
    );
    const lsResult =
        listingQuery.data && isLsDirectoryResponse(listingQuery.data)
            ? listingQuery.data
            : props.lsResult;
    const showHiddenFiles = userState.showHiddenFiles;
    const visibleFiles = showHiddenFiles
        ? lsResult.files
        : lsResult.files.filter((file) => !file.name.startsWith("."));
    const directories = sortFileEntries(
        visibleFiles.filter((file) => file.type === "directory"),
    );
    const regularFiles = sortFileEntries(
        visibleFiles.filter((file) => file.type === "file"),
    );
    const activeView =
        props.view === "git"
            ? "git"
            : props.view === "details"
              ? "details"
              : props.view === "sync"
                ? "sync"
                : "files";

    return (
        <BrowserRouteShell
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            parentPath={props.parentPath}
            entryType="directory"
            activeView={activeView}
            gitAvailable={props.gitAvailable}
        >
            {activeView === "git" ? (
                <GitDirectoryView agent={props.agent} path={lsResult.path} />
            ) : activeView === "details" ? (
                <DirectoryDetailView
                    agent={props.agent}
                    path={props.path}
                    directoryName={
                        props.path.split("/").filter(Boolean).pop() ?? "/"
                    }
                    lsResult={props.lsResult}
                />
            ) : activeView === "sync" ? (
                <SyncView
                    key={`${props.agentId}:${lsResult.path}`}
                    api={props.api}
                    sourceAgent={props.agent}
                    agents={props.agents}
                    sourcePath={lsResult.path}
                    entryType="directory"
                />
            ) : (
                <>
                    <UploadQueue
                        agentId={props.agentId}
                        destinationPath={lsResult.path}
                    />
                    <SelectedFilesCard
                        api={props.api}
                        agents={props.agents}
                        destinationAgent={props.agent}
                        directoryPath={lsResult.path}
                        destinationFileNames={lsResult.files.map(
                            (file) => file.name,
                        )}
                    />
                    <FileList
                        key={lsResult.path}
                        agent={props.agent}
                        agentId={props.agentId}
                        agentName={props.agentName}
                        directoryPath={lsResult.path}
                        files={[...directories, ...regularFiles]}
                        mountPoint={getMountPointForPath(
                            props.mountPoints,
                            lsResult.path,
                        )}
                        actions={
                            <DirectoryFilesActions
                                agent={props.agent}
                                directoryPath={lsResult.path}
                                showHiddenFiles={showHiddenFiles}
                                onToggleHiddenFiles={() =>
                                    setUserState((current) => ({
                                        ...current,
                                        showHiddenFiles:
                                            !current.showHiddenFiles,
                                    }))
                                }
                            />
                        }
                    />
                </>
            )}
        </BrowserRouteShell>
    );
}

/** Content is the file default, including leftover ?view=edit bookmarks. */
function wantsFileContentView(view: BrowserSearch["view"]) {
    return view === undefined || view === "edit";
}

/** Replaces history so unsupported files and leftover content URLs do not stay on the stack. */
function replaceUnsupportedOrLegacyFileView(
    params: { agentId: string; _splat?: string },
    view: BrowserSearch["view"],
    metadata: MetadataResponse | null,
) {
    const canShowContent =
        metadata?.editable === true || metadata?.viewable_image === true;
    if (wantsFileContentView(view) && !canShowContent) {
        throw redirect({
            to: "/agents/$agentId/browser/$",
            params,
            search: { view: "details" },
            replace: true,
        });
    }
}

/** Strips leftover ?view=edit while keeping an inbound line bookmark. */
function replaceLegacyEditFileView(
    params: { agentId: string; _splat?: string },
    view: BrowserSearch["view"],
    line: BrowserSearch["line"],
) {
    if (view !== "edit") {
        return;
    }
    throw redirect({
        to: "/agents/$agentId/browser/$",
        params,
        search: line === undefined ? {} : { line },
        replace: true,
    });
}

/** Makes rendered markdown the canonical first view while line bookmarks stay in the editor. */
function replaceDefaultMarkdownPreview(options: {
    params: { agentId: string; _splat?: string };
    view: BrowserSearch["view"];
    filePath: string;
    metadata: MetadataResponse | null;
    line: BrowserSearch["line"];
    preview: BrowserSearch["preview"];
    currentSearch: BrowserFullSearch;
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
        to: "/agents/$agentId/browser/$",
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
