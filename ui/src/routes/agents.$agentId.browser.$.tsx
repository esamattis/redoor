import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    createFileRoute,
    Link,
    useNavigate,
    useRouter,
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
} from "lucide-react";
import { BrowserActionDialog } from "../components/browser-action-dialog";
import { formatSize } from "../utils/path";
import {
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsFileResponse,
} from "../api-client";
import {
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
} from "../selected-files";

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };

type CreateDirectoryState =
    | { type: "idle" }
    | { type: "creating" }
    | { type: "error"; message: string };

function getImmediateParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === "") {
        return null;
    }

    const isAbsolute = normalizedPath.startsWith("/");
    const parts = normalizedPath.split("/").filter((part) => part !== "");
    if (parts.length <= 1) {
        return null;
    }

    const parent = parts.slice(0, -1).join("/");
    return isAbsolute ? `/${parent}` : parent;
}

function getBrowserPathHref(agentId: string, relativePath: string | null) {
    return relativePath
        ? `/agents/${agentId}/browser/${relativePath}`
        : `/agents/${agentId}/browser`;
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

        const details = await agent.getDetails();
        const relativePath = params._splat || "";
        const lsPath = relativePath || details.cwd;
        const lsResult: LsResponse = await agent.ls(lsPath);
        const downloadUrl = isLsFileResponse(lsResult)
            ? agent.getRawUrl(lsResult.path, { cwd: details.cwd })
            : undefined;
        const fullPath = relativePath.startsWith("/")
            ? relativePath
            : relativePath
              ? `${details.cwd}/${relativePath}`
              : details.cwd;

        return {
            agent,
            agentId: agent.id,
            agentName: agent.name,
            cwd: details.cwd,
            relativePath,
            fullPath,
            lsResult,
            downloadUrl,
        };
    },
    component: FileBrowser,
    errorComponent: FileBrowserError,
});

function FileBrowser() {
    const data = Route.useLoaderData();
    const { agent, agentId, agentName, relativePath, lsResult } = data;
    const [showHiddenFiles, setShowHiddenFiles] = React.useState(true);

    const isAtCwd = relativePath === "";
    const parentPath = getImmediateParentPath(relativePath);

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

        return (
            <div className="p-6">
                <div className="max-w-4xl mx-auto">
                    <BrowserHeader
                        agent={agent}
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
                        isAtCwd={isAtCwd}
                        parentPath={parentPath}
                        directoryPath={data.fullPath}
                        showHiddenFiles={showHiddenFiles}
                        onToggleHiddenFiles={() =>
                            setShowHiddenFiles((prev) => !prev)
                        }
                    />

                    <FileList
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
                        files={sortedFiles}
                        isAtCwd={isAtCwd}
                    />
                </div>
            </div>
        );
    }

    if (isLsFileResponse(lsResult)) {
        const fileName = relativePath.split("/").pop() || lsResult.path;
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
                <div className="max-w-4xl mx-auto">
                    <FileDetailView
                        agent={agent}
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
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
                disabled={isUploading}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Upload className="h-4 w-4" />
                {isUploading ? "Uploading..." : "Upload files"}
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

function CreateDirectoryAction(props: { agent: Agent; directoryPath: string }) {
    const router = useRouter();
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
            await router.invalidate();
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
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
            >
                <FolderPlus className="h-4 w-4" />
                Create directory
            </button>

            <BrowserActionDialog
                isOpen={isDialogOpen}
                title="Create directory"
                description="Create a new directory in the current location."
                dialogTitleId="create-directory-title"
                dialogDescriptionId="create-directory-description"
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
            </BrowserActionDialog>
        </>
    );
}

function BrowserHeader(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    relativePath: string;
    isAtCwd: boolean;
    parentPath: string | null;
    directoryPath: string;
    showHiddenFiles: boolean;
    onToggleHiddenFiles: () => void;
}) {
    return (
        <div className="mb-6">
            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <Breadcrumbs
                    agentId={props.agentId}
                    agentName={props.agentName}
                    relativePath={props.relativePath}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={props.onToggleHiddenFiles}
                        aria-pressed={props.showHiddenFiles}
                        aria-label={
                            props.showHiddenFiles
                                ? "Hide hidden files"
                                : "Show hidden files"
                        }
                        className="inline-flex items-center gap-2 rounded border border-slate-700 bg-slate-800/60 px-4 py-2 text-slate-200 hover:bg-slate-700/60"
                    >
                        {props.showHiddenFiles ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                        {props.showHiddenFiles ? "Hide hidden" : "Show hidden"}
                    </button>
                    <CreateDirectoryAction
                        agent={props.agent}
                        directoryPath={props.directoryPath}
                    />
                    <UploadFilesAction
                        agent={props.agent}
                        directoryPath={props.directoryPath}
                    />
                    <Link
                        to={getBrowserPathHref(props.agentId, props.parentPath)}
                        className="flex items-center gap-2 rounded border border-slate-700 bg-slate-800/60 px-4 py-2 text-slate-200 hover:bg-slate-700/60 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={props.isAtCwd}
                    >
                        <ArrowUp className="h-4 w-4" />
                        Up
                    </Link>
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId: props.agentId }}
                        className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                    >
                        Back to Agent
                    </Link>
                </div>
            </div>
        </div>
    );
}

function Breadcrumbs(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
}) {
    const { agentId, agentName, relativePath } = props;

    const parts = relativePath.split("/").filter((part) => part !== "");
    const isAbsolute = relativePath.startsWith("/");
    const isAtRoot = parts.length === 0;
    let accumulatedPath = "";

    return (
        <nav
            aria-label="Breadcrumbs"
            className="flex items-center gap-2 text-sm"
        >
            {isAtRoot ? (
                <span className="font-medium text-slate-100">{agentName}</span>
            ) : (
                <Link
                    to="/agents/$agentId/browser/$"
                    params={{ agentId, _splat: undefined }}
                    className="text-blue-400 hover:underline"
                >
                    {agentName}
                </Link>
            )}
            {parts.map((part, index) => {
                if (accumulatedPath === "") {
                    accumulatedPath = isAbsolute ? `/${part}` : part;
                } else {
                    accumulatedPath = `${accumulatedPath}/${part}`;
                }
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
                                to="/agents/$agentId/browser/$"
                                params={{ agentId, _splat: accumulatedPath }}
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
    relativePath: string;
    files: Array<{
        name: string;
        type: string;
        size: number;
        owner: string | null;
        group: string | null;
        uid: number;
        gid: number;
    }>;
    isAtCwd: boolean;
}) {
    const { agentId, agentName, relativePath, files } = props;

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
                        relativePath={relativePath}
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
    relativePath: string;
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
    const { agentId, agentName, relativePath, entry, isParent } = props;
    const isDirectory = entry.type === "directory" || isParent;
    const splatValue = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
    const fullPath = splatValue.startsWith("/")
        ? splatValue
        : Route.useLoaderData().cwd
          ? joinBrowserPath(Route.useLoaderData().cwd, splatValue)
          : splatValue;
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
                            relativePath: splatValue,
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
                    to="/agents/$agentId/browser/$"
                    params={{ agentId, _splat: splatValue }}
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

function FileDetailView(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    relativePath: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.relativePath);

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
                to: "/agents/$agentId/browser/$",
                params: {
                    agentId: props.agentId,
                    _splat: parentPath ?? undefined,
                },
            });
        } catch (error) {
            setDeleteState({
                type: "error",
                message: getErrorMessage(error, "Delete failed"),
            });
        }
    };

    return (
        <div>
            <div className="mb-6">
                <div className="mb-4 flex items-center justify-between">
                    <Breadcrumbs
                        agentId={props.agentId}
                        agentName={props.agentName}
                        relativePath={props.relativePath}
                    />
                    <div className="flex gap-2">
                        <Link
                            to={getBrowserPathHref(props.agentId, parentPath)}
                            className="flex items-center gap-2 rounded border border-slate-700 bg-slate-800/60 px-4 py-2 text-slate-200 hover:bg-slate-700/60"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back
                        </Link>
                        <Link
                            to="/agents/$agentId"
                            params={{ agentId: props.agentId }}
                            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                        >
                            Back to Agent
                        </Link>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#11141b] p-6">
                <div className="mb-6 flex items-center gap-4">
                    <div className="rounded-lg bg-blue-500/15 p-3">
                        <File className="h-8 w-8 text-blue-400" />
                    </div>
                    <h1
                        aria-label="File name"
                        className="text-2xl font-bold text-slate-100"
                    >
                        {props.fileName}
                    </h1>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <p className="mb-1 text-sm text-slate-400">Size</p>
                            <p
                                aria-label="File size value"
                                className="font-medium text-slate-100"
                            >
                                {formatSize(props.lsResult.size)}
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 text-sm text-slate-400">Owner</p>
                            <p className="font-medium text-slate-100">
                                {props.lsResult.owner || "-"}
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 text-sm text-slate-400">Group</p>
                            <p className="font-medium text-slate-100">
                                {props.lsResult.group || "-"}
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="mb-1 text-sm text-slate-400">UID</p>
                            <p className="font-medium text-slate-100">
                                {props.lsResult.uid}
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 text-sm text-slate-400">GID</p>
                            <p className="font-medium text-slate-100">
                                {props.lsResult.gid}
                            </p>
                        </div>
                    </div>

                    <div>
                        <p className="mb-1 text-sm text-slate-400">Full Path</p>
                        <p className="rounded bg-[#0b0d12] p-2 font-mono text-sm text-slate-300">
                            {props.lsResult.path}
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <div>
                            <p className="mb-1 text-sm text-slate-400">
                                Download
                            </p>
                            <a
                                href={props.downloadUrl}
                                download={props.fileName}
                                className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                            >
                                <Download className="h-4 w-4" />
                                Download File
                            </a>
                        </div>
                        <div>
                            <p className="mb-1 text-sm text-slate-400">
                                Delete
                            </p>
                            <button
                                type="button"
                                aria-label="Delete file"
                                onClick={() => {
                                    setDeleteState({ type: "idle" });
                                    setIsConfirmDeleteOpen(true);
                                }}
                                className="inline-flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-white hover:bg-red-500"
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete File
                            </button>
                        </div>
                    </div>

                    <div>
                        <p className="mb-2 text-sm text-slate-400">
                            Command Line Downloads
                        </p>

                        {/* wget row */}
                        <div className="mb-2 flex items-center gap-2">
                            <code className="flex-1 rounded bg-[#0b0d12] p-2 font-mono text-sm text-slate-300">
                                wget "{props.downloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `wget "${props.downloadUrl}"`,
                                        "wget",
                                    )
                                }
                                className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                aria-label="Copy wget command"
                            >
                                {copiedCommand === "wget" ? (
                                    <Check className="h-4 w-4 text-emerald-400" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </button>
                        </div>

                        {/* curl row */}
                        <div className="flex items-center gap-2">
                            <code className="flex-1 rounded bg-[#0b0d12] p-2 font-mono text-sm text-slate-300">
                                curl -O "{props.downloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `curl -O "${props.downloadUrl}"`,
                                        "curl",
                                    )
                                }
                                className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                aria-label="Copy curl command"
                            >
                                {copiedCommand === "curl" ? (
                                    <Check className="h-4 w-4 text-emerald-400" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <DeleteConfirmationDialog
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
                pathDisplay={props.lsResult.path}
                confirmLabel="Delete file"
                deleteState={deleteState}
                dialogTitleId="delete-file-title"
                dialogDescriptionId="delete-file-description"
                onClose={closeDeleteDialog}
                onConfirm={handleDelete}
            />
        </div>
    );
}

function DeleteConfirmationDialog(props: {
    isOpen: boolean;
    title: string;
    description: React.ReactNode;
    pathDisplay: string;
    confirmLabel: string;
    deleteState: DeleteState;
    dialogTitleId: string;
    dialogDescriptionId: string;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <BrowserActionDialog
            isOpen={props.isOpen}
            title={props.title}
            description={props.description}
            dialogTitleId={props.dialogTitleId}
            dialogDescriptionId={props.dialogDescriptionId}
            closeAriaLabel="Close delete confirmation"
            isBusy={props.deleteState.type === "deleting"}
            errorMessage={
                props.deleteState.type === "error"
                    ? props.deleteState.message
                    : null
            }
            onClose={props.onClose}
        >
            <div className="mt-4">
                <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                    {props.pathDisplay}
                </p>

                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={props.onClose}
                        disabled={props.deleteState.type === "deleting"}
                        className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={props.onConfirm}
                        disabled={props.deleteState.type === "deleting"}
                        className="inline-flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Trash2 className="h-4 w-4" />
                        {props.deleteState.type === "deleting"
                            ? "Deleting..."
                            : props.confirmLabel}
                    </button>
                </div>
            </div>
        </BrowserActionDialog>
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
