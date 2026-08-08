import React from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
    createFileRoute,
    Link,
    useNavigate,
    useRouter,
    useRouterState,
} from "@tanstack/react-router";
import {
    Folder,
    FolderPlus,
    File,
    ArrowUp,
    AlertCircle,
    Download,
    ArrowLeft,
    Copy,
    Check,
    Upload,
    Trash2,
    Square,
    CheckSquare,
    Eye,
    EyeOff,
    Info,
    List,
} from "lucide-react";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Dialog } from "../components/dialog";
import { atomWithLocalStorage } from "../utils/local-storage-atom";
import { formatSize } from "../utils/path";
import {
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsDirectoryResponse,
    type LsFileResponse,
} from "../api-client";
import {
    selectedFileKeysAtom,
    selectedFilesAtom,
    toggleSelectedFileAtom,
    unselectFileAtom,
} from "../selected-files";

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };

type CreateDirectoryState =
    | { type: "idle" }
    | { type: "creating" }
    | { type: "error"; message: string };

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
    validateSearch: (search): { view?: "details" } => ({
        view: search.view === "details" ? "details" : undefined,
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

        const path = `/${params._splat ?? ""}`;
        const lsResult: LsResponse = await agent.ls(path);
        const downloadUrl = isLsFileResponse(lsResult)
            ? agent.getRawUrl(lsResult.path)
            : undefined;

        return {
            agent,
            agentId: agent.id,
            agentName: agent.name,
            path,
            lsResult,
            downloadUrl,
            agents: rootLoaderData.agents,
        };
    },
    component: FileBrowser,
    errorComponent: FileBrowserError,
});

function FileBrowser() {
    const data = Route.useLoaderData();
    const { agent, agentId, agentName, path, lsResult } = data;
    const search = Route.useSearch();
    const [showHiddenFiles, setShowHiddenFiles] = useAtom(showHiddenFilesAtom);

    const parentPath = getImmediateParentPath(path);

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
                        agentName={agentName}
                        path={path}
                        parentPath={parentPath}
                        directoryPath={path}
                        showHiddenFiles={showHiddenFiles}
                        isDetailsView={isDetailsView}
                        onToggleHiddenFiles={() =>
                            setShowHiddenFiles((prev) => !prev)
                        }
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
                        <>
                            <CopySelectedFilesAction
                                agents={data.agents}
                                destinationAgent={agent}
                                directoryPath={path}
                            />

                            <FileList
                                agentId={agentId}
                                agentName={agentName}
                                directoryPath={path}
                                files={sortedFiles}
                            />
                        </>
                    )}
                </div>
            </div>
        );
    }

    if (isLsFileResponse(lsResult)) {
        const fileName = path.split("/").pop() || lsResult.path;
        const downloadUrl = data.downloadUrl;
        if (!downloadUrl) {
            return (
                <FileBrowserError
                    error={new Error("Download URL unavailable")}
                />
            );
        }

        return (
            <div className="p-6">
                <div className="mx-auto max-w-6xl">
                    <FileDetailView
                        agent={agent}
                        agentId={agentId}
                        agentName={agentName}
                        path={path}
                        fileName={fileName}
                        lsResult={lsResult}
                        downloadUrl={downloadUrl}
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
        <div className="mb-4 flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/35 px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-slate-400">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-800 text-slate-300">
                    <Copy className="h-3.5 w-3.5" />
                </span>
                <span>
                    {selectedFiles.length === 0
                        ? "Select files to copy them here"
                        : `${selectedFiles.length} ${selectedFiles.length === 1 ? "item" : "items"} selected`}
                </span>
                {statusMessage ? (
                    <span
                        role={copyState.type === "error" ? "alert" : "status"}
                        aria-live="polite"
                        className={`ml-2 ${copyState.type === "error" ? "text-red-400" : "text-emerald-400"}`}
                    >
                        {statusMessage}
                    </span>
                ) : null}
            </div>
            <button
                type="button"
                onClick={handleCopySelectedFiles}
                aria-label="Copy selected files here"
                disabled={
                    selectedFiles.length === 0 || isCopying || isRoutePending
                }
                className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 shadow-sm transition-colors hover:border-slate-600 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
            >
                <Copy className="h-3.5 w-3.5" />
                {isCopying ? "Copying..." : "Copy here"}
            </button>
        </div>
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
function CreateDirectoryAction(props: { agent: Agent; directoryPath: string }) {
    const navigate = useNavigate();
    const inputId = React.useId();
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);
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
        setIsDialogOpen(false);
        setDirectoryName("");
        setCreateDirectoryState({ type: "idle" });
    };

    const closeDialog = () => {
        if (isCreating) {
            return;
        }

        resetDialog();
    };

    const openDialog = () => {
        setDirectoryName("");
        setCreateDirectoryState({ type: "idle" });
        setIsDialogOpen(true);
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
        <>
            <button
                type="button"
                onClick={openDialog}
                aria-label="Create directory"
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
            >
                <FolderPlus className="h-4 w-4 text-slate-400" />
                New directory
            </button>

            <Dialog
                isOpen={isDialogOpen}
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
        </>
    );
}

/** Separates location context, navigation, and directory actions by purpose. */
function BrowserHeader(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    path: string;
    parentPath: string | null;
    directoryPath: string;
    showHiddenFiles: boolean;
    isDetailsView: boolean;
    onToggleHiddenFiles: () => void;
}) {
    return (
        <header className="mb-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <Breadcrumbs
                    agentId={props.agentId}
                    agentName={props.agentName}
                    agent={props.agent}
                    path={props.path}
                />
                <Link
                    to="/agents/$agentId"
                    params={{ agentId: props.agentId }}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to Agent
                </Link>
            </div>

            <div
                aria-label="File browser actions"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/80 bg-slate-900/70 p-1.5 shadow-sm"
            >
                <div className="flex flex-wrap items-center gap-1">
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
                    <div className="mx-1 h-5 w-px bg-slate-700" />
                    {props.isDetailsView ? (
                        <Link
                            to={getBrowserPathHref(
                                props.agent,
                                props.directoryPath,
                            )}
                            search={{}}
                            className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-blue-300 transition-colors hover:bg-white/5 hover:text-blue-200"
                        >
                            <List className="h-4 w-4" />
                            View files
                        </Link>
                    ) : (
                        <>
                            <Link
                                to={getBrowserPathHref(
                                    props.agent,
                                    props.directoryPath,
                                )}
                                search={{ view: "details" }}
                                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                            >
                                <Info className="h-4 w-4" />
                                View details
                            </Link>
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
                                {props.showHiddenFiles
                                    ? "Hide hidden"
                                    : "Show hidden"}
                            </button>
                        </>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                    <CreateDirectoryAction
                        agent={props.agent}
                        directoryPath={props.directoryPath}
                    />
                    <UploadFilesAction
                        agent={props.agent}
                        directoryPath={props.directoryPath}
                    />
                </div>
            </div>
        </header>
    );
}

function Breadcrumbs(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    path: string;
}) {
    const { agentName, path } = props;

    const parts = path.split("/").filter((part) => part !== "");
    const isAtRoot = parts.length === 0;
    let accumulatedPath = "";

    return (
        <nav
            aria-label="Breadcrumbs"
            className="flex flex-wrap items-center gap-2 text-sm"
        >
            <Link
                to={props.agent.getBrowserUrl(props.agent.cwd)}
                className="text-blue-400 hover:underline"
            >
                {agentName}
            </Link>
            <span className="text-slate-600">/</span>
            {isAtRoot ? (
                <span className="font-medium text-slate-100">/</span>
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
                    <div key={index} className="flex items-center gap-2">
                        <span className="text-slate-600">/</span>
                        {isLast ? (
                            <span className="font-medium text-slate-100">
                                {part}
                            </span>
                        ) : (
                            <Link
                                to={props.agent.getBrowserUrl(accumulatedPath)}
                                className="font-medium text-blue-400 hover:underline"
                            >
                                {part}
                            </Link>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}

function FileList(props: {
    agentId: string;
    agentName: string;
    directoryPath: string;
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
    const { agentId, agentName, directoryPath, files } = props;

    return (
        <table className="w-full rounded-lg border border-slate-800 bg-[#11141b]">
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
                </tr>
            </thead>
            <tbody>
                {files.map((entry, index) => (
                    <FileEntry
                        key={index}
                        agentId={agentId}
                        agentName={agentName}
                        directoryPath={directoryPath}
                        entry={entry}
                        isParent={false}
                    />
                ))}
            </tbody>
        </table>
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
                <button
                    type="button"
                    aria-label={
                        isSelected
                            ? `Unselect ${isDirectory ? "directory" : "file"} ${entry.name}`
                            : `Select ${isDirectory ? "directory" : "file"} ${entry.name}`
                    }
                    title={
                        isSelected
                            ? `Unselect ${isDirectory ? "directory" : "file"} ${entry.name}`
                            : `Select ${isDirectory ? "directory" : "file"} ${entry.name}`
                    }
                    aria-pressed={isSelected}
                    onClick={() =>
                        toggleSelectedFile({
                            agentId,
                            agentName,
                            path: fullPath,
                            fileName: entry.name,
                        })
                    }
                    className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                >
                    {isSelected ? (
                        <CheckSquare className="h-4 w-4 text-blue-400" />
                    ) : (
                        <Square className="h-4 w-4" />
                    )}
                </button>
            </td>
            <td className="p-3">
                {isDirectory ? (
                    <Folder className="h-5 w-5 text-blue-400" />
                ) : (
                    <File className="h-5 w-5 text-slate-500" />
                )}
            </td>
            <td className="p-3">
                <Link
                    to={agent.getBrowserUrl(fullPath)}
                    className={`${isDirectory ? "flex items-center gap-3 " : ""}text-blue-400 font-medium hover:underline`}
                >
                    {entry.name}
                </Link>
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

/** Keeps shell commands readable on narrow screens while leaving copy controls accessible. */
function CommandDownloadRow(props: {
    label: string;
    command: string;
    isCopied: boolean;
    onCopy: () => void;
}) {
    return (
        <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/50">
            <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-2">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {props.label}
                </span>
                <button
                    type="button"
                    onClick={props.onCopy}
                    className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                    aria-label={`Copy ${props.label} command`}
                >
                    {props.isCopied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                        <Copy className="h-3.5 w-3.5" />
                    )}
                    {props.isCopied ? "Copied" : "Copy"}
                </button>
            </div>
            <code className="block overflow-x-auto whitespace-nowrap px-4 py-3 font-mono text-sm text-slate-300">
                {props.command}
            </code>
        </div>
    );
}

/** Presents directory metadata while the query-selected details view replaces the file list. */
function DirectoryDetailView(props: {
    path: string;
    directoryName: string;
    lsResult: LsDirectoryResponse;
}) {
    return (
        <article className="overflow-hidden rounded-2xl border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            <header className="relative overflow-hidden border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
                <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/5 blur-3xl" />
                <div className="relative flex min-w-0 items-start gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 shadow-inner shadow-blue-400/10">
                        <Folder className="h-7 w-7 text-blue-400" />
                    </div>
                    <div className="min-w-0 pt-0.5">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                            Directory details
                        </p>
                        <h1
                            aria-label="Directory name"
                            className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                        >
                            {props.directoryName}
                        </h1>
                    </div>
                </div>

                <div className="relative mt-6">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                        Full Path
                    </p>
                    <code className="block overflow-x-auto whitespace-nowrap rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 font-mono text-sm text-slate-300">
                        {props.path}
                    </code>
                </div>
            </header>

            <FilesystemMetadataSections
                metadata={props.lsResult}
                entryCount={props.lsResult.files.length}
                headingPrefix="directory"
            />
        </article>
    );
}

/** Presents file metadata and destructive actions with clear visual separation. */
function FileDetailView(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    path: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.path);

    const [copiedCommand, setCopiedCommand] = React.useState<string | null>(
        null,
    );
    const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = React.useState(false);
    const [deleteState, setDeleteState] = React.useState<DeleteState>({
        type: "idle",
    });

    const copyToClipboard = async (text: string, commandType: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedCommand(commandType);
            setTimeout(() => setCopiedCommand(null), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    const closeDeleteDialog = () => {
        if (deleteState.type === "deleting") {
            return;
        }

        setIsConfirmDeleteOpen(false);
        setDeleteState({ type: "idle" });
    };

    const handleDelete = async () => {
        setDeleteState({ type: "deleting" });

        try {
            await props.agent.deleteFile(props.lsResult.path);
            await navigate({
                to: props.agent.getBrowserUrl(parentPath ?? "/"),
            });
        } catch (error) {
            setDeleteState({
                type: "error",
                message: getErrorMessage(error, "Delete failed"),
            });
        }
    };

    const wgetCommand = `wget "${props.downloadUrl}"`;
    const curlCommand = `curl -O "${props.downloadUrl}"`;

    return (
        <div>
            <div className="mb-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <Breadcrumbs
                        agentId={props.agentId}
                        agentName={props.agentName}
                        agent={props.agent}
                        path={props.path}
                    />
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId: props.agentId }}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Back to Agent
                    </Link>
                </div>
                <div
                    aria-label="File actions"
                    className="flex flex-wrap items-center rounded-lg border border-slate-700/80 bg-slate-900/70 p-1.5 shadow-sm"
                >
                    <Link
                        to={getBrowserPathHref(props.agent, parentPath ?? "/")}
                        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back
                    </Link>
                </div>
            </div>

            <article className="overflow-hidden rounded-2xl border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="relative overflow-hidden border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
                    <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/5 blur-3xl" />
                    <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-start">
                        <div className="flex min-w-0 items-start gap-4">
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 shadow-inner shadow-blue-400/10">
                                <File className="h-7 w-7 text-blue-400" />
                            </div>
                            <div className="min-w-0 pt-0.5">
                                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                                    File details
                                </p>
                                <h1
                                    aria-label="File name"
                                    className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                                >
                                    {props.fileName}
                                </h1>
                            </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            <a
                                href={props.downloadUrl}
                                download={props.fileName}
                                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 transition hover:bg-blue-500"
                            >
                                <Download className="h-4 w-4" />
                                Download File
                            </a>
                            <button
                                type="button"
                                aria-label="Delete file"
                                onClick={() => {
                                    setDeleteState({ type: "idle" });
                                    setIsConfirmDeleteOpen(true);
                                }}
                                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:border-red-500/50 hover:bg-red-500/20 hover:text-red-200"
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete
                            </button>
                        </div>
                    </div>

                    <div className="relative mt-6">
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                                Full Path
                            </p>
                            <button
                                type="button"
                                onClick={() =>
                                    copyToClipboard(props.lsResult.path, "path")
                                }
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-200"
                                aria-label="Copy full path"
                            >
                                {copiedCommand === "path" ? (
                                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                                ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                )}
                                {copiedCommand === "path" ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <code className="block overflow-x-auto whitespace-nowrap rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 font-mono text-sm text-slate-300">
                            {props.lsResult.path}
                        </code>
                    </div>
                </header>

                <FilesystemMetadataSections
                    metadata={props.lsResult}
                    size={props.lsResult.size}
                    headingPrefix="file"
                />

                <section
                    aria-labelledby="command-downloads-heading"
                    className="border-t border-slate-800 bg-slate-950/15 p-6 md:p-8"
                >
                    <div className="mb-4">
                        <h2
                            id="command-downloads-heading"
                            className="text-base font-semibold text-slate-100"
                        >
                            Command Line Downloads
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Download this file directly from a shell.
                        </p>
                    </div>
                    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                        <CommandDownloadRow
                            label="wget"
                            command={wgetCommand}
                            isCopied={copiedCommand === "wget"}
                            onCopy={() => copyToClipboard(wgetCommand, "wget")}
                        />
                        <CommandDownloadRow
                            label="curl"
                            command={curlCommand}
                            isCopied={copiedCommand === "curl"}
                            onCopy={() => copyToClipboard(curlCommand, "curl")}
                        />
                    </div>
                </section>
            </article>

            <ConfirmationDialog
                isOpen={isConfirmDeleteOpen}
                title="Delete this file?"
                description={
                    <>
                        This permanently deletes
                        <span className="mx-1 break-all font-medium text-slate-100">
                            {props.fileName}
                        </span>
                        from the agent filesystem.
                    </>
                }
                confirmLabel="Delete file"
                busyLabel="Deleting..."
                isBusy={deleteState.type === "deleting"}
                errorMessage={
                    deleteState.type === "error" ? deleteState.message : null
                }
                onClose={closeDeleteDialog}
                onConfirm={handleDelete}
            >
                <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                    {props.lsResult.path}
                </p>
            </ConfirmationDialog>
        </div>
    );
}

function FileBrowserError({ error }: { error: Error }) {
    const errorMessage = error.message.toLowerCase();

    if (
        errorMessage.includes("not found") ||
        errorMessage.includes("agent not found")
    ) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-12 w-12 text-red-400" />
                    <p className="text-slate-400">Agent not found</p>
                    <Link to="/" className="text-blue-400 hover:underline">
                        Back to agents
                    </Link>
                </div>
            </div>
        );
    }

    if (
        errorMessage.includes("no such file or directory") ||
        errorMessage.includes("directory not found")
    ) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-12 w-12 text-red-400" />
                    <p className="text-slate-400">Directory not found</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("not a directory")) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-12 w-12 text-red-400" />
                    <p className="text-slate-400">Not a directory</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("permission denied")) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-12 w-12 text-red-400" />
                    <p className="text-slate-400">Permission denied</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-center">
                <AlertCircle className="h-12 w-12 text-red-400" />
                <p className="text-slate-400">Error loading files</p>
                <p className="text-sm text-slate-500">{error.message}</p>
            </div>
        </div>
    );
}
