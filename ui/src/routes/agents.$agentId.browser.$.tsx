import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
    type ApiClient,
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsDirectoryResponse,
} from "#ui/api-client";
import { useUserState } from "#ui/user-state";
import { RouteError } from "#ui/components/route-error";
import {
    BrowserHeader,
    UnavailablePathState,
} from "#ui/components/browser/navigation";
import { MissingPathCreationForm } from "#ui/components/browser/missing-path";
import {
    DirectoryFilesActions,
    SelectedFilesCard,
} from "#ui/components/browser/directory-actions";
import { FileList } from "#ui/components/browser/file-list";
import { UploadQueue } from "#ui/components/browser/upload-queue";
import {
    DirectoryDetailView,
    FileDetailView,
} from "#ui/components/browser/metadata";
import { FileDiffView } from "#ui/components/browser/file-diff-view";
import { SyncView } from "#ui/components/browser/sync";
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
import { fileContentQueryOptions } from "#ui/queries";
import { useRefreshBrowserOnWindowFocus } from "#ui/components/browser/refresh";
import type { MountPoint } from "#bindings/MountPoint";

type BrowserSearch = {
    view?: "details" | "edit" | "diff" | "sync";
};

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    validateSearch: (search): BrowserSearch => ({
        view:
            search.view === "details" ||
            search.view === "edit" ||
            search.view === "diff" ||
            search.view === "sync"
                ? search.view
                : undefined,
    }),
    loaderDeps: ({ search }) => ({ view: search.view }),
    loader: async ({ context, deps, params, parentMatchPromise }) => {
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
            if (
                deps.view === "edit" &&
                isLsFileResponse(lsResult) &&
                metadata?.editable === true
            ) {
                await context.queryClient.fetchQuery(
                    fileContentQueryOptions(agent, lsResult.path),
                );
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
                agents: agentLoaderData.agents,
                mountPoints: agentLoaderData.details.mount_points,
                pathError,
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
    activeView: "files" | "details" | "view" | "diff" | "sync";
    constrainContent?: boolean;
    pathUnavailable?: boolean;
    startEditingPath?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="p-2 lg:p-4">
            <BrowserHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                parentPath={props.parentPath}
                entryType={props.entryType}
                activeView={props.activeView}
                pathUnavailable={props.pathUnavailable}
                startEditingPath={props.startEditingPath}
            />
            <div
                className={
                    props.constrainContent ? "mx-auto max-w-6xl" : "w-full"
                }
            >
                {props.children}
            </div>
        </div>
    );
}

function FileBrowser() {
    const data = Route.useLoaderData();
    const { api } = Route.useRouteContext();
    const { agent, agentId, agentName, path, lsResult, pathError } = data;
    const search = Route.useSearch();
    useRefreshBrowserOnWindowFocus();

    const parentPath = getImmediateParentPath(path);

    if (pathError) {
        return (
            <BrowserRouteShell
                agent={agent}
                agentId={agentId}
                path={path}
                parentPath={parentPath}
                entryType="directory"
                activeView="files"
                constrainContent
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
            search.view === "diff"
                ? "diff"
                : search.view === "sync"
                  ? "sync"
                  : search.view === "edit"
                    ? "view"
                    : "details";
        const content =
            activeView === "diff" ? (
                <FileDiffView
                    key={`${agentId}:${lsResult.path}`}
                    api={api}
                    agent={agent}
                    agents={data.agents}
                    agentId={agentId}
                    fileName={fileName}
                    filePath={lsResult.path}
                    downloadUrl={downloadUrl}
                />
            ) : activeView === "sync" ? (
                <SyncView
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
                    downloadUrl={downloadUrl}
                />
            ) : activeView === "view" && viewableImage ? (
                <FileImageView
                    agent={agent}
                    fileName={fileName}
                    downloadUrl={downloadUrl}
                />
            ) : activeView === "view" ? (
                <UnsupportedFileView
                    agent={agent}
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
                constrainContent
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
    view?: "details" | "edit" | "diff" | "sync";
}) {
    const [userState, setUserState] = useUserState();
    const showHiddenFiles = userState.showHiddenFiles;
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
        <BrowserRouteShell
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            parentPath={props.parentPath}
            entryType="directory"
            activeView={activeView}
            constrainContent={activeView !== "files"}
        >
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
                <>
                    <UploadQueue
                        agentId={props.agentId}
                        destinationPath={props.path}
                    />
                    <SelectedFilesCard
                        api={props.api}
                        agents={props.agents}
                        destinationAgent={props.agent}
                        directoryPath={props.path}
                        destinationFileNames={props.lsResult.files.map(
                            (file) => file.name,
                        )}
                    />
                    <FileList
                        key={props.path}
                        agent={props.agent}
                        agentId={props.agentId}
                        agentName={props.agentName}
                        directoryPath={props.path}
                        files={[...directories, ...regularFiles]}
                        mountPoint={getMountPointForPath(
                            props.mountPoints,
                            props.path,
                        )}
                        actions={
                            <DirectoryFilesActions
                                agent={props.agent}
                                directoryPath={props.path}
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
