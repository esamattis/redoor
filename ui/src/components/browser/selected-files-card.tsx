import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useMutation } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    Copy,
    Files,
    FolderInput,
    MoreHorizontal,
    PanelBottom,
    Trash2,
    X,
} from "lucide-react";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import type { Agent, ApiClient, CopyExistingMode } from "#ui/api-client";
import {
    selectedFilesAtom,
    clearSelectedFilesAtom,
    unselectFileAtom,
    type SelectedPath,
} from "#ui/selected-files";
import {
    getErrorMessage,
    isBrowserPathInside,
    joinBrowserPath,
} from "#ui/components/browser/utils";
import {
    SelectedFilesTransferTrigger,
    type SelectedFilesTransferOperation,
    type SelectedFilesTransferTriggerApi,
} from "#ui/components/browser/selected-files-transfer-dialog";
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";
import { useIsBelowBreakpoint } from "#ui/utils/use-breakpoint";

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
    pendingTransfers: Map<number, SelectedPath>;
    completedFiles: SelectedPath[];
    failures: unknown[];
    failedLabel: string;
    signal: AbortSignal;
}): Promise<boolean> {
    try {
        while (props.pendingTransfers.size > 0 && !props.signal.aborted) {
            // Read the public list directly so a transfers_changed invalidation
            // cannot abort this wait as a TanStack Query CancelledError.
            const progress = await props.api.getTransferProgress();
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
 * Hides Copy/Move when every item would land on itself or a selected
 * directory would be nested inside its own tree.
 */
function canTransferSelectedFiles(props: {
    selectedFiles: SelectedPath[];
    destinationAgentId: string;
    directoryPath: string;
    isTransferring: boolean;
    isSiblingTransferring: boolean;
    isRoutePending: boolean;
}) {
    if (
        props.selectedFiles.length === 0 ||
        props.isTransferring ||
        props.isSiblingTransferring ||
        props.isRoutePending
    ) {
        return false;
    }

    const allLandOnThemselves = props.selectedFiles.every(
        (file) =>
            file.agentId === props.destinationAgentId &&
            file.path === joinBrowserPath(props.directoryPath, file.fileName),
    );
    if (allLandOnThemselves) {
        return false;
    }

    return !props.selectedFiles.some(
        (file) =>
            file.entryType === "directory" &&
            file.agentId === props.destinationAgentId &&
            isBrowserPathInside(file.path, props.directoryPath),
    );
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
    children: (trigger: SelectedFilesTransferTriggerApi) => React.ReactNode;
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
    const canTransfer = canTransferSelectedFiles({
        selectedFiles,
        destinationAgentId: props.destinationAgent.id,
        directoryPath: props.directoryPath,
        isTransferring,
        isSiblingTransferring: props.isSiblingTransferring,
        isRoutePending,
    });

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
        } catch (error) {
            if (controller.signal.aborted) return;
            setTransferState({
                type: "error",
                message: getErrorMessage(error, labels.failed),
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
            >
                {props.children}
            </SelectedFilesTransferTrigger>
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

/** Renders a compact transfer button so desktop can keep Copy and Move visible. */
function SelectedFilesTransferButton(props: {
    trigger: SelectedFilesTransferTriggerApi;
}) {
    if (!props.trigger.canTransfer) {
        return null;
    }

    return (
        <Tooltip content={props.trigger.labels.buttonTooltip}>
            <Button
                type="button"
                onClick={props.trigger.start}
                aria-label={props.trigger.labels.buttonAriaLabel}
                size="sm"
                className="h-9 rounded-md px-3.5 py-0 font-semibold shadow-sm shadow-blue-950/30"
            >
                <props.trigger.labels.Icon className="h-3.5 w-3.5" />
                {props.trigger.labels.buttonLabel}
            </Button>
        </Tooltip>
    );
}

/**
 * Keeps Copy, Move, and Delete off a second mobile row by parking them in one
 * Actions dialog, while desktop still shows the verbs inline.
 */
function SelectedFilesCardActions(props: {
    isMobile: boolean;
    canDelete: boolean;
    copyTrigger: SelectedFilesTransferTriggerApi;
    moveTrigger: SelectedFilesTransferTriggerApi;
    onDelete: () => void;
    onClear: () => void;
}) {
    const hasMenuActions =
        props.copyTrigger.canTransfer ||
        props.moveTrigger.canTransfer ||
        props.canDelete;

    return (
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {props.isMobile ? (
                hasMenuActions ? (
                    <ActionMenu
                        label="Actions"
                        icon={<MoreHorizontal className="h-4 w-4" />}
                        tooltip={false}
                        className="h-9 px-2.5 py-0"
                    >
                        {(close) => (
                            <>
                                {props.copyTrigger.canTransfer ? (
                                    <ActionMenuButton
                                        onClick={() => {
                                            close();
                                            props.copyTrigger.start();
                                        }}
                                    >
                                        <props.copyTrigger.labels.Icon className="h-4 w-4 text-slate-400" />
                                        {props.copyTrigger.labels.buttonLabel}
                                    </ActionMenuButton>
                                ) : null}
                                {props.moveTrigger.canTransfer ? (
                                    <ActionMenuButton
                                        onClick={() => {
                                            close();
                                            props.moveTrigger.start();
                                        }}
                                    >
                                        <props.moveTrigger.labels.Icon className="h-4 w-4 text-slate-400" />
                                        {props.moveTrigger.labels.buttonLabel}
                                    </ActionMenuButton>
                                ) : null}
                                {props.canDelete ? (
                                    <>
                                        <div className="my-1 border-t border-slate-800" />
                                        <ActionMenuButton
                                            tone="danger"
                                            onClick={() => {
                                                close();
                                                props.onDelete();
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                            Delete
                                        </ActionMenuButton>
                                    </>
                                ) : null}
                            </>
                        )}
                    </ActionMenu>
                ) : null
            ) : (
                <>
                    <SelectedFilesTransferButton trigger={props.copyTrigger} />
                    <SelectedFilesTransferButton trigger={props.moveTrigger} />
                    {props.canDelete ? (
                        <Tooltip content="Delete selected items">
                            <Button
                                type="button"
                                variant="danger"
                                aria-label="Delete selected items"
                                onClick={props.onDelete}
                                size="sm"
                                className="h-9 rounded-md border-red-500/40 bg-red-500/10 px-3.5 py-0 font-semibold text-red-200 hover:border-red-500/60 hover:bg-red-500/20"
                            >
                                <Trash2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                                Delete
                            </Button>
                        </Tooltip>
                    ) : null}
                </>
            )}
            <IconButton
                type="button"
                label="Clear selection"
                onClick={props.onClear}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
            >
                <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
        </div>
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

    const isMobile = useIsBelowBreakpoint("sm");
    const hasSelection = selectedFiles.length > 0;
    const canDelete = hasSelection && !deleteMutation.isPending;
    const selectionSummary = `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${directoryCount} ${directoryCount === 1 ? "directory" : "directories"} selected`;
    /** Opens confirm from both the desktop Delete button and the mobile Actions menu. */
    const openDeleteDialog = () => {
        deleteMutation.reset();
        setIsDeleteDialogOpen(true);
    };

    return (
        <>
            <TransferSelectedFilesAction
                operation="copy"
                api={props.api}
                agents={props.agents}
                destinationAgent={props.destinationAgent}
                directoryPath={props.directoryPath}
                destinationFileNames={props.destinationFileNames}
                isSiblingTransferring={busyTransferOperation === "move"}
                onTransferringChange={(isTransferring) =>
                    setBusyTransferOperation(isTransferring ? "copy" : null)
                }
            >
                {(copyTrigger) => (
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
                    >
                        {(moveTrigger) => (
                            <section
                                aria-label="Selected files actions"
                                className="mb-3 flex h-14 min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-blue-500/25 bg-blue-500/5 px-2 sm:gap-3 sm:px-3"
                            >
                                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-300">
                                    <Files
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                </span>
                                {hasSelection ? (
                                    <Tooltip
                                        content="Show selected items"
                                        className="min-w-0 flex-1"
                                    >
                                        <Button
                                            type="button"
                                            variant="subtle"
                                            aria-label={`${selectionSummary}. Show selected items`}
                                            onClick={() =>
                                                activateBottomDrawerTab(
                                                    "selected",
                                                )
                                            }
                                            className="h-9 min-w-0 w-full justify-start gap-2 px-2 py-0 text-left text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white"
                                        >
                                            <span className="truncate">
                                                {selectionSummary}
                                            </span>
                                            <PanelBottom
                                                className="h-4 w-4 shrink-0 text-slate-400"
                                                aria-hidden="true"
                                            />
                                        </Button>
                                    </Tooltip>
                                ) : (
                                    <p className="flex h-9 min-w-0 flex-1 items-center truncate px-2 text-sm font-medium text-slate-200">
                                        {selectionSummary}
                                    </p>
                                )}
                                {hasSelection ? (
                                    <SelectedFilesCardActions
                                        isMobile={isMobile}
                                        canDelete={canDelete}
                                        copyTrigger={copyTrigger}
                                        moveTrigger={moveTrigger}
                                        onDelete={openDeleteDialog}
                                        onClear={clearSelectedFiles}
                                    />
                                ) : null}
                            </section>
                        )}
                    </TransferSelectedFilesAction>
                )}
            </TransferSelectedFilesAction>
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
