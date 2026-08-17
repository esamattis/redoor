import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    useMutation,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
    ClipboardPaste,
    Copy,
    Eye,
    EyeOff,
    FilePlus,
    FolderPlus,
    Files,
    FolderInput,
    Plus,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Dialog } from "#ui/components/dialog";
import { requestClipboardPaste } from "#ui/components/global-file-import-handler";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import type { Agent, ApiClient, CopyExistingMode } from "#ui/api-client";
import {
    selectedFilesAtom,
    clearSelectedFilesAtom,
    unselectFileAtom,
    type SelectedPath,
} from "#ui/selected-files";
import { getErrorMessage, joinBrowserPath } from "#ui/components/browser/utils";
import { enqueueUploadBatchAtom } from "#ui/upload-queue";
import { transfersQueryOptions } from "#ui/queries";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import {
    SelectedFilesTransferTrigger,
    type SelectedFilesTransferOperation,
} from "#ui/components/browser/selected-files-transfer-dialog";
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";

type TransferSelectedFilesState =
    | { type: "idle" }
    | { type: "transferring"; itemCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/**
 * Copy and Move share polling and selection cleanup so only the start API
 * and user-facing verbs differ.
 */
const transferActionCopy = {
    failed: "Copy failed",
    dismissAriaLabel: "Dismiss copy status",
    Icon: Copy,
};

const transferActionMove = {
    failed: "Move failed",
    dismissAriaLabel: "Dismiss move status",
    Icon: FolderInput,
};

/**
 * Polls public transfer rows so only finished items are unselected. Returns
 * false when the run was aborted and the caller must not update UI state.
 */
async function waitForPendingTransfers(props: {
    api: ApiClient;
    queryClient: QueryClient;
    pendingTransfers: Map<number, SelectedPath>;
    completedFiles: SelectedPath[];
    failures: unknown[];
    failedLabel: string;
    signal: AbortSignal;
}): Promise<boolean> {
    try {
        while (props.pendingTransfers.size > 0 && !props.signal.aborted) {
            const progress = await props.queryClient.fetchQuery({
                ...transfersQueryOptions(props.api),
                retry: false,
                staleTime: 0,
            });
            if (props.signal.aborted) {
                return false;
            }

            for (const transfer of progress.transfers) {
                const file = props.pendingTransfers.get(transfer.request_id);
                if (!file) continue;
                if (transfer.state === "completed") {
                    props.completedFiles.push(file);
                    props.pendingTransfers.delete(transfer.request_id);
                } else if (transfer.state === "errored") {
                    props.failures.push(transfer.error ?? props.failedLabel);
                    props.pendingTransfers.delete(transfer.request_id);
                }
            }

            if (props.pendingTransfers.size > 0) {
                await new Promise((resolve) => window.setTimeout(resolve, 500));
            }
        }
    } catch (error) {
        props.failures.push(error);
    }

    return !props.signal.aborted;
}

/**
 * Starts every selected item into this directory so the destination is clear
 * at the point where Copy or Move is performed. Sibling in-flight state is
 * owned by the card so the other action cannot race the same sources.
 */
function TransferSelectedFilesAction(props: {
    operation: SelectedFilesTransferOperation;
    api: ApiClient;
    agents: Agent[];
    destinationAgent: Agent;
    directoryPath: string;
    destinationFileNames: string[];
    isSiblingTransferring: boolean;
    onTransferringChange: (isTransferring: boolean) => void;
}) {
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const isRoutePending = useRouterState({
        select: (state) => state.status === "pending",
    });
    const [transferState, setTransferState] =
        React.useState<TransferSelectedFilesState>({
            type: "idle",
        });
    const activeTransferRef = React.useRef<AbortController | null>(null);
    const queryClient = useQueryClient();
    const isCopy = props.operation === "copy";
    const labels = isCopy ? transferActionCopy : transferActionMove;
    const transferStartsMutation = useMutation({
        mutationFn: (request: {
            filesToTransfer: SelectedPath[];
            existingMode: CopyExistingMode;
        }) => {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );
            return Promise.allSettled(
                request.filesToTransfer.map(async (file) => {
                    const sourceAgent = agentsById.get(file.agentId);

                    if (!sourceAgent) {
                        throw new Error(
                            `Source agent unavailable for selected item: ${file.agentId}`,
                        );
                    }

                    const destination = {
                        agent: props.destinationAgent.id,
                        path: joinBrowserPath(
                            props.directoryPath,
                            file.fileName,
                        ),
                    };
                    const options = { on_existing: request.existingMode };

                    if (isCopy) {
                        const response = await sourceAgent.copyTo(
                            destination,
                            file.path,
                            options,
                        );
                        return response.copy_request_id;
                    }

                    const response = await sourceAgent.moveTo(
                        destination,
                        file.path,
                        options,
                    );
                    return response.move_request_id;
                }),
            );
        },
    });

    React.useEffect(() => {
        return () => activeTransferRef.current?.abort();
    }, []);

    const statusMessage =
        transferState.type === "transferring"
            ? `${isCopy ? "Copying" : "Moving"} ${transferState.itemCount} ${transferState.itemCount === 1 ? "item" : "items"}...`
            : transferState.type === "idle"
              ? null
              : transferState.message;
    const isTransferring = transferState.type === "transferring";
    const isCurrentDirectorySelected = selectedFiles.every(
        (file) =>
            file.agentId === props.destinationAgent.id &&
            file.path === joinBrowserPath(props.directoryPath, file.fileName),
    );
    const canTransfer =
        selectedFiles.length > 0 &&
        !isCurrentDirectorySelected &&
        !isTransferring &&
        !props.isSiblingTransferring &&
        !isRoutePending;

    /** Starts every selected transfer with one consistent destination conflict policy. */
    const transferSelectedFiles = async (mode: CopyExistingMode) => {
        if (selectedFiles.length === 0) {
            return;
        }

        const filesToTransfer = [...selectedFiles];
        const controller = new AbortController();
        activeTransferRef.current?.abort();
        activeTransferRef.current = controller;

        setTransferState({
            type: "transferring",
            itemCount: filesToTransfer.length,
        });
        props.onTransferringChange(true);

        try {
            const results = await transferStartsMutation.mutateAsync({
                filesToTransfer,
                existingMode: mode,
            });
            if (controller.signal.aborted) return;

            const completedFiles: SelectedPath[] = [];
            const failures: unknown[] = [];
            const pendingTransfers = new Map(
                results.flatMap((result, index) => {
                    const file = filesToTransfer[index];
                    if (result.status === "rejected") {
                        failures.push(result.reason);
                        return [];
                    }
                    return file ? [[result.value, file] as const] : [];
                }),
            );

            const stillActive = await waitForPendingTransfers({
                api: props.api,
                queryClient,
                pendingTransfers,
                completedFiles,
                failures,
                failedLabel: labels.failed,
                signal: controller.signal,
            });
            if (!stillActive) return;
            activeTransferRef.current = null;

            completedFiles.forEach((file) => {
                unselectFile({
                    agentId: file.agentId,
                    path: file.path,
                });
            });

            if (failures.length > 0) {
                const failureMessage = getErrorMessage(
                    failures[0],
                    labels.failed,
                ).replace(/^Upload failed$/, labels.failed);

                setTransferState({
                    type: "error",
                    message:
                        completedFiles.length > 0
                            ? `${isCopy ? "Copied" : "Moved"} ${completedFiles.length} of ${filesToTransfer.length} items. ${failureMessage}`
                            : failureMessage,
                });
                return;
            }

            setTransferState({
                type: "success",
                message:
                    filesToTransfer.length === 1
                        ? `${isCopy ? "Copied" : "Moved"} ${filesToTransfer[0]?.fileName ?? "item"}`
                        : `${isCopy ? "Copied" : "Moved"} ${filesToTransfer.length} items`,
            });
        } finally {
            // Sibling Copy/Move must become usable again even if this run aborted.
            props.onTransferringChange(false);
        }
    };

    return (
        <>
            <SelectedFilesTransferTrigger
                operation={props.operation}
                selectedFiles={selectedFiles}
                destinationAgent={props.destinationAgent}
                directoryPath={props.directoryPath}
                destinationFileNames={props.destinationFileNames}
                canTransfer={canTransfer}
                onConfirm={(mode) => void transferSelectedFiles(mode)}
            />
            {statusMessage ? (
                <Toast
                    tone={
                        transferState.type === "transferring"
                            ? "info"
                            : transferState.type === "error"
                              ? "error"
                              : "success"
                    }
                    icon={<labels.Icon className="h-4 w-4" />}
                    dismissAriaLabel={labels.dismissAriaLabel}
                    onDismiss={() => setTransferState({ type: "idle" })}
                >
                    {statusMessage}
                </Toast>
            ) : null}
        </>
    );
}

/** Keeps selected-item context and bulk actions adjacent to the file list. */
export function SelectedFilesCard(props: {
    api: ApiClient;
    agents: Agent[];
    destinationAgent: Agent;
    directoryPath: string;
    destinationFileNames: string[];
}) {
    const router = useRouter();
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const clearSelectedFiles = useSetAtom(clearSelectedFilesAtom);
    const activateBottomDrawerTab = useSetAtom(activateBottomDrawerTabAtom);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
    // One lock so Copy cannot start while Move is still reading or deleting sources.
    const [busyTransferOperation, setBusyTransferOperation] =
        React.useState<SelectedFilesTransferOperation | null>(null);
    const fileCount = selectedFiles.filter(
        (file) => file.entryType === "file",
    ).length;
    const directoryCount = selectedFiles.length - fileCount;
    const deleteMutation = useMutation({
        mutationFn: async (files: SelectedPath[]) => {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );
            const results = await Promise.allSettled(
                files.map((file) => {
                    const agent = agentsById.get(file.agentId);
                    if (!agent) {
                        return Promise.reject(
                            new Error(
                                `Agent unavailable for selected item: ${file.agentId}`,
                            ),
                        );
                    }
                    return agent.deleteFile(file.path);
                }),
            );
            const successfulDeletes = files.filter(
                (_file, index) => results[index]?.status === "fulfilled",
            );
            const failedDeletes = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successfulDeletes.length > 0) {
                successfulDeletes.forEach((file) => {
                    unselectFile({ agentId: file.agentId, path: file.path });
                });
                await router.invalidate();
            }

            if (failedDeletes.length > 0) {
                const firstFailure = failedDeletes[0];
                const failureMessage = getErrorMessage(
                    firstFailure ? firstFailure.reason : undefined,
                    "Delete failed",
                );
                throw new Error(
                    successfulDeletes.length > 0
                        ? `Deleted ${successfulDeletes.length} of ${files.length} items. ${failureMessage}`
                        : failureMessage,
                );
            }
        },
        onSuccess: () => setIsDeleteDialogOpen(false),
    });

    /** Prevents the confirmation from closing while deletion is in progress. */
    const closeDeleteDialog = () => {
        if (deleteMutation.isPending) {
            return;
        }
        setIsDeleteDialogOpen(false);
        deleteMutation.reset();
    };

    return (
        <>
            <section
                aria-label="Selected files actions"
                className="mb-3 flex flex-col gap-3 rounded-lg border border-blue-500/25 bg-blue-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
                <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-300">
                        <Files className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <p className="text-sm font-medium text-slate-200">
                            {fileCount} {fileCount === 1 ? "file" : "files"},{" "}
                            {directoryCount}{" "}
                            {directoryCount === 1 ? "directory" : "directories"}{" "}
                            selected
                        </p>
                        {selectedFiles.length > 0 ? (
                            <button
                                type="button"
                                onClick={() =>
                                    activateBottomDrawerTab("selected")
                                }
                                className="inline-flex h-7 items-center rounded-md border border-slate-700 px-2 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100"
                            >
                                Show
                            </button>
                        ) : null}
                        {selectedFiles.length > 0 ? (
                            <Tooltip content="Clear selection">
                                <button
                                    type="button"
                                    aria-label="Clear selection"
                                    onClick={clearSelectedFiles}
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                                >
                                    <X
                                        className="h-3.5 w-3.5"
                                        aria-hidden="true"
                                    />
                                </button>
                            </Tooltip>
                        ) : (
                            <span aria-hidden="true" className="h-7 w-7" />
                        )}
                    </div>
                </div>
                <div className="flex min-h-10 flex-wrap items-center gap-2">
                    <TransferSelectedFilesAction
                        operation="copy"
                        api={props.api}
                        agents={props.agents}
                        destinationAgent={props.destinationAgent}
                        directoryPath={props.directoryPath}
                        destinationFileNames={props.destinationFileNames}
                        isSiblingTransferring={busyTransferOperation === "move"}
                        onTransferringChange={(isTransferring) =>
                            setBusyTransferOperation(
                                isTransferring ? "copy" : null,
                            )
                        }
                    />
                    <TransferSelectedFilesAction
                        operation="move"
                        api={props.api}
                        agents={props.agents}
                        destinationAgent={props.destinationAgent}
                        directoryPath={props.directoryPath}
                        destinationFileNames={props.destinationFileNames}
                        isSiblingTransferring={busyTransferOperation === "copy"}
                        onTransferringChange={(isTransferring) =>
                            setBusyTransferOperation(
                                isTransferring ? "move" : null,
                            )
                        }
                    />
                    {selectedFiles.length > 0 && !deleteMutation.isPending ? (
                        <Tooltip content="Delete selected items">
                            <button
                                type="button"
                                aria-label="Delete selected items"
                                onClick={() => {
                                    deleteMutation.reset();
                                    setIsDeleteDialogOpen(true);
                                }}
                                className="inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-sm font-semibold text-red-200 transition-colors hover:border-red-500/60 hover:bg-red-500/20"
                            >
                                <Trash2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                                Delete
                            </button>
                        </Tooltip>
                    ) : null}
                </div>
            </section>
            <ConfirmationDialog
                isOpen={isDeleteDialogOpen}
                title={`Delete ${selectedFiles.length === 1 ? "this selected item" : "these selected items"}?`}
                description={`This permanently deletes ${fileCount} ${fileCount === 1 ? "file" : "files"} and ${directoryCount} ${directoryCount === 1 ? "directory" : "directories"} from the agent filesystem.`}
                confirmLabel={
                    selectedFiles.length === 1
                        ? "Delete selected item"
                        : `Delete ${selectedFiles.length} selected items`
                }
                busyLabel="Deleting..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? getErrorMessage(deleteMutation.error, "Delete failed")
                        : null
                }
                onClose={closeDeleteDialog}
                onConfirm={() => deleteMutation.mutate([...selectedFiles])}
            />
        </>
    );
}

/** Sends file and directory selections through the same bounded global queue. */
function UploadFilesAction(props: { agent: Agent; directoryPath: string }) {
    const enqueue = useSetAtom(enqueueUploadBatchAtom);
    const fileInputId = React.useId();
    const directoryInputId = React.useId();
    const fileInputRef = React.useRef<HTMLInputElement | null>(null);
    const directoryInputRef = React.useRef<HTMLInputElement | null>(null);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    const handleFileSelection = (
        event: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const selectedFiles = Array.from(event.target.files ?? []);
        if (selectedFiles.length === 0) {
            return;
        }
        const result = enqueue({
            agentId: props.agent.id,
            destinationPath: props.directoryPath,
            files: selectedFiles.map((file) => ({
                file,
                relativePath: file.webkitRelativePath || file.name,
            })),
        });
        event.target.value = "";
        if (!result.ok) {
            setErrorMessage(result.message);
            return;
        }
        setErrorMessage(null);
    };

    return (
        <div className="flex items-center gap-1">
            <label htmlFor={fileInputId} className="sr-only">
                Choose files to upload
            </label>
            <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelection}
            />
            <label htmlFor={directoryInputId} className="sr-only">
                Choose directory to upload
            </label>
            <input
                ref={(element) => {
                    directoryInputRef.current = element;
                    element?.setAttribute("webkitdirectory", "");
                }}
                id={directoryInputId}
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelection}
            />
            <ActionMenu label="Upload" icon={<Upload className="h-4 w-4" />}>
                {(close) => (
                    <>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                fileInputRef.current?.click();
                            }}
                        >
                            <Upload className="h-4 w-4 text-slate-400" />
                            Upload files
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                directoryInputRef.current?.click();
                            }}
                        >
                            <FolderPlus className="h-4 w-4 text-slate-400" />
                            Upload directory
                        </ActionMenuButton>
                        <p className="border-t border-slate-800 px-3 pt-3 text-xs leading-relaxed text-slate-400">
                            You can also upload files by dragging and dropping
                            them into this directory.
                        </p>
                    </>
                )}
            </ActionMenu>
            {errorMessage ? (
                <Toast
                    tone="error"
                    icon={<Upload className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss upload error"
                    onDismiss={() => setErrorMessage(null)}
                >
                    {errorMessage}
                </Toast>
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
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const createDirectoryMutation = useMutation({
        mutationFn: (path: string) => props.agent.createDirectory(path),
        onSuccess: async (_, path) => {
            await navigate({
                to: props.agent.getBrowserUrl(path),
            });
            resetDialog();
        },
    });

    const trimmedDirectoryName = directoryName.trim();
    const createDirectoryPath = trimmedDirectoryName
        ? joinBrowserPath(props.directoryPath, trimmedDirectoryName)
        : null;
    const isCreating = createDirectoryMutation.isPending;

    const resetDialog = () => {
        props.onClose();
        setDirectoryName("");
        setValidationError(null);
        createDirectoryMutation.reset();
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
            setValidationError("Directory name is required");
            return;
        }

        setValidationError(null);
        createDirectoryMutation.mutate(createDirectoryPath);
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            title="Create directory"
            description="Create a new directory in the current location."
            closeAriaLabel="Close create directory dialog"
            isBusy={isCreating}
            errorMessage={
                validationError ??
                (createDirectoryMutation.isError
                    ? getErrorMessage(
                          createDirectoryMutation.error,
                          "Create directory failed",
                      )
                    : null)
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
                        setValidationError(null);
                        createDirectoryMutation.reset();
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
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const createFileMutation = useMutation({
        mutationFn: (file: { path: string; name: string }) =>
            props.agent.upload(
                file.path,
                new globalThis.File([""], file.name, {
                    type: "text/plain",
                }),
            ),
        onSuccess: async (_, file) => {
            await navigate({
                to: props.agent.getBrowserUrl(file.path),
            });
            resetDialog();
        },
    });

    const trimmedFileName = fileName.trim();
    const createFilePath = trimmedFileName
        ? joinBrowserPath(props.directoryPath, trimmedFileName)
        : null;
    const isCreating = createFileMutation.isPending;

    const resetDialog = () => {
        props.onClose();
        setFileName("");
        setValidationError(null);
        createFileMutation.reset();
    };

    const closeDialog = () => {
        if (!isCreating) {
            resetDialog();
        }
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!createFilePath) {
            setValidationError("File name is required");
            return;
        }
        if (trimmedFileName.includes("/")) {
            setValidationError("File name cannot contain a slash");
            return;
        }

        setValidationError(null);
        createFileMutation.mutate({
            path: createFilePath,
            name: trimmedFileName,
        });
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            title="Create file"
            description="Create an empty text file and open it for editing."
            closeAriaLabel="Close create file dialog"
            isBusy={isCreating}
            errorMessage={
                validationError ??
                (createFileMutation.isError
                    ? getErrorMessage(
                          createFileMutation.error,
                          "Create file failed",
                      )
                    : null)
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
                        setValidationError(null);
                        createFileMutation.reset();
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

    React.useEffect(() => {
        /** Opens directory creation from the file list without intercepting text entry. */
        const handleShortcut = (event: KeyboardEvent) => {
            if (
                event.key !== "d" ||
                dialogType !== null ||
                shouldIgnoreKeyboardShortcut(event)
            ) {
                return;
            }

            event.preventDefault();
            setDialogType("directory");
        };

        window.addEventListener("keydown", handleShortcut);
        return () => window.removeEventListener("keydown", handleShortcut);
    }, [dialogType]);

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
                        <Tooltip
                            content="Create a new directory (d)"
                            className="w-full"
                        >
                            <ActionMenuButton
                                onClick={() => {
                                    close();
                                    setDialogType("directory");
                                }}
                            >
                                <FolderPlus className="h-4 w-4 text-slate-400" />
                                New directory
                            </ActionMenuButton>
                        </Tooltip>
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

/** Keeps controls that affect only the file-list representation inside that view. */
export function DirectoryFilesActions(props: {
    agent: Agent;
    directoryPath: string;
    showHiddenFiles: boolean;
    onToggleHiddenFiles: () => void;
}) {
    const directoryName =
        props.directoryPath.split("/").filter(Boolean).pop() ?? "/";
    const archiveName = `${directoryName === "/" ? "archive" : directoryName}.tar.gz`;

    return (
        <div
            aria-label="Files view actions"
            className="flex flex-wrap items-center justify-between gap-1 border-b border-slate-800 bg-slate-900/35 p-1.5 sm:gap-2 sm:p-2"
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
            <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain">
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
                <PersistentPathActions
                    agent={props.agent}
                    path={props.directoryPath}
                    currentName={directoryName}
                    entryType="directory"
                    downloadUrl={props.agent.getRawUrl(props.directoryPath, {
                        download: true,
                    })}
                    downloadName={archiveName}
                    downloadTooltip="Downloads this directory as a .tar.gz archive."
                    secondaryDownload
                />
            </div>
        </div>
    );
}
