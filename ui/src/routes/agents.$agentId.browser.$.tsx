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
    File,
    ArrowUp,
    AlertCircle,
    Download,
    ArrowLeft,
    Copy,
    Check,
    Upload,
    Trash2,
    X,
    Square,
    CheckSquare,
} from "lucide-react";
import { getParentPath, formatSize } from "../utils/path";
import {
    type Agent,
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsFileResponse,
} from "../api-client";
import {
    selectedFilesAtom,
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
    unselectFileAtom,
} from "../selected-files";

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };
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
        const fullPath = relativePath
            ? `${details.cwd}/${relativePath}`
            : details.cwd;
        const lsResult: LsResponse = await agent.ls(fullPath);
        const downloadUrl = isLsFileResponse(lsResult)
            ? agent.getRawUrl(lsResult.path, { cwd: details.cwd })
            : undefined;

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

    const isAtCwd = relativePath === "";
    const parentPath = getParentPath(relativePath);

    if (isLsDirectoryResponse(lsResult)) {
        const directories = lsResult.files.filter(
            (f) => f.type === "directory",
        );
        const regularFiles = lsResult.files.filter((f) => f.type === "file");

        directories.sort((a, b) => a.name.localeCompare(b.name));
        regularFiles.sort((a, b) => a.name.localeCompare(b.name));

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

function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return "Upload failed";
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
                message: getErrorMessage(error),
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
                className="inline-flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <Upload className="h-4 w-4" />
                {isUploading ? "Uploading..." : "Upload files"}
            </button>
            {statusMessage ? (
                <span
                    role={uploadState.type === "error" ? "alert" : "status"}
                    aria-live="polite"
                    className={`text-sm ${uploadState.type === "error" ? "text-red-600" : "text-emerald-700"}`}
                >
                    {statusMessage}
                </span>
            ) : null}
        </div>
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
                    <UploadFilesAction
                        agent={props.agent}
                        directoryPath={props.directoryPath}
                    />
                    <Link
                        to="/agents/$agentId/browser/$"
                        params={{
                            agentId: props.agentId,
                            _splat: props.parentPath ?? undefined,
                        }}
                        className="flex items-center gap-2 rounded bg-gray-100 px-4 py-2 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={props.isAtCwd}
                    >
                        <ArrowUp className="h-4 w-4" />
                        Up
                    </Link>
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId: props.agentId }}
                        className="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
                    >
                        Back to Agent
                    </Link>
                </div>
            </div>
        </div>
    );
}

type CopySelectedFilesState =
    | { type: "idle" }
    | { type: "copying"; itemCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

function Breadcrumbs(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
}) {
    const { agentId, agentName, relativePath } = props;

    const parts = relativePath.split("/").filter((part) => part !== "");
    const paths: string[] = [];
    let accumulatedPath = "";

    return (
        <div className="flex items-center gap-2 text-sm">
            <Link
                to="/agents/$agentId"
                params={{ agentId }}
                className="text-blue-600 hover:underline"
            >
                {agentName}
            </Link>
            {parts.map((part, index) => {
                accumulatedPath = accumulatedPath
                    ? `${accumulatedPath}/${part}`
                    : part;
                paths.push(accumulatedPath);
                const isLast = index === parts.length - 1;

                return (
                    <div key={index} className="flex items-center gap-2">
                        <span className="text-gray-400">/</span>
                        {isLast ? (
                            <span className="text-gray-900 font-medium">
                                {part}
                            </span>
                        ) : (
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId, _splat: accumulatedPath }}
                                className="text-blue-600 hover:underline font-medium"
                            >
                                {part}
                            </Link>
                        )}
                    </div>
                );
            })}
        </div>
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
        <table className="w-full bg-white border rounded-lg">
            <thead>
                <tr className="border-b bg-gray-50">
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Select
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Type
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Name
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Size
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Owner
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
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
    const fullPath = Route.useLoaderData().cwd
        ? joinBrowserPath(Route.useLoaderData().cwd, splatValue)
        : splatValue;
    const isSelected = selectedFileKeys.has(`${agentId}:${fullPath}`);

    return (
        <tr
            className="border-b hover:bg-gray-50"
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
                    className="rounded p-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                >
                    {isSelected ? (
                        <CheckSquare className="h-4 w-4 text-blue-600" />
                    ) : (
                        <Square className="h-4 w-4" />
                    )}
                </button>
            </td>
            <td className="p-3">
                {isDirectory ? (
                    <Folder className="h-5 w-5 text-blue-500" />
                ) : (
                    <File className="h-5 w-5 text-gray-400" />
                )}
            </td>
            <td className="p-3">
                <Link
                    to="/agents/$agentId/browser/$"
                    params={{ agentId, _splat: splatValue }}
                    className={`${isDirectory ? "flex items-center gap-3 " : ""}text-blue-600 font-medium hover:underline`}
                >
                    {entry.name}
                </Link>
            </td>
            <td
                className={
                    isDirectory ? "p-3 text-gray-400" : "p-3 text-gray-500"
                }
                aria-label={`Size for ${entry.name}`}
            >
                {isDirectory ? "-" : formatSize(entry.size)}
            </td>
            <td className="p-3 text-gray-500">{entry.owner || "-"}</td>
            <td className="p-3 text-gray-500">{entry.group || "-"}</td>
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
    const parentPath = getParentPath(props.relativePath);

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
                message: getErrorMessage(error).replace(
                    /^Upload failed$/,
                    "Delete failed",
                ),
            });
        }
    };

    return (
        <div>
            <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                    <Breadcrumbs
                        agentId={props.agentId}
                        agentName={props.agentName}
                        relativePath={props.relativePath}
                    />
                    <div className="flex gap-2">
                        <Link
                            to="/agents/$agentId/browser/$"
                            params={{
                                agentId: props.agentId,
                                _splat: parentPath ?? undefined,
                            }}
                            className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded hover:bg-gray-200"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back
                        </Link>
                        <Link
                            to="/agents/$agentId"
                            params={{ agentId: props.agentId }}
                            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                        >
                            Back to Agent
                        </Link>
                    </div>
                </div>
            </div>

            <div className="bg-white border rounded-lg p-6">
                <div className="flex items-center gap-4 mb-6">
                    <div className="p-3 bg-blue-100 rounded-lg">
                        <File className="h-8 w-8 text-blue-600" />
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900">
                        {props.fileName}
                    </h1>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Size</p>
                            <p className="text-gray-900 font-medium">
                                {formatSize(props.lsResult.size)}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Owner</p>
                            <p className="text-gray-900 font-medium">
                                {props.lsResult.owner || "-"}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Group</p>
                            <p className="text-gray-900 font-medium">
                                {props.lsResult.group || "-"}
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-sm text-gray-500 mb-1">UID</p>
                            <p className="text-gray-900 font-medium">
                                {props.lsResult.uid}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">GID</p>
                            <p className="text-gray-900 font-medium">
                                {props.lsResult.gid}
                            </p>
                        </div>
                    </div>

                    <div>
                        <p className="text-sm text-gray-500 mb-1">Full Path</p>
                        <p className="text-gray-900 font-mono text-sm bg-gray-50 p-2 rounded">
                            {props.lsResult.path}
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <div>
                            <p className="text-sm text-gray-500 mb-1">
                                Download
                            </p>
                            <a
                                href={props.downloadUrl}
                                download={props.fileName}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                            >
                                <Download className="h-4 w-4" />
                                Download File
                            </a>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Delete</p>
                            <button
                                type="button"
                                aria-label="Delete file"
                                onClick={() => {
                                    setDeleteState({ type: "idle" });
                                    setIsConfirmDeleteOpen(true);
                                }}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete File
                            </button>
                        </div>
                    </div>

                    <div>
                        <p className="text-sm text-gray-500 mb-2">
                            Command Line Downloads
                        </p>

                        {/* wget row */}
                        <div className="flex items-center gap-2 mb-2">
                            <code className="flex-1 text-sm font-mono bg-gray-50 p-2 rounded">
                                wget "{props.downloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `wget "${props.downloadUrl}"`,
                                        "wget",
                                    )
                                }
                                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                                aria-label="Copy wget command"
                            >
                                {copiedCommand === "wget" ? (
                                    <Check className="h-4 w-4 text-green-600" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </button>
                        </div>

                        {/* curl row */}
                        <div className="flex items-center gap-2">
                            <code className="flex-1 text-sm font-mono bg-gray-50 p-2 rounded">
                                curl -O "{props.downloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `curl -O "${props.downloadUrl}"`,
                                        "curl",
                                    )
                                }
                                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                                aria-label="Copy curl command"
                            >
                                {copiedCommand === "curl" ? (
                                    <Check className="h-4 w-4 text-green-600" />
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
                        <span className="mx-1 break-all font-medium text-gray-900">
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
    if (!props.isOpen) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.dialogTitleId}
            aria-describedby={props.dialogDescriptionId}
        >
            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
                <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                        <h2
                            id={props.dialogTitleId}
                            className="text-lg font-semibold text-gray-900"
                        >
                            {props.title}
                        </h2>
                        <div
                            id={props.dialogDescriptionId}
                            className="mt-2 text-sm text-gray-600"
                        >
                            {props.description}
                        </div>
                    </div>
                    <button
                        type="button"
                        aria-label="Close delete confirmation"
                        onClick={props.onClose}
                        disabled={props.deleteState.type === "deleting"}
                        className="rounded p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <p className="break-all rounded bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700">
                    {props.pathDisplay}
                </p>

                {props.deleteState.type === "error" ? (
                    <p
                        role="alert"
                        className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                    >
                        {props.deleteState.message}
                    </p>
                ) : null}

                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={props.onClose}
                        disabled={props.deleteState.type === "deleting"}
                        className="rounded border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={props.onConfirm}
                        disabled={props.deleteState.type === "deleting"}
                        className="inline-flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Trash2 className="h-4 w-4" />
                        {props.deleteState.type === "deleting"
                            ? "Deleting..."
                            : props.confirmLabel}
                    </button>
                </div>
            </div>
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
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Agent not found</p>
                    <Link to="/" className="text-blue-600 hover:underline">
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
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Directory not found</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("not a directory")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Not a directory</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("permission denied")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Permission denied</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center flex flex-col items-center gap-2">
                <AlertCircle className="h-12 w-12 text-red-500" />
                <p className="text-gray-500">Error loading files</p>
                <p className="text-sm text-gray-400">{error.message}</p>
            </div>
        </div>
    );
}
