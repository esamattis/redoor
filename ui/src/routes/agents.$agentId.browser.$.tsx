/* oxlint-disable max-lines */
import React from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
    createFileRoute,
    Link,
    useNavigate,
    useRouter,
    useRouterState,
    redirect,
} from "@tanstack/react-router";
import {
    Folder,
    FolderPlus,
    File,
    ArrowUp,
    Download,
    ArrowLeft,
    Copy,
    Check,
    Upload,
    Trash2,
    Eye,
    EyeOff,
    Info,
    List,
    ClipboardPaste,
    Pencil,
    HardDrive,
    Search,
    FilePlus,
    ExternalLink,
    LoaderCircle,
    MoreHorizontal,
    Plus,
    Home,
} from "lucide-react";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Checkbox } from "#ui/components/checkbox";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { requestClipboardPaste } from "#ui/components/global-file-import-handler";
import { RouteError } from "#ui/components/route-error";
import { Tooltip } from "#ui/components/tooltip";
import { Toast } from "#ui/components/toast";
import {
    FILE_SEARCH_RESULT_EVENT,
    FileSearcher,
    type FileSearchState,
} from "#ui/file-searcher";
import { atomWithLocalStorage } from "#ui/utils/local-storage-atom";
import { formatSize } from "#ui/utils/path";
import {
    ApiError,
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsDirectoryResponse,
    type LsFileResponse,
} from "#ui/api-client";
import {
    selectedFileKeysAtom,
    selectedFilesAtom,
    toggleSelectedFileAtom,
    unselectFileAtom,
} from "#ui/selected-files";

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };

type CreateDirectoryState =
    | { type: "idle" }
    | { type: "creating" }
    | { type: "error"; message: string };

type CreateFileState =
    | { type: "idle" }
    | { type: "creating" }
    | { type: "error"; message: string };

type RenameState =
    | { type: "idle" }
    | { type: "renaming" }
    | { type: "error"; message: string };

type ShareableLinkState =
    | { type: "idle" }
    | { type: "creating" }
    | { type: "error"; message: string };

type NativeOpenState =
    | { type: "idle" }
    | { type: "opening" }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/** Identifies the destination that should restore filter focus after Enter navigation. */
const filterFocusPathAtom = atom<string | null>(null);

/** Keeps the hidden-file visibility preference consistent across reloads. */
const showHiddenFilesAtom = atomWithLocalStorage(
    "redoor.browser.show-hidden-files",
    true,
);

function getImmediateParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");
    if (!normalizedPath.startsWith("/") || normalizedPath === "") return null;
    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    return lastSlashIndex === 0 ? "/" : normalizedPath.slice(0, lastSlashIndex);
}

function getBrowserPathHref(agent: Agent, path: string) {
    return agent.getBrowserUrl(path);
}

type PathLoadError = {
    type: "missing" | "unreadable";
    message: string;
};

/** Converts expected filesystem lookup failures into navigable in-page states. */
function getPathLoadError(error: unknown): PathLoadError | null {
    if (!(error instanceof ApiError)) {
        return null;
    }
    if (error.status === 404) {
        return { type: "missing", message: error.message };
    }
    if (error.status === 403) {
        return { type: "unreadable", message: error.message };
    }
    return null;
}

/**
 * Sort entries case-insensitively with dot-prefixed entries first.
 */
function sortFileEntries<T extends { name: string }>(entries: T[]): T[] {
    return [...entries].sort((a, b) => {
        const aIsDot = a.name.startsWith(".");
        const bIsDot = b.name.startsWith(".");
        if (aIsDot !== bIsDot) {
            return aIsDot ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
        });
    });
}

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    validateSearch: (search): { view?: "details" | "edit" } => ({
        view:
            search.view === "details" || search.view === "edit"
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
    const { agent, agentId, agentName, path, lsResult, pathError } = data;
    const search = Route.useSearch();
    const [showHiddenFiles, setShowHiddenFiles] = useAtom(showHiddenFilesAtom);

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
                        isDetailsView={false}
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
        const filterHidden = (files: typeof lsResult.files) => {
            if (showHiddenFiles) return files;
            return files.filter((f) => !f.name.startsWith("."));
        };

        const directories = sortFileEntries(
            filterHidden(lsResult.files.filter((f) => f.type === "directory")),
        );
        const regularFiles = sortFileEntries(
            filterHidden(lsResult.files.filter((f) => f.type === "file")),
        );

        const sortedFiles = [...directories, ...regularFiles];

        const isDetailsView = search.view === "details";

        return (
            <div className="p-6">
                <div className="mx-auto max-w-6xl">
                    <BrowserHeader
                        agent={agent}
                        agentId={agentId}
                        path={path}
                        parentPath={parentPath}
                        directoryPath={path}
                        isDetailsView={isDetailsView}
                    />

                    {isDetailsView ? (
                        <DirectoryDetailView
                            path={path}
                            directoryName={
                                path.split("/").filter(Boolean).pop() ?? "/"
                            }
                            lsResult={lsResult}
                        />
                    ) : (
                        <FileList
                            key={path}
                            agentId={agentId}
                            agentName={agentName}
                            directoryPath={path}
                            files={sortedFiles}
                            actions={
                                <DirectoryFilesActions
                                    agent={agent}
                                    agents={data.agents}
                                    directoryPath={path}
                                    showHiddenFiles={showHiddenFiles}
                                    onToggleHiddenFiles={() =>
                                        setShowHiddenFiles((prev) => !prev)
                                    }
                                />
                            }
                        />
                    )}
                </div>
            </div>
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

/** Tracks copy progress while keeping the destination action responsive. */
type CopySelectedFilesState =
    | { type: "idle" }
    | { type: "copying"; itemCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/** Tracks upload progress for files chosen from the local browser. */
type UploadState =
    | { type: "idle" }
    | { type: "uploading"; fileCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

function joinBrowserPath(directoryPath: string, fileName: string) {
    if (directoryPath.endsWith("/")) {
        return `${directoryPath}${fileName}`;
    }

    return `${directoryPath}/${fileName}`;
}

function getErrorMessage(error: unknown, fallbackMessage: string) {
    if (error instanceof Error) {
        return error.message;
    }

    return fallbackMessage;
}

/**
 * Copies the global selection into this directory so the destination is clear
 * at the point where the action is performed.
 */
function CopySelectedFilesAction(props: {
    agents: Agent[];
    destinationAgent: Agent;
    directoryPath: string;
}) {
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const isRoutePending = useRouterState({
        select: (state) => state.status === "pending",
    });
    const [copyState, setCopyState] = React.useState<CopySelectedFilesState>({
        type: "idle",
    });

    const statusMessage =
        copyState.type === "copying"
            ? `Copying ${copyState.itemCount} ${copyState.itemCount === 1 ? "item" : "items"}...`
            : copyState.type === "idle"
              ? null
              : copyState.message;
    const isCopying = copyState.type === "copying";

    if (selectedFiles.length === 0) {
        return null;
    }

    const handleCopySelectedFiles = async () => {
        if (selectedFiles.length === 0) {
            return;
        }

        setCopyState({
            type: "copying",
            itemCount: selectedFiles.length,
        });

        const agentsById = new Map(
            props.agents.map((agent) => [agent.id, agent]),
        );
        const results = await Promise.allSettled(
            selectedFiles.map((file) => {
                const sourceAgent = agentsById.get(file.agentId);

                if (!sourceAgent) {
                    return Promise.reject(
                        new Error(
                            `Source agent unavailable for selected item: ${file.agentId}`,
                        ),
                    );
                }

                return sourceAgent.copyTo(
                    {
                        agent: props.destinationAgent.id,
                        path: joinBrowserPath(
                            props.directoryPath,
                            file.fileName,
                        ),
                    },
                    file.path,
                );
            }),
        );
        const successfulCopies = selectedFiles.filter(
            (_file, index) => results[index]?.status === "fulfilled",
        );
        const failedCopies = results.filter(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected",
        );

        successfulCopies.forEach((file) => {
            unselectFile({
                agentId: file.agentId,
                path: file.path,
            });
        });

        if (failedCopies.length > 0) {
            const firstFailedCopy = failedCopies[0];
            const failureMessage = getErrorMessage(
                firstFailedCopy ? firstFailedCopy.reason : undefined,
                "Copy failed",
            ).replace(/^Upload failed$/, "Copy failed");

            setCopyState({
                type: "error",
                message:
                    successfulCopies.length > 0
                        ? `Copied ${successfulCopies.length} of ${selectedFiles.length} items. ${failureMessage}`
                        : failureMessage,
            });
            return;
        }

        setCopyState({
            type: "success",
            message:
                selectedFiles.length === 1
                    ? `Copied ${selectedFiles[0]?.fileName ?? "item"}`
                    : `Copied ${selectedFiles.length} items`,
        });
    };

    return (
        <>
            <button
                type="button"
                onClick={handleCopySelectedFiles}
                aria-label="Copy selected files here"
                disabled={
                    selectedFiles.length === 0 || isCopying || isRoutePending
                }
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Copy className="h-3.5 w-3.5" />
                {isCopying ? "Copying..." : `Copy ${selectedFiles.length} here`}
            </button>
            {statusMessage ? (
                <Toast
                    tone={copyState.type === "error" ? "error" : "success"}
                    icon={<Copy className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss copy status"
                    onDismiss={() => setCopyState({ type: "idle" })}
                >
                    {statusMessage}
                </Toast>
            ) : null}
        </>
    );
}

/** Opens the local file picker and uploads chosen files into this directory. */
function UploadFilesAction(props: { agent: Agent; directoryPath: string }) {
    const router = useRouter();
    const inputId = React.useId();
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const [uploadState, setUploadState] = React.useState<UploadState>({
        type: "idle",
    });

    const statusMessage =
        uploadState.type === "uploading"
            ? `Uploading ${uploadState.fileCount} ${uploadState.fileCount === 1 ? "file" : "files"}...`
            : uploadState.type === "idle"
              ? null
              : uploadState.message;
    const isUploading = uploadState.type === "uploading";

    const openFilePicker = () => {
        setUploadState({ type: "idle" });
        inputRef.current?.click();
    };

    const handleFileSelection = async (
        event: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const selectedFiles = Array.from(event.target.files ?? []);
        if (selectedFiles.length === 0) {
            return;
        }

        setUploadState({
            type: "uploading",
            fileCount: selectedFiles.length,
        });

        try {
            const results = await Promise.allSettled(
                selectedFiles.map((file) =>
                    props.agent.upload(
                        joinBrowserPath(props.directoryPath, file.name),
                        file,
                    ),
                ),
            );
            const successCount = results.filter(
                (result) => result.status === "fulfilled",
            ).length;
            const failedUploads = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successCount > 0) {
                await router.invalidate();
            }

            if (failedUploads.length > 0) {
                const firstFailedUpload = failedUploads[0];
                const failureMessage = getErrorMessage(
                    firstFailedUpload ? firstFailedUpload.reason : undefined,
                    "Upload failed",
                );
                setUploadState({
                    type: "error",
                    message:
                        successCount > 0
                            ? `Uploaded ${successCount} of ${selectedFiles.length} files. ${failureMessage}`
                            : failureMessage,
                });
                return;
            }

            setUploadState({
                type: "success",
                message:
                    selectedFiles.length === 1
                        ? `Uploaded ${selectedFiles[0] ? selectedFiles[0].name : "file"}`
                        : `Uploaded ${selectedFiles.length} files`,
            });
        } catch (error) {
            setUploadState({
                type: "error",
                message: getErrorMessage(error, "Upload failed"),
            });
        } finally {
            event.target.value = "";
        }
    };

    return (
        <div className="flex items-center gap-3">
            <label htmlFor={inputId} className="sr-only">
                Choose files to upload
            </label>
            <input
                ref={inputRef}
                id={inputId}
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelection}
            />
            <button
                type="button"
                onClick={openFilePicker}
                aria-label="Upload files"
                disabled={isUploading}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Upload className="h-4 w-4" />
                {isUploading ? "Uploading..." : "Upload"}
            </button>
            {statusMessage ? (
                <span
                    role={uploadState.type === "error" ? "alert" : "status"}
                    aria-live="polite"
                    className={`text-sm ${uploadState.type === "error" ? "text-red-400" : "text-emerald-400"}`}
                >
                    {statusMessage}
                </span>
            ) : null}
        </div>
    );
}

/** Opens a focused dialog so directory creation does not crowd the toolbar. */
function CreateDirectoryAction(props: {
    agent: Agent;
    directoryPath: string;
    isOpen: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const inputId = React.useId();
    const [directoryName, setDirectoryName] = React.useState("");
    const [createDirectoryState, setCreateDirectoryState] =
        React.useState<CreateDirectoryState>({
            type: "idle",
        });

    const trimmedDirectoryName = directoryName.trim();
    const createDirectoryPath = trimmedDirectoryName
        ? joinBrowserPath(props.directoryPath, trimmedDirectoryName)
        : null;
    const isCreating = createDirectoryState.type === "creating";

    const resetDialog = () => {
        props.onClose();
        setDirectoryName("");
        setCreateDirectoryState({ type: "idle" });
    };

    const closeDialog = () => {
        if (isCreating) {
            return;
        }

        resetDialog();
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!createDirectoryPath) {
            setCreateDirectoryState({
                type: "error",
                message: "Directory name is required",
            });
            return;
        }

        setCreateDirectoryState({ type: "creating" });

        try {
            await props.agent.createDirectory(createDirectoryPath);
            await navigate({
                to: props.agent.getBrowserUrl(createDirectoryPath),
            });
            resetDialog();
        } catch (error) {
            setCreateDirectoryState({
                type: "error",
                message: getErrorMessage(error, "Create directory failed"),
            });
        }
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            title="Create directory"
            description="Create a new directory in the current location."
            closeAriaLabel="Close create directory dialog"
            isBusy={isCreating}
            errorMessage={
                createDirectoryState.type === "error"
                    ? createDirectoryState.message
                    : null
            }
            onClose={closeDialog}
        >
            <form onSubmit={handleSubmit} className="mt-4">
                <label
                    htmlFor={inputId}
                    className="mb-2 block text-sm font-medium text-slate-300"
                >
                    Directory name
                </label>
                <input
                    id={inputId}
                    type="text"
                    value={directoryName}
                    onChange={(event) => {
                        setDirectoryName(event.target.value);
                        if (createDirectoryState.type === "error") {
                            setCreateDirectoryState({ type: "idle" });
                        }
                    }}
                    placeholder="logs"
                    autoFocus
                    disabled={isCreating}
                    className="w-full rounded border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-slate-800"
                />

                {createDirectoryPath ? (
                    <div className="mt-4">
                        <p className="mb-2 text-sm text-slate-400">
                            Directory path
                        </p>
                        <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                            {createDirectoryPath}
                        </p>
                    </div>
                ) : null}

                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={closeDialog}
                        disabled={isCreating}
                        className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isCreating}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <FolderPlus className="h-4 w-4" />
                        {isCreating ? "Creating..." : "Create directory"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}

/** Creates an empty text file and opens it immediately in the editor. */
function CreateFileAction(props: {
    agent: Agent;
    directoryPath: string;
    isOpen: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const inputId = React.useId();
    const [fileName, setFileName] = React.useState("");
    const [createFileState, setCreateFileState] =
        React.useState<CreateFileState>({ type: "idle" });

    const trimmedFileName = fileName.trim();
    const createFilePath = trimmedFileName
        ? joinBrowserPath(props.directoryPath, trimmedFileName)
        : null;
    const isCreating = createFileState.type === "creating";

    const resetDialog = () => {
        props.onClose();
        setFileName("");
        setCreateFileState({ type: "idle" });
    };

    const closeDialog = () => {
        if (!isCreating) {
            resetDialog();
        }
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!createFilePath) {
            setCreateFileState({
                type: "error",
                message: "File name is required",
            });
            return;
        }
        if (trimmedFileName.includes("/")) {
            setCreateFileState({
                type: "error",
                message: "File name cannot contain a slash",
            });
            return;
        }

        setCreateFileState({ type: "creating" });

        try {
            await props.agent.upload(
                createFilePath,
                new globalThis.File([""], trimmedFileName, {
                    type: "text/plain",
                }),
            );
            await navigate({
                to: props.agent.getBrowserUrl(createFilePath),
                search: { view: "edit" },
            });
            resetDialog();
        } catch (error) {
            setCreateFileState({
                type: "error",
                message: getErrorMessage(error, "Create file failed"),
            });
        }
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            title="Create file"
            description="Create an empty text file and open it for editing."
            closeAriaLabel="Close create file dialog"
            isBusy={isCreating}
            errorMessage={
                createFileState.type === "error"
                    ? createFileState.message
                    : null
            }
            onClose={closeDialog}
        >
            <form onSubmit={handleSubmit} className="mt-4">
                <label
                    htmlFor={inputId}
                    className="mb-2 block text-sm font-medium text-slate-300"
                >
                    File name
                </label>
                <input
                    id={inputId}
                    type="text"
                    value={fileName}
                    onChange={(event) => {
                        setFileName(event.target.value);
                        if (createFileState.type === "error") {
                            setCreateFileState({ type: "idle" });
                        }
                    }}
                    placeholder="notes.txt"
                    autoFocus
                    disabled={isCreating}
                    className="w-full rounded border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-slate-800"
                />

                {createFilePath ? (
                    <div className="mt-4">
                        <p className="mb-2 text-sm text-slate-400">File path</p>
                        <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                            {createFilePath}
                        </p>
                    </div>
                ) : null}

                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={closeDialog}
                        disabled={isCreating}
                        className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isCreating}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <FilePlus className="h-4 w-4" />
                        {isCreating ? "Creating..." : "Create file"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}

/** Groups file and directory creation without mixing their modal workflows. */
function DirectoryNewAction(props: { agent: Agent; directoryPath: string }) {
    const [dialogType, setDialogType] = React.useState<
        "file" | "directory" | null
    >(null);

    return (
        <>
            <ActionMenu label="New" icon={<Plus className="h-4 w-4" />}>
                {(close) => (
                    <>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                setDialogType("file");
                            }}
                        >
                            <FilePlus className="h-4 w-4 text-slate-400" />
                            New file
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                setDialogType("directory");
                            }}
                        >
                            <FolderPlus className="h-4 w-4 text-slate-400" />
                            New directory
                        </ActionMenuButton>
                    </>
                )}
            </ActionMenu>
            <CreateFileAction
                agent={props.agent}
                directoryPath={props.directoryPath}
                isOpen={dialogType === "file"}
                onClose={() => setDialogType(null)}
            />
            <CreateDirectoryAction
                agent={props.agent}
                directoryPath={props.directoryPath}
                isOpen={dialogType === "directory"}
                onClose={() => setDialogType(null)}
            />
        </>
    );
}

/** Keeps location, navigation, view state, and object actions in a stable frame. */
function BrowserPageHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    startEditingPath?: boolean;
    actionLabel: string;
    navigation: React.ReactNode;
    actions?: React.ReactNode;
}) {
    return (
        <header className="mb-4">
            <div className="mb-3 flex items-center gap-3">
                <Link
                    to="/agents/$agentId"
                    params={{ agentId: props.agentId }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                >
                    <HardDrive className="h-3.5 w-3.5" />
                    Agent
                </Link>
                <Tooltip content="Open agent home directory">
                    <Link
                        to={props.agent.getBrowserUrl(props.agent.cwd ?? "/")}
                        aria-label="Agent home"
                        className="inline-flex shrink-0 items-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <Home className="h-4 w-4" aria-hidden="true" />
                    </Link>
                </Tooltip>
                <div className="min-w-0 flex-1">
                    <Breadcrumbs
                        agent={props.agent}
                        path={props.path}
                        startEditing={props.startEditingPath}
                    />
                </div>
            </div>
            <div
                aria-label={props.actionLabel}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/80 bg-slate-900/70 p-1.5 shadow-sm"
            >
                <div className="flex flex-wrap items-center gap-1">
                    {props.navigation}
                </div>
                {props.actions ? (
                    <div className="flex flex-wrap items-center gap-1">
                        {props.actions}
                    </div>
                ) : null}
            </div>
        </header>
    );
}

/** Visually binds alternate representations while exposing their shared purpose. */
function ViewSwitch(props: { label: string; children: React.ReactNode }) {
    return (
        <div
            aria-label={props.label}
            className="flex gap-0.5 rounded-md border border-slate-800 bg-slate-950/60 p-0.5"
        >
            {props.children}
        </div>
    );
}

/** Makes the active representation unmistakable without changing control size. */
function getViewSwitchItemClass(isActive: boolean) {
    const baseClass =
        "inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm font-medium transition-colors";
    return isActive
        ? `${baseClass} border-blue-500/40 bg-blue-500/15 text-blue-200 shadow-sm`
        : `${baseClass} border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-100`;
}

/** Separates location context, navigation, and directory actions by purpose. */
function BrowserHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    parentPath: string | null;
    directoryPath: string;
    isDetailsView: boolean;
    pathUnavailable?: boolean;
}) {
    const pathUnavailable = props.pathUnavailable === true;
    const directoryName = props.path.split("/").filter(Boolean).pop() ?? "/";
    const archiveName = `${directoryName === "/" ? "archive" : directoryName}.tar.gz`;
    const archiveUrl = props.agent.getRawUrl(props.path, { download: true });

    return (
        <BrowserPageHeader
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            startEditingPath={pathUnavailable}
            actionLabel="File browser actions"
            navigation={
                <>
                    <Link
                        to={
                            props.parentPath
                                ? getBrowserPathHref(
                                      props.agent,
                                      props.parentPath,
                                  )
                                : props.agent.getBrowserUrl("/")
                        }
                        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
                        disabled={props.parentPath === null}
                    >
                        <ArrowUp className="h-4 w-4" />
                        Up
                    </Link>
                    {!pathUnavailable ? (
                        <ViewSwitch label="Directory view">
                            <Link
                                to={getBrowserPathHref(
                                    props.agent,
                                    props.directoryPath,
                                )}
                                search={{}}
                                aria-current={
                                    props.isDetailsView ? undefined : "page"
                                }
                                className={getViewSwitchItemClass(
                                    !props.isDetailsView,
                                )}
                            >
                                <List className="h-4 w-4" />
                                Files
                            </Link>
                            <Link
                                to={getBrowserPathHref(
                                    props.agent,
                                    props.directoryPath,
                                )}
                                search={{ view: "details" }}
                                aria-current={
                                    props.isDetailsView ? "page" : undefined
                                }
                                className={getViewSwitchItemClass(
                                    props.isDetailsView,
                                )}
                            >
                                <Info className="h-4 w-4" />
                                Details
                            </Link>
                        </ViewSwitch>
                    ) : null}
                </>
            }
            actions={
                !pathUnavailable ? (
                    <PersistentPathActions
                        agent={props.agent}
                        path={props.path}
                        currentName={directoryName}
                        entryType="directory"
                        view={props.isDetailsView ? "details" : undefined}
                        downloadUrl={archiveUrl}
                        downloadName={archiveName}
                        downloadTooltip="Downloads this directory as a .tar.gz archive."
                    />
                ) : null
            }
        />
    );
}

/** Keeps controls that affect only the file-list representation inside that view. */
function DirectoryFilesActions(props: {
    agent: Agent;
    agents: Agent[];
    directoryPath: string;
    showHiddenFiles: boolean;
    onToggleHiddenFiles: () => void;
}) {
    return (
        <div
            aria-label="Files view actions"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/35 p-2"
        >
            <button
                type="button"
                onClick={props.onToggleHiddenFiles}
                aria-pressed={props.showHiddenFiles}
                aria-label={
                    props.showHiddenFiles
                        ? "Hide hidden files"
                        : "Show hidden files"
                }
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100 aria-pressed:bg-slate-800 aria-pressed:text-slate-200"
            >
                {props.showHiddenFiles ? (
                    <EyeOff className="h-4 w-4" />
                ) : (
                    <Eye className="h-4 w-4" />
                )}
                {props.showHiddenFiles ? "Hide hidden" : "Show hidden"}
            </button>
            <div className="flex flex-wrap items-center gap-1">
                <Tooltip content="Pasted text or images are created as new files in this directory.">
                    <button
                        type="button"
                        onClick={requestClipboardPaste}
                        aria-label="Paste files or text"
                        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                    >
                        <ClipboardPaste className="h-4 w-4 text-slate-400" />
                        Paste
                    </button>
                </Tooltip>
                <DirectoryNewAction
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                />
                <UploadFilesAction
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                />
                <CopySelectedFilesAction
                    agents={props.agents}
                    destinationAgent={props.agent}
                    directoryPath={props.directoryPath}
                />
            </div>
        </div>
    );
}

/** Keeps the file table chrome visible while the user corrects a missing path. */
function MissingPathSkeleton() {
    return (
        <div className="space-y-3">
            <p role="status" className="text-sm text-slate-400">
                Directory not found
            </p>
            <table
                aria-label="File list"
                aria-busy="true"
                className="w-full rounded-lg border border-slate-800 bg-[#11141b]"
            >
                <thead>
                    <tr className="border-b border-slate-800 bg-[#1a1f2a]">
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Select
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Type
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Name
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Size
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Owner
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Group
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td
                            colSpan={6}
                            className="p-6 text-center text-sm text-slate-500"
                        >
                            Enter a valid path to browse files
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

/** Explains a path lookup failure without replacing the surrounding browser navigation. */
function UnavailablePathState(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    error: PathLoadError;
}) {
    const title =
        props.error.type === "missing"
            ? "File or directory not found"
            : "Could not read file or directory";
    return (
        <section
            role="status"
            aria-labelledby="unavailable-path-title"
            className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-6"
        >
            <div className="flex items-start gap-3">
                <Info
                    className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
                    aria-hidden="true"
                />
                <div className="min-w-0">
                    <h1
                        id="unavailable-path-title"
                        className="font-semibold text-slate-100"
                    >
                        {title}
                    </h1>
                    <p className="mt-1 wrap-break-word text-sm text-slate-300">
                        {props.error.message}
                    </p>
                    <p className="mt-2 break-all font-mono text-xs text-slate-500">
                        {props.path}
                    </p>
                </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => window.history.back()}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Go back
                </button>
                {props.parentPath ? (
                    <Link
                        to={getBrowserPathHref(props.agent, props.parentPath)}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5"
                    >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        Open parent directory
                    </Link>
                ) : null}
            </div>
        </section>
    );
}

/** Shows the current path as links while allowing direct path navigation. */
function Breadcrumbs(props: {
    agent: Agent;
    path: string;
    /** Opens the path editor immediately so a missing path can be corrected in place. */
    startEditing?: boolean;
}) {
    const navigate = useNavigate();
    const pathInputRef = React.useRef<HTMLInputElement>(null);
    const [isEditing, setIsEditing] = React.useState(
        props.startEditing === true,
    );
    const [editedPath, setEditedPath] = React.useState(props.path);

    const parts = props.path.split("/").filter((part) => part !== "");
    const isAtRoot = parts.length === 0;
    let accumulatedPath = "";

    // Keep the editor aligned with route changes, including missing-path landings.
    React.useEffect(() => {
        setEditedPath(props.path);
        if (props.startEditing) {
            setIsEditing(true);
        } else {
            setIsEditing(false);
        }
    }, [props.path, props.startEditing]);

    // Focus after paint so keyboard correction works immediately on missing paths.
    React.useEffect(() => {
        if (!isEditing) {
            return;
        }
        pathInputRef.current?.focus();
        pathInputRef.current?.select();
    }, [isEditing, props.path]);

    /** Opens the path editor with the current route path. */
    const startEditing = () => {
        setEditedPath(props.path);
        setIsEditing(true);
    };

    /** Navigates to the entered path, treating an empty or relative value helpfully. */
    const navigateToEditedPath = async (
        event: React.FormEvent<HTMLFormElement>,
    ) => {
        event.preventDefault();
        const targetPath =
            editedPath === ""
                ? "/"
                : editedPath.startsWith("/")
                  ? editedPath
                  : `/${editedPath}`;

        setIsEditing(false);
        if (targetPath === props.path) {
            return;
        }
        // Destination route decides whether the editor stays open (missing path).
        await navigate({
            to: props.agent.getBrowserUrl(targetPath),
        });
    };

    return (
        <div className="flex min-w-0 w-full items-center gap-1">
            {isEditing ? (
                <form
                    onSubmit={navigateToEditedPath}
                    className="flex min-w-0 w-full items-center gap-1"
                >
                    <input
                        ref={pathInputRef}
                        type="text"
                        value={editedPath}
                        onChange={(event) => setEditedPath(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setIsEditing(false);
                            }
                        }}
                        aria-label="File path"
                        className="min-w-0 w-full flex-1 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                    />
                    <button
                        type="submit"
                        aria-label="Navigate to path"
                        className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <Check className="h-4 w-4" />
                    </button>
                </form>
            ) : (
                <>
                    <nav
                        aria-label="Breadcrumbs"
                        className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                    >
                        {isAtRoot ? (
                            <span className="font-medium text-slate-100">
                                /
                            </span>
                        ) : (
                            <Link
                                to={props.agent.getBrowserUrl("/")}
                                className="text-blue-400 hover:underline"
                            >
                                /
                            </Link>
                        )}
                        {parts.map((part, index) => {
                            accumulatedPath = `${accumulatedPath}/${part}`;
                            const isLast = index === parts.length - 1;

                            return (
                                <div
                                    key={index}
                                    className="flex items-center gap-2"
                                >
                                    {index > 0 ? (
                                        <span className="text-slate-600">
                                            /
                                        </span>
                                    ) : null}
                                    {isLast ? (
                                        <span className="font-medium text-slate-100">
                                            {part}
                                        </span>
                                    ) : (
                                        <Link
                                            to={props.agent.getBrowserUrl(
                                                accumulatedPath,
                                            )}
                                            className="font-medium text-blue-400 hover:underline"
                                        >
                                            {part}
                                        </Link>
                                    )}
                                </div>
                            );
                        })}
                    </nav>
                    <button
                        type="button"
                        onClick={startEditing}
                        aria-label="Edit file path"
                        className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </button>
                </>
            )}
        </div>
    );
}

/** Switches between immediate directory filtering and remote recursive search. */
function FileList(props: {
    agentId: string;
    agentName: string;
    directoryPath: string;
    actions: React.ReactNode;
    files: Array<{
        name: string;
        type: string;
        size: number;
        owner: string | null;
        group: string | null;
        uid: number;
        gid: number;
    }>;
}) {
    const navigate = useNavigate();
    const agent = Route.useLoaderData().agent;
    const [filterFocusPath, setFilterFocusPath] = useAtom(filterFocusPathAtom);
    const filterInputRef = React.useRef<HTMLInputElement>(null);
    const [filter, setFilter] = React.useState("");
    const [searchRecursively, setSearchRecursively] = React.useState(false);
    const [searchState, setSearchState] = React.useState<FileSearchState>({
        status: "idle",
    });
    const normalizedFilter = filter.toLowerCase();
    const filteredFiles = props.files.filter((entry) =>
        entry.name.toLowerCase().includes(normalizedFilter),
    );

    React.useEffect(() => {
        if (filterFocusPath !== props.directoryPath) {
            return;
        }

        filterInputRef.current?.focus();
        setFilterFocusPath(null);
    }, [filterFocusPath, props.directoryPath, setFilterFocusPath]);

    React.useEffect(() => {
        const inputElement = filterInputRef.current;
        if (!searchRecursively || !inputElement) {
            return;
        }

        const searcher = new FileSearcher(agent, props.directoryPath);
        const handleResult = (event: Event) => {
            if (event instanceof CustomEvent) {
                setSearchState(event.detail);
            }
        };
        searcher.addEventListener(FILE_SEARCH_RESULT_EVENT, handleResult, {
            passive: true,
        });
        searcher.listenTo(inputElement);

        return () => {
            searcher.removeEventListener(
                FILE_SEARCH_RESULT_EVENT,
                handleResult,
            );
            searcher.dispose();
        };
    }, [agent, props.directoryPath, searchRecursively]);

    const handleFilterKeyDown = async (
        event: React.KeyboardEvent<HTMLInputElement>,
    ) => {
        if (event.key !== "Enter") {
            return;
        }

        const destinationPath = searchRecursively
            ? searchState.status === "success"
                ? searchState.results[0]?.path
                : undefined
            : filteredFiles[0]
              ? joinBrowserPath(props.directoryPath, filteredFiles[0].name)
              : undefined;
        if (!destinationPath) {
            return;
        }

        event.preventDefault();
        setFilterFocusPath(destinationPath);
        await navigate({
            to: agent.getBrowserUrl(destinationPath),
        });
    };

    return (
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]">
            {props.actions}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/35 p-2">
                <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Filter files</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                        ref={filterInputRef}
                        type="search"
                        aria-label="Filter files"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        onKeyDown={handleFilterKeyDown}
                        placeholder="Filter files"
                        className="w-full rounded-md border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                </label>
                <div className="shrink-0">
                    <Checkbox
                        role="checkbox"
                        checked={searchRecursively}
                        onCheckedChange={(checked) => {
                            setSearchRecursively(checked);
                            if (!checked) {
                                setSearchState({ status: "idle" });
                            }
                        }}
                    >
                        Search recursively
                    </Checkbox>
                </div>
            </div>
            {searchRecursively ? (
                <FileSearchResults agent={agent} state={searchState} />
            ) : (
                <table className="w-full">
                    <thead>
                        <tr className="border-b border-slate-800 bg-[#1a1f2a]">
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Select
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Type
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Name
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Size
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Owner
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-slate-400">
                                Group
                            </th>
                            <th className="text-right p-3 text-sm font-medium text-slate-400">
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredFiles.map((entry) => (
                            <FileEntry
                                key={entry.name}
                                agentId={props.agentId}
                                agentName={props.agentName}
                                directoryPath={props.directoryPath}
                                entry={entry}
                                isParent={false}
                            />
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

/** Renders recursive matches independently from metadata-rich directory entries. */
function FileSearchResults(props: { agent: Agent; state: FileSearchState }) {
    if (props.state.status === "idle") {
        return (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
                Type a file or directory name to search below this directory.
            </div>
        );
    }
    if (props.state.status === "error") {
        return (
            <div
                role="alert"
                className="bg-red-950/30 px-4 py-3 text-sm text-red-300"
            >
                {props.state.message}
            </div>
        );
    }

    return (
        <div>
            <p
                role={props.state.status === "searching" ? "status" : undefined}
                className="flex h-9 items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-4 text-xs text-slate-400"
            >
                {props.state.status === "searching" ? (
                    <>
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-blue-400" />
                        Updating results...
                    </>
                ) : (
                    `${props.state.results.length} ${props.state.results.length === 1 ? "result" : "results"}`
                )}
            </p>
            {props.state.timedOut && (
                <p className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
                    Search timed out. Showing the matches found so far.
                </p>
            )}
            {props.state.status === "searching" &&
            props.state.results.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">
                    Searching recursively...
                </p>
            ) : props.state.results.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">
                    No recursive matches found for &quot;{props.state.query}
                    &quot;.
                </p>
            ) : (
                <ul className="divide-y divide-slate-800/70">
                    {props.state.results.map((entry) => {
                        const isDirectory = entry.type === "directory";
                        return (
                            <li key={entry.path}>
                                <Link
                                    to={props.agent.getBrowserUrl(entry.path)}
                                    className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/5"
                                >
                                    {isDirectory ? (
                                        <Folder className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
                                    ) : (
                                        <File className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
                                    )}
                                    <span className="min-w-0">
                                        <span className="block font-medium text-blue-400 group-hover:underline">
                                            {entry.name}
                                        </span>
                                        <span className="block truncate font-mono text-xs text-slate-500">
                                            {entry.path}
                                        </span>
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function FileEntry(props: {
    agentId: string;
    agentName: string;
    directoryPath: string;
    entry: {
        name: string;
        type: string;
        size: number;
        owner: string | null;
        group: string | null;
        uid: number;
        gid: number;
    };
    isParent: boolean;
}) {
    const toggleSelectedFile = useSetAtom(toggleSelectedFileAtom);
    const selectedFileKeys = useAtomValue(selectedFileKeysAtom);
    const { agentId, agentName, directoryPath, entry, isParent } = props;
    const isDirectory = entry.type === "directory" || isParent;
    const fullPath = joinBrowserPath(directoryPath, entry.name);
    const agent = Route.useLoaderData().agent;
    const isSelected = selectedFileKeys.has(`${agentId}:${fullPath}`);

    return (
        <tr
            className="border-b border-slate-800/60 last:border-b-0 hover:bg-white/5"
            aria-label={`${isDirectory ? "Directory" : "File"} entry ${entry.name}`}
        >
            <td className="p-3" aria-label="">
                <Checkbox
                    label={
                        isSelected
                            ? `Unselect ${isDirectory ? "directory" : "file"} ${entry.name}`
                            : `Select ${isDirectory ? "directory" : "file"} ${entry.name}`
                    }
                    checked={isSelected}
                    onCheckedChange={() =>
                        toggleSelectedFile({
                            agentId,
                            agentName,
                            path: fullPath,
                            fileName: entry.name,
                        })
                    }
                />
            </td>
            <td className="p-3">
                {isDirectory ? (
                    <Folder className="h-5 w-5 text-blue-400" />
                ) : (
                    <File className="h-5 w-5 text-slate-500" />
                )}
            </td>
            <td className="p-3">
                <div className="flex min-w-0 items-center gap-2">
                    <Link
                        to={agent.getBrowserUrl(fullPath)}
                        className="min-w-0 truncate font-medium text-blue-400 hover:underline"
                    >
                        {entry.name}
                    </Link>
                    <RenamePathAction
                        agent={agent}
                        path={fullPath}
                        currentName={entry.name}
                        entryType={isDirectory ? "directory" : "file"}
                        navigateAfterRename={false}
                    >
                        {(renameAction) => (
                            <>
                                <Tooltip
                                    content={`Rename ${isDirectory ? "directory" : "file"}`}
                                >
                                    <button
                                        type="button"
                                        onClick={renameAction.open}
                                        aria-label={`Rename ${isDirectory ? "directory" : "file"} ${entry.name}`}
                                        className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                </Tooltip>
                                {renameAction.dialog}
                            </>
                        )}
                    </RenamePathAction>
                </div>
            </td>
            <td
                className={
                    isDirectory ? "p-3 text-slate-600" : "p-3 text-slate-400"
                }
                aria-label={`Size for ${entry.name}`}
            >
                {isDirectory ? "-" : formatSize(entry.size)}
            </td>
            <td className="p-3 text-slate-400">{entry.owner || "-"}</td>
            <td className="p-3 text-slate-400">{entry.group || "-"}</td>
            <td className="p-3 text-right">
                <Tooltip
                    content={
                        isDirectory
                            ? "Download as .tar.gz archive"
                            : "Download file"
                    }
                >
                    <a
                        href={agent.getRawUrl(fullPath, {
                            download: true,
                        })}
                        download={
                            isDirectory ? `${entry.name}.tar.gz` : entry.name
                        }
                        aria-label={
                            isDirectory
                                ? `Download directory ${entry.name} as .tar.gz`
                                : `Download file ${entry.name}`
                        }
                        className="inline-flex shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                    >
                        <Download className="h-3.5 w-3.5" />
                    </a>
                </Tooltip>
            </td>
        </tr>
    );
}

/** Converts permission bits to the compact notation people expect from Unix tools. */
function formatSymbolicPermissions(permissions: number): string {
    const permissionBits = [
        { bit: 0o400, symbol: "r" },
        { bit: 0o200, symbol: "w" },
        { bit: 0o100, symbol: "x" },
        { bit: 0o040, symbol: "r" },
        { bit: 0o020, symbol: "w" },
        { bit: 0o010, symbol: "x" },
        { bit: 0o004, symbol: "r" },
        { bit: 0o002, symbol: "w" },
        { bit: 0o001, symbol: "x" },
    ];

    return permissionBits
        .map((permission) =>
            permissions & permission.bit ? permission.symbol : "-",
        )
        .join("");
}

/** Keeps repeated metadata cells visually and semantically consistent. */
function MetadataItem(props: {
    label: string;
    value: React.ReactNode;
    valueLabel?: string;
    mono?: boolean;
}) {
    return (
        <div className="rounded-xl border border-slate-800/80 bg-slate-950/35 px-4 py-3.5">
            <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                {props.label}
            </dt>
            <dd
                aria-label={props.valueLabel}
                className={`mt-1.5 truncate text-sm font-semibold text-slate-100 ${props.mono ? "font-mono" : ""}`}
            >
                {props.value}
            </dd>
        </div>
    );
}

/** Makes raw permission bits understandable without requiring users to decode octal values. */
function PermissionsGrid(props: { permissions: number }) {
    const rows = [
        { label: "Owner", bits: [0o400, 0o200, 0o100] },
        { label: "Group", bits: [0o040, 0o020, 0o010] },
        { label: "Others", bits: [0o004, 0o002, 0o001] },
    ];
    const columns = ["Read", "Write", "Execute"];

    return (
        <div className="overflow-hidden rounded-xl border border-slate-800/80">
            <table className="w-full table-fixed text-sm">
                <thead className="bg-slate-950/60 text-xs font-medium uppercase tracking-wider text-slate-500">
                    <tr>
                        <th scope="col" className="px-3 py-3 text-left">
                            Scope
                        </th>
                        {columns.map((column) => (
                            <th
                                key={column}
                                scope="col"
                                className="px-2 py-3 text-center"
                            >
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                    {rows.map((row) => (
                        <tr key={row.label} className="bg-slate-950/25">
                            <th
                                scope="row"
                                className="px-3 py-3 text-left font-medium text-slate-300"
                            >
                                {row.label}
                            </th>
                            {row.bits.map((bit, index) => {
                                const column = columns[index];
                                if (!column) return null;

                                const isAllowed = Boolean(
                                    props.permissions & bit,
                                );
                                return (
                                    <td
                                        key={bit}
                                        aria-label={`${row.label} ${column}: ${isAllowed ? "allowed" : "not allowed"}`}
                                        className="px-2 py-2 text-center"
                                    >
                                        <span
                                            className={`inline-flex h-7 w-7 items-center justify-center rounded-md font-mono text-xs font-bold ${isAllowed ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-800/50 text-slate-600"}`}
                                        >
                                            {isAllowed
                                                ? column.charAt(0).toLowerCase()
                                                : "–"}
                                        </span>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Describes the ownership and access fields shared by files and directories. */
type FilesystemMetadata = {
    owner: string | null;
    group: string | null;
    uid: number;
    gid: number;
    permissions: number;
};

/** Presents shared filesystem identity and Unix access metadata consistently. */
function FilesystemMetadataSections(props: {
    metadata: FilesystemMetadata;
    size?: number;
    entryCount?: number;
    headingPrefix: string;
}) {
    const symbolicPermissions = formatSymbolicPermissions(
        props.metadata.permissions,
    );
    const octalPermissions = `0${props.metadata.permissions
        .toString(8)
        .padStart(3, "0")}`;
    const headingIdPrefix = props.headingPrefix.toLowerCase();

    return (
        <div className="grid gap-8 p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(21rem,0.72fr)]">
            <section aria-labelledby={`${headingIdPrefix}-metadata-heading`}>
                <div className="mb-4">
                    <h2
                        id={`${headingIdPrefix}-metadata-heading`}
                        className="text-base font-semibold text-slate-100"
                    >
                        Metadata
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Filesystem identity and storage information.
                    </p>
                </div>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {props.size === undefined ? null : (
                        <MetadataItem
                            label="Size"
                            value={formatSize(props.size)}
                            valueLabel="File size value"
                        />
                    )}
                    {props.entryCount === undefined ? null : (
                        <MetadataItem
                            label="Entries"
                            value={props.entryCount}
                            valueLabel="Directory entry count"
                        />
                    )}
                    <MetadataItem
                        label="Owner"
                        value={props.metadata.owner || "Unknown"}
                    />
                    <MetadataItem
                        label="Group"
                        value={props.metadata.group || "Unknown"}
                    />
                    <MetadataItem label="UID" value={props.metadata.uid} mono />
                    <MetadataItem label="GID" value={props.metadata.gid} mono />
                    <MetadataItem
                        label="Permissions"
                        value={`${symbolicPermissions} · ${octalPermissions}`}
                        mono
                    />
                </dl>
            </section>

            <section aria-labelledby={`${headingIdPrefix}-permissions-heading`}>
                <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                        <h2
                            id={`${headingIdPrefix}-permissions-heading`}
                            className="text-base font-semibold text-slate-100"
                        >
                            Permissions
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Access granted by the Unix mode.
                        </p>
                    </div>
                    <div className="text-right font-mono">
                        <p className="text-sm font-semibold text-slate-200">
                            {symbolicPermissions}
                        </p>
                        <p className="text-xs text-slate-500">
                            {octalPermissions}
                        </p>
                    </div>
                </div>
                <PermissionsGrid permissions={props.metadata.permissions} />
            </section>
        </div>
    );
}

/** Renames the current entry in a focused workflow and follows its new URL. */
function RenamePathDialog(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit";
    navigateAfterRename: boolean;
    isOpen: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const router = useRouter();
    const nameInputRef = React.useRef<HTMLInputElement>(null);
    const [name, setName] = React.useState(props.currentName);
    const [renameState, setRenameState] = React.useState<RenameState>({
        type: "idle",
    });
    const parentPath = getImmediateParentPath(props.path);
    const trimmedName = name.trim();
    const isRenaming = renameState.type === "renaming";
    const canRename =
        parentPath !== null &&
        trimmedName.length > 0 &&
        trimmedName !== props.currentName &&
        !trimmedName.includes("/") &&
        trimmedName !== "." &&
        trimmedName !== "..";

    React.useEffect(() => {
        setName(props.currentName);
        setRenameState({ type: "idle" });
    }, [props.currentName, props.isOpen, props.path]);

    React.useEffect(() => {
        if (!props.isOpen) {
            return;
        }

        // Preserve extensions during typing, while treating a leading dot as part of the name.
        const firstDotIndex = props.currentName.indexOf(".", 1);
        const selectionEnd =
            firstDotIndex === -1 ? props.currentName.length : firstDotIndex;
        nameInputRef.current?.focus();
        nameInputRef.current?.setSelectionRange(0, selectionEnd);
    }, [props.currentName, props.isOpen]);

    const handleRename = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (parentPath === null) {
            setRenameState({
                type: "error",
                message: "The filesystem root cannot be renamed",
            });
            return;
        }
        if (!trimmedName) {
            setRenameState({
                type: "error",
                message: `${props.entryType === "file" ? "File" : "Directory"} name is required`,
            });
            return;
        }
        if (
            trimmedName.includes("/") ||
            trimmedName === "." ||
            trimmedName === ".."
        ) {
            setRenameState({
                type: "error",
                message: "Name must be a single path component",
            });
            return;
        }
        if (trimmedName === props.currentName) {
            return;
        }

        const destinationPath = joinBrowserPath(parentPath, trimmedName);
        setRenameState({ type: "renaming" });

        try {
            await props.agent.renamePath(props.path, destinationPath);
            props.onClose();
            if (!props.navigateAfterRename) {
                await router.invalidate();
                return;
            }
            await navigate({
                to: props.agent.getBrowserUrl(destinationPath),
                search:
                    props.view === "details"
                        ? { view: "details" }
                        : props.view === "edit"
                          ? { view: "edit" }
                          : {},
            });
        } catch (error) {
            setRenameState({
                type: "error",
                message: getErrorMessage(error, "Rename failed"),
            });
        }
    };

    const label = `Rename ${props.entryType}`;

    return (
        <Dialog
            isOpen={props.isOpen}
            title={`Rename ${props.entryType}`}
            description={`Choose a new name for ${props.currentName}.`}
            closeAriaLabel={`Close rename ${props.entryType} dialog`}
            isBusy={isRenaming}
            errorMessage={
                renameState.type === "error" ? renameState.message : null
            }
            onClose={props.onClose}
        >
            <form onSubmit={handleRename} className="mt-4">
                <label
                    htmlFor={`${props.entryType}-rename-input`}
                    className="mb-2 block text-sm font-medium text-slate-300"
                >
                    New name
                </label>
                <input
                    ref={nameInputRef}
                    id={`${props.entryType}-rename-input`}
                    type="text"
                    value={name}
                    onChange={(event) => {
                        setName(event.target.value);
                        if (renameState.type === "error") {
                            setRenameState({ type: "idle" });
                        }
                    }}
                    aria-label={label}
                    disabled={isRenaming || parentPath === null}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={props.onClose}
                        disabled={isRenaming}
                        className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!canRename || isRenaming}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Pencil className="h-4 w-4" />
                        {isRenaming ? "Renaming..." : "Rename"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}

/** Owns the rename workflow so different surfaces can provide their own trigger. */
function RenamePathAction(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit";
    navigateAfterRename?: boolean;
    children: (action: {
        open: () => void;
        disabled: boolean;
        dialog: React.ReactNode;
    }) => React.ReactNode;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const disabled = getImmediateParentPath(props.path) === null;

    return props.children({
        open: () => setIsOpen(true),
        disabled,
        dialog: (
            <RenamePathDialog
                agent={props.agent}
                path={props.path}
                currentName={props.currentName}
                entryType={props.entryType}
                view={props.view}
                navigateAfterRename={props.navigateAfterRename !== false}
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
            />
        ),
    });
}

/** Keeps rename and destructive object actions out of the primary action row. */
function PathMoreActions(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit";
    onDelete?: () => void;
}) {
    const canModify = getImmediateParentPath(props.path) !== null;

    return (
        <RenamePathAction
            agent={props.agent}
            path={props.path}
            currentName={props.currentName}
            entryType={props.entryType}
            view={props.view}
        >
            {(renameAction) => (
                <>
                    <ActionMenu
                        label="More"
                        icon={<MoreHorizontal className="h-4 w-4" />}
                    >
                        {(close) => (
                            <>
                                <ActionMenuButton
                                    disabled={renameAction.disabled}
                                    onClick={() => {
                                        close();
                                        renameAction.open();
                                    }}
                                >
                                    <Pencil className="h-4 w-4 text-slate-400" />
                                    Rename
                                </ActionMenuButton>
                                {props.onDelete ? (
                                    <>
                                        <div className="my-1 border-t border-slate-800" />
                                        <ActionMenuButton
                                            tone="danger"
                                            disabled={!canModify}
                                            onClick={() => {
                                                close();
                                                props.onDelete?.();
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                            Delete {props.entryType}
                                        </ActionMenuButton>
                                    </>
                                ) : null}
                            </>
                        )}
                    </ActionMenu>
                    {renameAction.dialog}
                </>
            )}
        </RenamePathAction>
    );
}

/** Keeps object-level actions stable while each representation supplies its own controls. */
function PersistentPathActions(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit";
    downloadUrl: string;
    downloadName: string;
    /** Explains archive packaging when the download is a directory tarball. */
    downloadTooltip?: string;
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.path);
    const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = React.useState(false);
    const [deleteState, setDeleteState] = React.useState<DeleteState>({
        type: "idle",
    });

    const closeDeleteDialog = () => {
        if (deleteState.type === "deleting") {
            return;
        }
        setIsConfirmDeleteOpen(false);
        setDeleteState({ type: "idle" });
    };

    const handleDelete = async () => {
        if (parentPath === null) {
            return;
        }
        setDeleteState({ type: "deleting" });
        try {
            await props.agent.deleteFile(props.path);
            setIsConfirmDeleteOpen(false);
            setDeleteState({ type: "idle" });
            await navigate({ to: props.agent.getBrowserUrl(parentPath) });
        } catch (error) {
            setDeleteState({
                type: "error",
                message: getErrorMessage(error, "Delete failed"),
            });
        }
    };

    const downloadLink = (
        <a
            href={props.downloadUrl}
            download={props.downloadName}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500"
        >
            <Download className="h-4 w-4" />
            Download
        </a>
    );

    return (
        <>
            <NativeOpenButton agent={props.agent} path={props.path} />
            {props.downloadTooltip ? (
                <Tooltip content={props.downloadTooltip}>
                    {downloadLink}
                </Tooltip>
            ) : (
                downloadLink
            )}
            <PathMoreActions
                agent={props.agent}
                path={props.path}
                currentName={props.currentName}
                entryType={props.entryType}
                view={props.view}
                onDelete={() => {
                    setDeleteState({ type: "idle" });
                    setIsConfirmDeleteOpen(true);
                }}
            />
            <ConfirmationDialog
                isOpen={isConfirmDeleteOpen}
                title={`Delete this ${props.entryType}?`}
                description={
                    <>
                        This permanently deletes
                        <span className="mx-1 break-all font-medium text-slate-100">
                            {props.currentName}
                        </span>
                        from the agent filesystem.
                    </>
                }
                confirmLabel={`Delete ${props.entryType}`}
                busyLabel="Deleting..."
                isBusy={deleteState.type === "deleting"}
                errorMessage={
                    deleteState.type === "error" ? deleteState.message : null
                }
                onClose={closeDeleteDialog}
                onConfirm={handleDelete}
            >
                <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                    {props.path}
                </p>
            </ConfirmationDialog>
        </>
    );
}

/** Launches one remote path on the agent desktop while reporting the asynchronous result. */
function NativeOpenButton(props: { agent: Agent; path: string }) {
    const [openState, setOpenState] = React.useState<NativeOpenState>({
        type: "idle",
    });

    if (!props.agent.supportsNativeOpen) {
        return null;
    }

    const handleOpen = async () => {
        setOpenState({ type: "opening" });
        try {
            await props.agent.openPath(props.path);
            setOpenState({
                type: "success",
                message: "Opened on the agent computer",
            });
        } catch (error) {
            setOpenState({
                type: "error",
                message: getErrorMessage(error, "Could not open the path"),
            });
        }
    };

    return (
        <>
            <button
                type="button"
                disabled={openState.type === "opening"}
                onClick={handleOpen}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-wait disabled:opacity-60"
            >
                {openState.type === "opening" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                    <ExternalLink className="h-4 w-4" />
                )}
                {openState.type === "opening" ? "Opening..." : "Open natively"}
            </button>
            {openState.type === "success" || openState.type === "error" ? (
                <Toast
                    tone={openState.type === "error" ? "error" : "success"}
                    icon={<ExternalLink className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss native open message"
                    onDismiss={() => setOpenState({ type: "idle" })}
                >
                    {openState.message}
                </Toast>
            ) : null}
        </>
    );
}

/** Presents file and directory identity consistently while allowing file-only path copying. */
function PathDetailHeader(props: {
    entryType: "file" | "directory";
    name: string;
    path: string;
    pathCopied?: boolean;
    onCopyPath?: () => void;
}) {
    const isDirectory = props.entryType === "directory";
    const typeLabel = isDirectory ? "Directory" : "File";

    return (
        <header className="relative overflow-hidden border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
            <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/5 blur-3xl" />
            <div className="relative flex min-w-0 items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 shadow-inner shadow-blue-400/10">
                    {isDirectory ? (
                        <Folder className="h-7 w-7 text-blue-400" />
                    ) : (
                        <File className="h-7 w-7 text-blue-400" />
                    )}
                </div>
                <div className="min-w-0 pt-0.5">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        {typeLabel} details
                    </p>
                    <h1
                        aria-label={`${typeLabel} name`}
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.name}
                    </h1>
                </div>
            </div>
            <div className="relative mt-6">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                        Full Path
                    </p>
                    {props.onCopyPath ? (
                        <button
                            type="button"
                            onClick={props.onCopyPath}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-200"
                            aria-label="Copy full path"
                        >
                            {props.pathCopied ? (
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                            {props.pathCopied ? "Copied" : "Copy"}
                        </button>
                    ) : null}
                </div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 font-mono text-sm text-slate-300">
                    {props.path}
                </code>
            </div>
        </header>
    );
}

/** Presents directory metadata while the query-selected details view replaces the file list. */
function DirectoryDetailView(props: {
    path: string;
    directoryName: string;
    lsResult: LsDirectoryResponse;
}) {
    return (
        <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            <PathDetailHeader
                entryType="directory"
                name={props.directoryName}
                path={props.path}
            />

            <FilesystemMetadataSections
                metadata={props.lsResult}
                entryCount={props.lsResult.files.length}
                headingPrefix="directory"
            />
        </article>
    );
}

/** Keeps parent navigation and both file representations identical across views. */
function FileViewNavigation(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    activeView: "details" | "view";
}) {
    return (
        <>
            <Link
                to={getBrowserPathHref(props.agent, props.parentPath ?? "/")}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
            >
                <ArrowUp className="h-4 w-4" />
                Up
            </Link>
            <ViewSwitch label="File view">
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{}}
                    aria-current={
                        props.activeView === "details" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "details",
                    )}
                >
                    <Info className="h-4 w-4" />
                    Details
                </Link>
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{ view: "edit" }}
                    aria-current={
                        props.activeView === "view" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "view",
                    )}
                >
                    <File className="h-4 w-4" />
                    View
                </Link>
            </ViewSwitch>
        </>
    );
}

/** Keeps file navigation and object actions identical across its representations. */
function FilePageHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
    activeView: "details" | "view";
}) {
    const parentPath = getImmediateParentPath(props.path);

    return (
        <BrowserPageHeader
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            actionLabel="File actions"
            navigation={
                <FileViewNavigation
                    agent={props.agent}
                    path={props.path}
                    parentPath={parentPath}
                    activeView={props.activeView}
                />
            }
            actions={
                <PersistentPathActions
                    agent={props.agent}
                    path={props.path}
                    currentName={props.fileName}
                    entryType="file"
                    view={props.activeView === "view" ? "edit" : undefined}
                    downloadUrl={props.downloadUrl}
                    downloadName={props.fileName}
                />
            }
        />
    );
}

/** Presents file metadata and destructive actions with clear visual separation. */
function FileDetailView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
    initialOneTimeTokens: Array<string>;
}) {
    const [copiedCommand, setCopiedCommand] = React.useState<string | null>(
        null,
    );
    const [oneTimeTokens, setOneTimeTokens] = React.useState(
        props.initialOneTimeTokens,
    );
    const [shareableLinkState, setShareableLinkState] =
        React.useState<ShareableLinkState>({ type: "idle" });

    React.useEffect(() => {
        setOneTimeTokens(props.initialOneTimeTokens);
        setShareableLinkState({ type: "idle" });
    }, [props.path, props.initialOneTimeTokens]);

    const copyToClipboard = async (text: string, commandType: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedCommand(commandType);
            setTimeout(() => setCopiedCommand(null), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    const handleCreateShareableLink = async () => {
        setShareableLinkState({ type: "creating" });

        try {
            const response = await props.agent.createOneTimeToken(
                props.lsResult.path,
            );
            setOneTimeTokens((tokens) => [...tokens, response.one_time_token]);
            setShareableLinkState({ type: "idle" });
        } catch (error) {
            setShareableLinkState({
                type: "error",
                message: getErrorMessage(
                    error,
                    "Could not create a shareable link",
                ),
            });
        }
    };

    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="details"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <PathDetailHeader
                    entryType="file"
                    name={props.fileName}
                    path={props.lsResult.path}
                    pathCopied={copiedCommand === "path"}
                    onCopyPath={() =>
                        copyToClipboard(props.lsResult.path, "path")
                    }
                />

                <FilesystemMetadataSections
                    metadata={props.lsResult}
                    size={props.lsResult.size}
                    headingPrefix="file"
                />

                <ShareableLinksSection
                    downloadUrl={props.downloadUrl}
                    oneTimeTokens={oneTimeTokens}
                    state={shareableLinkState}
                    copiedCommand={copiedCommand}
                    onCreate={handleCreateShareableLink}
                    onCopy={copyToClipboard}
                />
            </article>
        </div>
    );
}

/** Displays one-time download links and preserves their associated copy affordances. */
function ShareableLinksSection(props: {
    downloadUrl: string;
    oneTimeTokens: Array<string>;
    state: ShareableLinkState;
    copiedCommand: string | null;
    onCreate: () => void;
    onCopy: (text: string, commandType: string) => void;
}) {
    return (
        <section
            aria-labelledby="shareable-links-heading"
            className="border-t border-slate-800 bg-slate-950/15 p-6 md:p-8"
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2
                        id="shareable-links-heading"
                        className="text-base font-semibold text-slate-100"
                    >
                        Shareable links
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Create an anonymous link for a single download.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={props.onCreate}
                    disabled={props.state.type === "creating"}
                    className="inline-flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-300 transition hover:border-blue-500/50 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <Download className="h-4 w-4" />
                    {props.state.type === "creating"
                        ? "Creating link..."
                        : "Create shareable link"}
                </button>
            </div>

            {props.state.type === "error" ? (
                <p
                    role="alert"
                    className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
                >
                    {props.state.message}
                </p>
            ) : null}

            {props.oneTimeTokens.length > 0 ? (
                <div className="mt-5 grid gap-4">
                    {props.oneTimeTokens.map((token, index) => (
                        <ShareableLinkCard
                            key={token}
                            token={token}
                            linkNumber={index + 1}
                            downloadUrl={props.downloadUrl}
                            copiedCommand={props.copiedCommand}
                            onCopy={props.onCopy}
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

/** Keeps link-specific commands and feedback together for each generated token. */
function ShareableLinkCard(props: {
    token: string;
    linkNumber: number;
    downloadUrl: string;
    copiedCommand: string | null;
    onCopy: (text: string, commandType: string) => void;
}) {
    const shareableUrl = `${props.downloadUrl}?one_time_token=${encodeURIComponent(props.token)}`;
    const wgetCommand = `wget --content-disposition "${shareableUrl}"`;
    const curlCommand = `curl -JO "${shareableUrl}"`;
    const copyKeyPrefix = `one-time-${props.token}`;

    return (
        <article
            aria-label={`One-time shareable link ${props.linkNumber}`}
            className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/30 p-4"
        >
            <p className="text-sm font-semibold text-slate-200">
                One-time shareable link {props.linkNumber}
            </p>
            <p className="mt-1 text-sm text-amber-300/90">
                This link works only once. The first download consumes it, and
                later requests will be rejected.
            </p>
            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <a
                    href={shareableUrl}
                    className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-blue-300 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-200"
                >
                    {shareableUrl}
                </a>
                <button
                    type="button"
                    onClick={() =>
                        props.onCopy(shareableUrl, `${copyKeyPrefix}-link`)
                    }
                    aria-label={`Copy shareable link ${props.linkNumber}`}
                    className="shrink-0 rounded-md p-2 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                >
                    {props.copiedCommand === `${copyKeyPrefix}-link` ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                </button>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
                <CopyableCodeRow
                    label="wget"
                    value={wgetCommand}
                    copyAriaLabel={`Copy wget command for shareable link ${props.linkNumber}`}
                />
                <CopyableCodeRow
                    label="curl"
                    value={curlCommand}
                    copyAriaLabel={`Copy curl command for shareable link ${props.linkNumber}`}
                />
            </div>
        </article>
    );
}

type FileEditLoadState =
    | { type: "loading" }
    | { type: "ready" }
    | { type: "error"; message: string };

type FileEditSaveState =
    | { type: "idle" }
    | { type: "saving" }
    | { type: "saved" }
    | { type: "error"; message: string };

/** Keeps save state and editor mutations inside the representation they affect. */
function FileEditActions(props: {
    statusMessage: string | null;
    hasError: boolean;
    isSaved: boolean;
    canEdit: boolean;
    isDirty: boolean;
    isSaving: boolean;
    onRestore: () => void;
    onSave: () => void;
}) {
    return (
        <>
            {props.statusMessage ? (
                <span
                    role="status"
                    aria-label="File edit status"
                    aria-live="polite"
                    className={`px-2 text-sm ${
                        props.hasError
                            ? "text-red-300"
                            : props.isSaved
                              ? "text-emerald-300"
                              : "text-slate-400"
                    }`}
                >
                    {props.statusMessage}
                </span>
            ) : null}
            <button
                type="button"
                aria-label="Restore file contents"
                onClick={props.onRestore}
                disabled={!props.canEdit || !props.isDirty}
                className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
                Restore
            </button>
            <button
                type="button"
                aria-label="Save file"
                onClick={props.onSave}
                disabled={!props.canEdit || !props.isDirty}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {props.isSaving ? "Saving..." : "Save"}
            </button>
        </>
    );
}

/** Edits plain-text file contents in one textarea with explicit save/restore. */
function FileEditView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    filePath: string;
    mimeType: string;
    downloadUrl: string;
}) {
    const agentRef = React.useRef(props.agent);
    agentRef.current = props.agent;
    const [loadState, setLoadState] = React.useState<FileEditLoadState>({
        type: "loading",
    });
    const [saveState, setSaveState] = React.useState<FileEditSaveState>({
        type: "idle",
    });
    const [savedContent, setSavedContent] = React.useState("");
    const [content, setContent] = React.useState("");

    React.useEffect(() => {
        let cancelled = false;

        const loadContent = async () => {
            setLoadState({ type: "loading" });
            setSaveState({ type: "idle" });

            try {
                // Read through a ref so route loader identity changes do not wipe in-progress edits.
                const response = await agentRef.current.download(
                    props.filePath,
                );
                const text = await response.text();
                if (cancelled) {
                    return;
                }
                setSavedContent(text);
                setContent(text);
                setLoadState({ type: "ready" });
            } catch (error) {
                if (cancelled) {
                    return;
                }
                setLoadState({
                    type: "error",
                    message: getErrorMessage(error, "Failed to load file"),
                });
            }
        };

        void loadContent();

        return () => {
            cancelled = true;
        };
    }, [props.filePath]);

    const isDirty = content !== savedContent;
    const isSaving = saveState.type === "saving";
    const canEdit = loadState.type === "ready" && !isSaving;

    const handleRestore = () => {
        if (!canEdit) {
            return;
        }
        setContent(savedContent);
        setSaveState({ type: "idle" });
    };

    const handleSave = async () => {
        if (!canEdit) {
            return;
        }

        setSaveState({ type: "saving" });

        try {
            await agentRef.current.upload(
                props.filePath,
                new globalThis.File([content], props.fileName, {
                    type: props.mimeType || "text/plain",
                }),
            );
            setSavedContent(content);
            setSaveState({ type: "saved" });
        } catch (error) {
            setSaveState({
                type: "error",
                message: getErrorMessage(error, "Failed to save file"),
            });
        }
    };

    const statusMessage =
        loadState.type === "loading"
            ? "Loading file..."
            : loadState.type === "error"
              ? loadState.message
              : saveState.type === "saving"
                ? "Saving..."
                : saveState.type === "saved"
                  ? "Saved"
                  : saveState.type === "error"
                    ? saveState.message
                    : isDirty
                      ? "Unsaved changes"
                      : null;

    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Edit file
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                    <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <FileEditActions
                            statusMessage={statusMessage}
                            hasError={
                                loadState.type === "error" ||
                                saveState.type === "error"
                            }
                            isSaved={saveState.type === "saved"}
                            canEdit={canEdit}
                            isDirty={isDirty}
                            isSaving={isSaving}
                            onRestore={handleRestore}
                            onSave={() => {
                                void handleSave();
                            }}
                        />
                    </div>
                </header>

                <div className="p-4 md:p-6">
                    {loadState.type === "loading" ? (
                        <p className="text-sm text-slate-400">
                            Loading file...
                        </p>
                    ) : loadState.type === "error" ? (
                        <p className="text-sm text-red-300">
                            {loadState.message}
                        </p>
                    ) : (
                        <textarea
                            aria-label="File editor"
                            value={content}
                            onChange={(event) => {
                                setContent(event.target.value);
                                if (saveState.type === "saved") {
                                    setSaveState({ type: "idle" });
                                }
                            }}
                            disabled={!canEdit}
                            spellCheck={false}
                            className="min-h-[70vh] w-full resize-y rounded-xl border border-slate-700 bg-slate-950/80 p-4 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                    )}
                </div>
            </article>
        </div>
    );
}

/** Renders agent-verified images through the authenticated raw download URL. */
function FileImageView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
}) {
    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Image
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                </header>

                <div className="flex items-center justify-center p-4 md:p-6">
                    <img
                        src={props.downloadUrl}
                        alt={props.fileName}
                        className="max-h-[70vh] max-w-full rounded-xl object-contain"
                    />
                </div>
            </article>
        </div>
    );
}

/** Explains that the agent did not mark this path as text-editable or image-viewable. */
function UnsupportedFileView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
}) {
    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Unsupported file
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                </header>

                <div className="p-6 md:p-8">
                    <p
                        aria-label="Unsupported file type"
                        className="text-sm text-slate-300"
                    >
                        Viewing this file type is not supported
                    </p>
                </div>
            </article>
        </div>
    );
}
