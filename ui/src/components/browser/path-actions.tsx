import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
    Download,
    ExternalLink,
    LoaderCircle,
    MoreHorizontal,
    Pencil,
    RefreshCw,
    Trash2,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { BookmarkMenuButton } from "#ui/components/browser/bookmark-action";
import { refreshBrowserPath } from "#ui/components/browser/refresh";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { InputControl } from "#ui/components/input-control";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";
import {
    getErrorMessage,
    getImmediateParentPath,
    joinBrowserPath,
} from "#ui/components/browser/utils";

/** Renames the current entry in a focused workflow and follows its new URL. */
function RenamePathDialog(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
    navigateAfterRename: boolean;
    isOpen: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const router = useRouter();
    const [name, setName] = React.useState(props.currentName);
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const renameMutation = useMutation({
        mutationFn: (newName: string) => {
            const parentPath = getImmediateParentPath(props.path);
            if (parentPath === null) {
                throw new Error("The filesystem root cannot be renamed");
            }
            return props.agent.renamePath(
                parentPath,
                props.currentName,
                newName,
            );
        },
        onSuccess: async (_, newName) => {
            const parentPath = getImmediateParentPath(props.path);
            if (parentPath === null) {
                return;
            }
            props.onClose();
            if (!props.navigateAfterRename) {
                await router.invalidate();
                return;
            }
            await navigate({
                to: props.agent.getBrowserUrl(
                    joinBrowserPath(parentPath, newName),
                ),
                search:
                    props.view === "details"
                        ? { view: "details" }
                        : props.view === "sync"
                          ? { view: "sync" }
                          : {},
            });
        },
    });
    const parentPath = getImmediateParentPath(props.path);
    const trimmedName = name.trim();
    const isRenaming = renameMutation.isPending;
    const canRename =
        parentPath !== null &&
        trimmedName.length > 0 &&
        trimmedName !== props.currentName &&
        !trimmedName.includes("/") &&
        trimmedName !== "." &&
        trimmedName !== "..";

    React.useEffect(() => {
        setName(props.currentName);
        setValidationError(null);
        renameMutation.reset();
    }, [props.currentName, props.isOpen, props.path]);

    const handleRename = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (parentPath === null) {
            setValidationError("The filesystem root cannot be renamed");
            return;
        }
        if (!trimmedName) {
            setValidationError(
                `${props.entryType === "file" ? "File" : "Directory"} name is required`,
            );
            return;
        }
        if (
            trimmedName.includes("/") ||
            trimmedName === "." ||
            trimmedName === ".."
        ) {
            setValidationError("Name must be a single path component");
            return;
        }
        if (trimmedName === props.currentName) {
            return;
        }

        setValidationError(null);
        renameMutation.mutate(trimmedName);
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
                validationError ??
                (renameMutation.isError
                    ? getErrorMessage(renameMutation.error, "Rename failed")
                    : null)
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
                <InputControl
                    ref={focusAndSelectFileNameStem}
                    id={`${props.entryType}-rename-input`}
                    type="text"
                    value={name}
                    onChange={(event) => {
                        setName(event.target.value);
                        setValidationError(null);
                        renameMutation.reset();
                    }}
                    aria-label={label}
                    disabled={isRenaming || parentPath === null}
                    className="w-full rounded-lg bg-slate-950/70 text-sm transition focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={isRenaming}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        disabled={!canRename || isRenaming}
                        isLoading={isRenaming}
                        className="font-semibold"
                    >
                        <Pencil className="h-4 w-4" />
                        {isRenaming ? "Renaming..." : "Rename"}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/** Owns the rename workflow so different surfaces can provide their own trigger. */
export function RenamePathAction(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
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

/** Keeps refresh, rename, and destructive object actions out of the primary action row. */
function PathMoreActions(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
    isEditorDirty?: boolean;
    onDelete?: () => void;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const canModify = getImmediateParentPath(props.path) !== null;
    const openMutation = useMutation({
        mutationFn: () => props.agent.openPath(props.path),
    });

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
                        hideLabel={true}
                    >
                        {(close) => (
                            <>
                                {props.agent.supportsNativeOpen ? (
                                    <ActionMenuButton
                                        disabled={openMutation.isPending}
                                        onClick={() => {
                                            close();
                                            openMutation.mutate();
                                        }}
                                    >
                                        {openMutation.isPending ? (
                                            <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />
                                        ) : (
                                            <ExternalLink className="h-4 w-4 text-slate-400" />
                                        )}
                                        {openMutation.isPending
                                            ? "Opening..."
                                            : "Open natively"}
                                    </ActionMenuButton>
                                ) : null}
                                <ActionMenuButton
                                    onClick={() => {
                                        close();
                                        void refreshBrowserPath({
                                            router,
                                            queryClient,
                                            fileContent:
                                                props.entryType === "file"
                                                    ? {
                                                          agentId:
                                                              props.agent.id,
                                                          path: props.path,
                                                      }
                                                    : undefined,
                                            isEditorDirty: props.isEditorDirty,
                                        });
                                    }}
                                >
                                    <RefreshCw className="h-4 w-4 text-slate-400" />
                                    Refresh
                                </ActionMenuButton>
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
                                <BookmarkMenuButton
                                    close={close}
                                    bookmark={{
                                        agentId: props.agent.id,
                                        path: props.path,
                                        name: props.currentName,
                                        entryType: props.entryType,
                                    }}
                                />
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
                    {openMutation.isSuccess || openMutation.isError ? (
                        <Toast
                            tone={openMutation.isError ? "error" : "success"}
                            icon={<ExternalLink className="h-4 w-4" />}
                            dismissAriaLabel="Dismiss native open message"
                            onDismiss={() => openMutation.reset()}
                        >
                            {openMutation.isError
                                ? getErrorMessage(
                                      openMutation.error,
                                      "Could not open the path",
                                  )
                                : "Opened on the agent computer"}
                        </Toast>
                    ) : null}
                </>
            )}
        </RenamePathAction>
    );
}

/** Keeps object-level actions stable while each representation supplies its own controls. */
export function PersistentPathActions(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
    downloadUrl: string;
    downloadName: string;
    /** Explains archive packaging when the download is a directory tarball. */
    downloadTooltip?: string;
    isEditorDirty?: boolean;
    secondaryDownload?: boolean;
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.path);
    const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = React.useState(false);
    const deleteMutation = useMutation({
        mutationFn: () => props.agent.deleteFile(props.path),
        onSuccess: async () => {
            if (parentPath === null) {
                return;
            }
            setIsConfirmDeleteOpen(false);
            await navigate({ to: props.agent.getBrowserUrl(parentPath) });
        },
    });

    const closeDeleteDialog = () => {
        if (deleteMutation.isPending) {
            return;
        }
        setIsConfirmDeleteOpen(false);
        deleteMutation.reset();
    };

    const handleDelete = async () => {
        if (parentPath === null) {
            return;
        }
        deleteMutation.mutate();
    };

    const downloadLink = (
        <a
            href={props.downloadUrl}
            download={props.downloadName}
            className={
                props.secondaryDownload
                    ? "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                    : "inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500"
            }
        >
            <Download className="h-4 w-4" />
            Download
        </a>
    );

    return (
        <>
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
                isEditorDirty={props.isEditorDirty}
                onDelete={() => {
                    deleteMutation.reset();
                    setIsConfirmDeleteOpen(true);
                }}
            />
            <ConfirmationDialog
                isOpen={isConfirmDeleteOpen}
                title={`Delete this ${props.entryType}?`}
                description={
                    <>
                        This permanently deletes
                        <span className="mx-1 font-medium text-slate-100">
                            {props.currentName}
                        </span>
                        from the agent filesystem.
                    </>
                }
                confirmLabel={`Delete ${props.entryType}`}
                busyLabel="Deleting..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? getErrorMessage(deleteMutation.error, "Delete failed")
                        : null
                }
                onClose={closeDeleteDialog}
                onConfirm={handleDelete}
            >
                <p className="overflow-x-auto whitespace-nowrap rounded-md border border-slate-800 bg-[#0b0d12] px-3 py-2.5 font-mono text-sm text-slate-300">
                    {props.path}
                </p>
            </ConfirmationDialog>
        </>
    );
}
