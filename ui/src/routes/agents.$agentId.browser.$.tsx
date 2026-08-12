import { createFileRoute, redirect } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { atomWithLocalStorage } from "#ui/utils/local-storage-atom";
import {
    type ApiClient,
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsDirectoryResponse,
} from "#ui/api-client";
import { RouteError } from "#ui/components/route-error";
import {
    BrowserHeader,
    MissingPathSkeleton,
    UnavailablePathState,
} from "#ui/components/browser/navigation";
import { DirectoryFilesActions } from "#ui/components/browser/directory-actions";
import { FileList } from "#ui/components/browser/file-list";
import {
    DirectoryDetailView,
    FileDetailView,
} from "#ui/components/browser/metadata";
import { FileDiffView } from "#ui/components/browser/file-diff-view";
import { FileSyncPage, SyncView } from "#ui/components/browser/sync";
import {
    FileEditView,
    FileImageView,
    UnsupportedFileView,
} from "#ui/components/browser/file-views";
import {
    getImmediateParentPath,
    getPathLoadError,
    sortFileEntries,
} from "#ui/components/browser/utils";

/** Keeps the hidden-file visibility preference consistent across reloads. */
const showHiddenFilesAtom = atomWithLocalStorage(
    "redoor.browser.show-hidden-files",
    true,
);

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    validateSearch: (
        search,
    ): { view?: "details" | "edit" | "diff" | "sync" } => ({
        view:
            search.view === "details" ||
            search.view === "edit" ||
            search.view === "diff" ||
            search.view === "sync"
                ? search.view
                : undefined,
    }),
    loader: async ({ params, parentMatchPromise }) => {
        const rootMatch = await parentMatchPromise;
        const rootLoaderData = rootMatch.loaderData;
        if (!rootLoaderData) {
            throw new Error("Agent list unavailable");
        }

        const agent = rootLoaderData.agents.find(
            (entry) => entry.id === params.agentId,
        );
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
        if (agent.status !== "connected" || agent.cwd === null) {
            throw redirect({
                to: "/agents/$agentId",
                params: { agentId: params.agentId },
            });
        }

        const path = `/${params._splat ?? ""}`;

        // Missing paths still resolve the route so breadcrumbs stay available for correction.
        try {
            const lsResult: LsResponse = await agent.ls(path);
            const downloadUrl = isLsFileResponse(lsResult)
                ? agent.getRawUrl(lsResult.path)
                : undefined;
            const metadata = isLsFileResponse(lsResult)
                ? await agent.metadata(lsResult.path)
                : null;

            return {
                agent,
                agentId: agent.id,
                agentName: agent.name,
                path,
                lsResult,
                downloadUrl,
                metadata,
                agents: rootLoaderData.agents,
                pathError: null,
            };
        } catch (error) {
            const pathError = getPathLoadError(error);
            if (!pathError) {
                throw error;
            }
            return {
                agent,
                agentId: agent.id,
                agentName: agent.name,
                path,
                lsResult: null,
                downloadUrl: undefined,
                metadata: null,
                agents: rootLoaderData.agents,
                pathError,
            };
        }
    },
    component: FileBrowser,
    errorComponent: RouteError,
});

function FileBrowser() {
    const data = Route.useLoaderData();
    const { api } = Route.useRouteContext();
    const { agent, agentId, agentName, path, lsResult, pathError } = data;
    const search = Route.useSearch();

    const parentPath = getImmediateParentPath(path);

    if (pathError) {
        return (
            <div className="p-6">
                <div className="mx-auto max-w-6xl">
                    <BrowserHeader
                        agent={agent}
                        agentId={agentId}
                        path={path}
                        parentPath={parentPath}
                        directoryPath={path}
                        activeView="files"
                        pathUnavailable={true}
                    />
                    {pathError.type === "missing" ? (
                        <MissingPathSkeleton />
                    ) : (
                        <UnavailablePathState
                            agent={agent}
                            path={path}
                            parentPath={parentPath}
                            error={pathError}
                        />
                    )}
                </div>
            </div>
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
                view={search.view}
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

        if (search.view === "diff") {
            return (
                <div className="p-6">
                    <div className="mx-auto max-w-6xl">
                        <FileDiffView
                            key={`${agentId}:${lsResult.path}`}
                            api={api}
                            agent={agent}
                            agents={data.agents}
                            agentId={agentId}
                            path={path}
                            fileName={fileName}
                            filePath={lsResult.path}
                            downloadUrl={downloadUrl}
                        />
                    </div>
                </div>
            );
        }

        if (search.view === "sync") {
            return (
                <FileSyncPage
                    key={`${agentId}:${lsResult.path}`}
                    api={api}
                    agent={agent}
                    agents={data.agents}
                    agentId={agentId}
                    path={path}
                    fileName={fileName}
                    filePath={lsResult.path}
                    downloadUrl={downloadUrl}
                />
            );
        }

        if (search.view === "edit") {
            if (editable) {
                return (
                    <div className="p-6">
                        <div className="mx-auto max-w-6xl">
                            <FileEditView
                                agent={agent}
                                agentId={agentId}
                                path={path}
                                fileName={fileName}
                                filePath={lsResult.path}
                                mimeType={
                                    data.metadata?.mime_type ?? "text/plain"
                                }
                                downloadUrl={downloadUrl}
                            />
                        </div>
                    </div>
                );
            }

            if (viewableImage) {
                return (
                    <div className="p-6">
                        <div className="mx-auto max-w-6xl">
                            <FileImageView
                                agent={agent}
                                agentId={agentId}
                                path={path}
                                fileName={fileName}
                                downloadUrl={downloadUrl}
                            />
                        </div>
                    </div>
                );
            }

            return (
                <div className="p-6">
                    <div className="mx-auto max-w-6xl">
                        <UnsupportedFileView
                            agent={agent}
                            agentId={agentId}
                            path={path}
                            fileName={fileName}
                            downloadUrl={downloadUrl}
                        />
                    </div>
                </div>
            );
        }

        return (
            <div className="p-6">
                <div className="mx-auto max-w-6xl">
                    <FileDetailView
                        agent={agent}
                        agentId={agentId}
                        path={path}
                        fileName={fileName}
                        lsResult={lsResult}
                        downloadUrl={downloadUrl}
                        initialOneTimeTokens={
                            data.metadata?.one_time_tokens ?? []
                        }
                    />
                </div>
            </div>
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
    view?: "details" | "edit" | "diff" | "sync";
}) {
    const [showHiddenFiles, setShowHiddenFiles] = useAtom(showHiddenFilesAtom);
    const visibleFiles = showHiddenFiles
        ? props.lsResult.files
        : props.lsResult.files.filter((file) => !file.name.startsWith("."));
    const directories = sortFileEntries(
        visibleFiles.filter((file) => file.type === "directory"),
    );
    const regularFiles = sortFileEntries(
        visibleFiles.filter((file) => file.type === "file"),
    );
    const activeView =
        props.view === "details"
            ? "details"
            : props.view === "sync"
              ? "sync"
              : "files";

    return (
        <div className="p-6">
            <div className="mx-auto max-w-6xl">
                <BrowserHeader
                    agent={props.agent}
                    agentId={props.agentId}
                    path={props.path}
                    parentPath={props.parentPath}
                    directoryPath={props.path}
                    activeView={activeView}
                />

                {activeView === "details" ? (
                    <DirectoryDetailView
                        path={props.path}
                        directoryName={
                            props.path.split("/").filter(Boolean).pop() ?? "/"
                        }
                        lsResult={props.lsResult}
                    />
                ) : activeView === "sync" ? (
                    <SyncView
                        api={props.api}
                        sourceAgent={props.agent}
                        agents={props.agents}
                        sourcePath={props.lsResult.path}
                        entryType="directory"
                    />
                ) : (
                    <FileList
                        key={props.path}
                        agent={props.agent}
                        agentId={props.agentId}
                        agentName={props.agentName}
                        directoryPath={props.path}
                        files={[...directories, ...regularFiles]}
                        actions={
                            <DirectoryFilesActions
                                agent={props.agent}
                                agents={props.agents}
                                directoryPath={props.path}
                                showHiddenFiles={showHiddenFiles}
                                onToggleHiddenFiles={() =>
                                    setShowHiddenFiles((visible) => !visible)
                                }
                            />
                        }
                    />
                )}
            </div>
        </div>
    );
}
