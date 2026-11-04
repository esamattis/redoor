import type { ResumeMode } from "#bindings/ResumeMode";
import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    useMutation,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
    Archive,
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
import {
    DeletePathsDialog,
    type DeletePathTarget,
} from "#ui/components/browser/delete-paths-dialog";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import type { Agent, ApiClient } from "#ui/api-client";
import type { LsEntry } from "#bindings/LsEntry";
import { invalidateAgentData } from "#ui/queries";
import { waitForTransfers } from "#ui/transfer-wait";
import {
    selectedFilesAtom,
    clearSelectedFilesAtom,
    hasRevisionSelection,
    unselectFileAtom,
    type SelectedPath,
} from "#ui/selected-files";
import {
    isBrowserPathInside,
    joinBrowserPath,
} from "#ui/components/browser/utils";
import { getErrorMessage } from "#ui/utils/error";
import {
    SelectedFilesTransferTrigger,
    type SelectedFilesTransferOperation,
    type SelectedFilesTransferTriggerApi,
    type PlannedTransferItem,
} from "#ui/components/browser/selected-files-transfer-dialog";
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";
import { useIsContentBelow } from "#ui/utils/use-breakpoint";
import { AffectedPathsList } from "#ui/components/browser/affected-paths-list";
import { CreateArchiveDialog } from "#ui/components/browser/create-archive-dialog";
import {
    getCreateArchiveSelectionError,
    type ArchiveSource,
} from "#ui/utils/archive";

/** A selection paired with the name it lands under, which differs only when renamed. */

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
 * Waits on the shared transfers query so only finished items are unselected. Returns false
 * when the run was aborted and the caller must not update UI state.
 */
async function waitForPendingTransfers(props: {
    queryClient: QueryClient;
    api: ApiClient;
    pendingTransfers: Map<number, PlannedTransferItem>;
    completedFiles: SelectedPath[];
    pausedFiles: SelectedPath[];
    destinationAgentId: string;
    directoryPath: string;
    failures: unknown[];
    failedLabel: string;
    signal: AbortSignal;
}): Promise<boolean> {
    if (props.pendingTransfers.size === 0) {
        return !props.signal.aborted;
    }

    try {
        return await waitForTransfers({
            queryClient: props.queryClient,
            api: props.api,
            signal: props.signal,
            isSettled: async (transfers) => {
                for (const transfer of transfers) {
                    const item = props.pendingTransfers.get(
                        transfer.request_id,
                    );

                    if (!item) continue;

                    if (transfer.state === "completed") {
                        props.completedFiles.push(item.file);
                        props.pendingTransfers.delete(transfer.request_id);
                    } else if (transfer.state === "errored") {
                        props.failures.push(
                            transfer.error ?? props.failedLabel,
                        );
                        props.pendingTransfers.delete(transfer.request_id);
                    }
                }

                const visibleIds = new Set(
                    transfers.map((transfer) => transfer.request_id),
                );

                const missingTransfers = [...props.pendingTransfers].filter(
                    ([id]) => !visibleIds.has(id),
                );

                if (missingTransfers.length > 0) {
                    // A paused copy drops its row, so its kept partial is the only trace.
                    const inventory = await props.api.listPartials();

                    for (const [id, item] of missingTransfers) {
                        const paused = inventory.partials.some(
                            (partial) =>
                                partial.source.agent === item.file.agentId &&
                                partial.source.path === item.file.path &&
                                partial.dest_agent_id ===
                                    props.destinationAgentId &&
                                partial.dest.path ===
                                    joinBrowserPath(
                                        props.directoryPath,
                                        item.destinationName,
                                    ),
                        );

                        if (paused) {
                            props.pausedFiles.push(item.file);
                            props.pendingTransfers.delete(id);
                        }
                    }
                }

                return props.pendingTransfers.size === 0;
            },
        });
    } catch (error) {
        props.failures.push(error);

        return !props.signal.aborted;
    }
}

/**
 * Hides Copy/Move when every item would land on itself or a selected
 * directory would be nested inside its own tree. Items selected in Git history are read
 * from a commit, so they never land on themselves (copying one over its working file is a
 * restore) and cannot recurse into their own copy; they hide Move, which cannot delete a
 * commit.
 */
function canTransferSelectedFiles(props: {
    operation: SelectedFilesTransferOperation;
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
        props.isRoutePending ||
        (props.operation === "move" &&
            hasRevisionSelection(props.selectedFiles))
    ) {
        return false;
    }

    const worktreeFiles = props.selectedFiles.filter(
        (file) => file.rev === undefined,
    );

    const allLandOnThemselves =
        worktreeFiles.length === props.selectedFiles.length &&
        worktreeFiles.every(
            (file) =>
                file.agentId === props.destinationAgentId &&
                file.path ===
                    joinBrowserPath(props.directoryPath, file.fileName),
        );

    if (allLandOnThemselves) {
        return false;
    }

    return !worktreeFiles.some(
        (file) =>
            file.entryType === "directory" &&
            file.agentId === props.destinationAgentId &&
            isBrowserPathInside(file.path, props.directoryPath),
    );
}

/** Starts selected transfers through one mutation shared by copy and move. */
function useTransferStarts(props: {
    agents: Agent[];
    destinationAgent: Agent;
    directoryPath: string;
    operation: SelectedFilesTransferOperation;
}) {
    const isCopy = props.operation === "copy";

    return useMutation({
        mutationFn: (request: {
            itemsToTransfer: PlannedTransferItem[];
            resume: ResumeMode;
        }) => {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );

            return Promise.allSettled(
                request.itemsToTransfer.map(
                    async ({ file, destinationName, existingMode }) => {
                        const sourceAgent = agentsById.get(file.agentId);

                        if (!sourceAgent) {
                            throw new Error(
                                `Source device unavailable for selected item: ${file.agentName}`,
                            );
                        }

                        const destination = {
                            agent: props.destinationAgent.id,
                            path: joinBrowserPath(
                                props.directoryPath,
                                destinationName,
                            ),
                        };

                        const options = {
                            on_existing: existingMode,
                            resume: request.resume,
                        };

                        if (isCopy) {
                            const response = await sourceAgent.copyTo(
                                destination,
                                file.path,
                                { ...options, sourceRev: file.rev },
                            );

                            return response.copy_request_id;
                        }

                        const response = await sourceAgent.moveTo(
                            destination,
                            file.path,
                            options,
                        );

                        return response.move_request_id;
                    },
                ),
            );
        },
    });
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
    destinationEntries: LsEntry[];
    isSiblingTransferring: boolean;
    onTransferringChange: (isTransferring: boolean) => void;
    children: (trigger: SelectedFilesTransferTriggerApi) => React.ReactNode;
}) {
    const queryClient = useQueryClient();
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

    const transferStartsMutation = useTransferStarts(props);

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
        operation: props.operation,
        selectedFiles,
        destinationAgentId: props.destinationAgent.id,
        directoryPath: props.directoryPath,
        isTransferring,
        isSiblingTransferring: props.isSiblingTransferring,
        isRoutePending,
    });

    /**
     * Starts every confirmed item under the name and conflict policy chosen for it in the
     * dialog, so one item can replace an existing entry while another is renamed.
     */
    const transferSelectedFiles = async (
        itemsToTransfer: PlannedTransferItem[],
        resume: ResumeMode,
    ) => {
        if (itemsToTransfer.length === 0) {
            return;
        }

        const filesToTransfer = itemsToTransfer.map((item) => item.file);

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
                itemsToTransfer,
                resume,
            });

            if (controller.signal.aborted) return;

            const completedFiles: SelectedPath[] = [];
            const pausedFiles: SelectedPath[] = [];
            const failures: unknown[] = [];

            const pendingTransfers = new Map(
                results.flatMap((result, index) => {
                    const item = itemsToTransfer[index];

                    if (result.status === "rejected") {
                        failures.push(result.reason);

                        return [];
                    }

                    return item ? [[result.value, item] as const] : [];
                }),
            );

            const stillActive = await waitForPendingTransfers({
                queryClient,
                api: props.api,
                pendingTransfers,
                completedFiles,
                pausedFiles,
                destinationAgentId: props.destinationAgent.id,
                directoryPath: props.directoryPath,
                failures,
                failedLabel: labels.failed,
                signal: controller.signal,
            });

            if (!stillActive) return;
            activeTransferRef.current = null;

            completedFiles.forEach((file) => {
                unselectFile(file);
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
                    pausedFiles.length > 0
                        ? `Paused ${pausedFiles.length} ${pausedFiles.length === 1 ? "item" : "items"}`
                        : filesToTransfer.length === 1
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
                api={props.api}
                operation={props.operation}
                selectedFiles={selectedFiles}
                destinationAgent={props.destinationAgent}
                directoryPath={props.directoryPath}
                destinationEntries={props.destinationEntries}
                canTransfer={canTransfer}
                onConfirm={(items, resume) =>
                    void transferSelectedFiles(items, resume)
                }
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

/**
 * Renders a square icon transfer button so the desktop card fits every bulk action on one
 * row; the tooltip carries the verb that the icon alone leaves ambiguous.
 */
function SelectedFilesTransferButton(props: {
    trigger: SelectedFilesTransferTriggerApi;
}) {
    if (!props.trigger.canTransfer) {
        return null;
    }

    return (
        <IconButton
            tooltip={props.trigger.labels.buttonTooltip}
            type="button"
            onClick={props.trigger.start}
            label={props.trigger.labels.buttonAriaLabel}
            size="xl"
            className="rounded-md bg-blue-600 text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500"
        >
            <props.trigger.labels.Icon className="h-4 w-4" aria-hidden="true" />
        </IconButton>
    );
}

/**
 * Keeps Copy, Move, Archive, and Delete off a second mobile row by parking them in one
 * Actions dialog, while desktop still shows the verbs inline.
 */
function SelectedFilesCardActions(props: {
    isMobile: boolean;
    canDelete: boolean;
    copyTrigger: SelectedFilesTransferTriggerApi;
    moveTrigger: SelectedFilesTransferTriggerApi;
    /** Why the selection cannot be archived here, or null when it can. */
    createArchiveError: string | null;
    onCreateArchive: () => void;
    onDelete: () => void;
    onClear: () => void;
}) {
    return (
        <div className="flex shrink-0 items-center gap-1 @xl:gap-2">
            {/* Archive stays listed even when unavailable, so the menu always has content. */}
            {props.isMobile ? (
                <ActionMenu
                    label="Actions"
                    icon={<MoreHorizontal className="h-4 w-4" />}
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
                            <ActionMenuButton
                                disabled={props.createArchiveError !== null}
                                onClick={() => {
                                    close();
                                    props.onCreateArchive();
                                }}
                            >
                                <Archive className="h-4 w-4 text-slate-400" />
                                Create archive
                            </ActionMenuButton>
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
            ) : (
                <>
                    <SelectedFilesTransferButton trigger={props.copyTrigger} />
                    <SelectedFilesTransferButton trigger={props.moveTrigger} />
                    <IconButton
                        tooltip={
                            props.createArchiveError ??
                            "Create an archive of the selected items in this directory"
                        }
                        type="button"
                        label="Create archive of selected items"
                        disabled={props.createArchiveError !== null}
                        onClick={props.onCreateArchive}
                        variant="outline"
                        size="xl"
                    >
                        <Archive className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    {props.canDelete ? (
                        <IconButton
                            type="button"
                            label="Delete selected items"
                            onClick={props.onDelete}
                            size="xl"
                            className="rounded-md border border-red-500/40 bg-red-500/10 text-red-200 transition-colors hover:border-red-500/60 hover:bg-red-500/20"
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                    ) : null}
                </>
            )}
            <IconButton
                type="button"
                label="Clear selection"
                onClick={props.onClear}
                variant="ghost"
                size="xl"
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
    destinationEntries: LsEntry[];
}) {
    const queryClient = useQueryClient();
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const clearSelectedFiles = useSetAtom(clearSelectedFilesAtom);
    const activateBottomDrawerTab = useSetAtom(activateBottomDrawerTabAtom);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);

    const [isCreateArchiveDialogOpen, setIsCreateArchiveDialogOpen] =
        React.useState(false);

    // One lock so Copy cannot start while Move is still reading or deleting sources.
    const [busyTransferOperation, setBusyTransferOperation] =
        React.useState<SelectedFilesTransferOperation | null>(null);

    const fileCount = selectedFiles.filter(
        (file) => file.entryType === "file",
    ).length;

    const directoryCount = selectedFiles.length - fileCount;
    const isMobile = useIsContentBelow("xl");
    const hasSelection = selectedFiles.length > 0;
    // A commit cannot be deleted or archived by a shell in this directory, only copied.
    const selectsHistory = hasRevisionSelection(selectedFiles);
    const canDelete = hasSelection && !selectsHistory;
    const selectionSummary = `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${directoryCount} ${directoryCount === 1 ? "directory" : "directories"} selected`;

    // Clearing the selection dismisses the delete prompt. Resetting while rendering keeps it from
    // reappearing when something is selected again.
    if (isDeleteDialogOpen && !hasSelection) {
        setIsDeleteDialogOpen(false);
    }

    if (isCreateArchiveDialogOpen && !hasSelection) {
        setIsCreateArchiveDialogOpen(false);
    }

    /** Opens confirm from both the desktop Delete button and the mobile Actions menu. */
    const openDeleteDialog = () => {
        setIsDeleteDialogOpen(true);
    };

    const agentsById = new Map(props.agents.map((agent) => [agent.id, agent]));

    const archiveSources: ArchiveSource[] = selectedFiles.map((file) => ({
        agentId: file.agentId,
        path: file.path,
    }));

    const createArchiveError = selectsHistory
        ? "Archives can only be created from working files. Copy items from Git history first."
        : getCreateArchiveSelectionError({
              sources: archiveSources,
              agentId: props.destinationAgent.id,
              directoryPath: props.directoryPath,
          });

    const deleteTargets: DeletePathTarget[] = selectedFiles.map((file) => ({
        agent: agentsById.get(file.agentId) ?? null,
        path: file.path,
    }));

    return (
        <>
            <TransferSelectedFilesAction
                operation="copy"
                api={props.api}
                agents={props.agents}
                destinationAgent={props.destinationAgent}
                directoryPath={props.directoryPath}
                destinationEntries={props.destinationEntries}
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
                        destinationEntries={props.destinationEntries}
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
                                className="flex min-w-0 items-center gap-2 overflow-hidden border-b border-slate-800 bg-surface p-4 @xl:p-5"
                            >
                                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-blue-400">
                                    <Files
                                        className="h-5 w-5"
                                        aria-hidden="true"
                                    />
                                </span>
                                {hasSelection ? (
                                    <Button
                                        tooltip="Show selected items"
                                        tooltipClassName="min-w-0 flex-1"
                                        type="button"
                                        variant="ghost"
                                        aria-label={`${selectionSummary}. Show selected items`}
                                        onClick={() =>
                                            activateBottomDrawerTab("selected")
                                        }
                                        className="h-9 min-w-0 w-full justify-start gap-2 px-2 py-0 text-left"
                                    >
                                        <span className="truncate">
                                            {selectionSummary}
                                        </span>
                                        <PanelBottom
                                            className="h-4 w-4 shrink-0 text-slate-400"
                                            aria-hidden="true"
                                        />
                                    </Button>
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
                                        createArchiveError={createArchiveError}
                                        onCreateArchive={() =>
                                            setIsCreateArchiveDialogOpen(true)
                                        }
                                        onDelete={openDeleteDialog}
                                        onClear={clearSelectedFiles}
                                    />
                                ) : null}
                            </section>
                        )}
                    </TransferSelectedFilesAction>
                )}
            </TransferSelectedFilesAction>
            {isCreateArchiveDialogOpen && hasSelection ? (
                <CreateArchiveDialog
                    agent={props.destinationAgent}
                    directoryPath={props.directoryPath}
                    sources={archiveSources}
                    onClose={() => setIsCreateArchiveDialogOpen(false)}
                />
            ) : null}
            {isDeleteDialogOpen && hasSelection ? (
                <DeletePathsDialog
                    title={`Delete ${selectedFiles.length === 1 ? "this selected item" : "these selected items"}?`}
                    description={`Move ${fileCount} ${fileCount === 1 ? "file" : "files"} and ${directoryCount} ${directoryCount === 1 ? "directory" : "directories"} to trash.`}
                    targets={deleteTargets}
                    trashConfirmLabel={
                        selectedFiles.length === 1
                            ? "Move selected item to trash"
                            : `Move ${selectedFiles.length} selected items to trash`
                    }
                    permanentConfirmLabel={
                        selectedFiles.length === 1
                            ? "Delete selected item"
                            : `Delete ${selectedFiles.length} selected items`
                    }
                    requiredConfirmationText="DELETE"
                    onClose={() => setIsDeleteDialogOpen(false)}
                    onDeleted={async (targets) => {
                        targets.forEach((target) => {
                            const selected = selectedFiles.find(
                                (file) =>
                                    file.rev === undefined &&
                                    file.path === target.path &&
                                    file.agentId === target.agent?.id,
                            );

                            if (selected) {
                                unselectFile(selected);
                            }
                        });

                        // Deleted items may live on several agents, including this directory's.
                        const agentIds = new Set(
                            targets.flatMap((target) =>
                                target.agent ? [target.agent.id] : [],
                            ),
                        );

                        await Promise.all(
                            [...agentIds].map((agentId) =>
                                invalidateAgentData(queryClient, agentId),
                            ),
                        );
                    }}
                >
                    <AffectedPathsList
                        paths={selectedFiles}
                        onDeselect={(path) => unselectFile(path)}
                    />
                </DeletePathsDialog>
            ) : null}
        </>
    );
}
