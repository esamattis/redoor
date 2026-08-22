import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
    ArchiveRestore,
    Download,
    ExternalLink,
    LoaderCircle,
    MoreHorizontal,
    Pencil,
    Trash2,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { BookmarkMenuButton } from "#ui/components/browser/bookmark-action";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
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
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";
import {
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
} from "#ui/selected-files";

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

/** Owns native-open feedback so the menu can close without losing the toast. */
function OpenNativelyAction(props: {
    agent: Agent;
    path: string;
    children: (action: {
        open: () => void;
        isPending: boolean;
        toast: React.ReactNode;
    }) => React.ReactNode;
}) {
    const openMutation = useMutation({
        mutationFn: () => props.agent.openPath(props.path),
    });

    return props.children({
        open: () => openMutation.mutate(),
        isPending: openMutation.isPending,
        toast:
            openMutation.isSuccess || openMutation.isError ? (
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
            ) : null,
    });
}

/** Renders the shared path verbs so each surface only chooses which ones apply. */
function PathActionMenuItems(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    close: () => void;
    renameDisabled: boolean;
    onRename: () => void;
    showOpenNatively?: boolean;
    openNativelyPending?: boolean;
    onOpenNatively?: () => void;
    showSelect?: boolean;
    showDownload?: boolean;
    downloadUrl?: string;
    downloadName?: string;
    onDownloadDirectory?: () => void;
    showUnarchive?: boolean;
    onUnarchive?: () => void;
    onDelete?: () => void;
    deleteDisabled?: boolean;
}) {
    return (
        <>
            {props.showOpenNatively &&
            props.agent.supportsNativeOpen &&
            props.onOpenNatively ? (
                <ActionMenuButton
                    disabled={props.openNativelyPending}
                    onClick={() => {
                        props.close();
                        props.onOpenNatively?.();
                    }}
                >
                    {props.openNativelyPending ? (
                        <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />
                    ) : (
                        <ExternalLink className="h-4 w-4 text-slate-400" />
                    )}
                    {props.openNativelyPending ? "Opening..." : "Open natively"}
                </ActionMenuButton>
            ) : null}
            <ActionMenuButton
                disabled={props.renameDisabled}
                onClick={() => {
                    props.close();
                    props.onRename();
                }}
            >
                <Pencil className="h-4 w-4 text-slate-400" />
                Rename
            </ActionMenuButton>
            {props.showDownload ? (
                props.entryType === "directory" ? (
                    <ActionMenuButton
                        onClick={() => {
                            props.close();
                            props.onDownloadDirectory?.();
                        }}
                    >
                        <Download className="h-4 w-4 text-slate-400" />
                        Download
                    </ActionMenuButton>
                ) : (
                    <ActionMenuButton asChild>
                        <a
                            href={props.downloadUrl}
                            download={props.downloadName}
                            onClick={props.close}
                        >
                            <Download className="h-4 w-4 text-slate-400" />
                            Download
                        </a>
                    </ActionMenuButton>
                )
            ) : null}
            {props.showUnarchive && props.onUnarchive ? (
                <ActionMenuButton
                    onClick={() => {
                        props.close();
                        props.onUnarchive?.();
                    }}
                >
                    <ArchiveRestore className="h-4 w-4 text-slate-400" />
                    Unarchive
                </ActionMenuButton>
            ) : null}
            {props.showSelect ? (
                <SelectPathMenuButton
                    agent={props.agent}
                    path={props.path}
                    fileName={props.currentName}
                    entryType={props.entryType}
                    close={props.close}
                />
            ) : null}
            <BookmarkMenuButton
                close={props.close}
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
                        disabled={props.deleteDisabled}
                        onClick={() => {
                            props.close();
                            props.onDelete?.();
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                        Delete {props.entryType}
                    </ActionMenuButton>
                </>
            ) : null}
        </>
    );
}

/** Owns rename and native-open dialogs so the overflow menu can close first. */
export function PathActionMenu(props: {
    label: string;
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
    navigateAfterRename?: boolean;
    showOpenNatively?: boolean;
    showSelect?: boolean;
    showDownload?: boolean;
    downloadUrl?: string;
    downloadName?: string;
    onDownloadDirectory?: () => void;
    showUnarchive?: boolean;
    onUnarchive?: () => void;
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
            navigateAfterRename={props.navigateAfterRename}
        >
            {(renameAction) => (
                <OpenNativelyAction agent={props.agent} path={props.path}>
                    {(openNatively) => (
                        <>
                            <ActionMenu
                                label={props.label}
                                icon={<MoreHorizontal className="h-4 w-4" />}
                                variant="icon"
                            >
                                {(close) => (
                                    <PathActionMenuItems
                                        agent={props.agent}
                                        path={props.path}
                                        currentName={props.currentName}
                                        entryType={props.entryType}
                                        close={close}
                                        renameDisabled={renameAction.disabled}
                                        onRename={renameAction.open}
                                        showOpenNatively={
                                            props.showOpenNatively
                                        }
                                        openNativelyPending={
                                            openNatively.isPending
                                        }
                                        onOpenNatively={openNatively.open}
                                        showSelect={props.showSelect}
                                        showDownload={props.showDownload}
                                        downloadUrl={props.downloadUrl}
                                        downloadName={props.downloadName}
                                        onDownloadDirectory={
                                            props.onDownloadDirectory
                                        }
                                        showUnarchive={props.showUnarchive}
                                        onUnarchive={props.onUnarchive}
                                        onDelete={props.onDelete}
                                        deleteDisabled={!canModify}
                                    />
                                )}
                            </ActionMenu>
                            {renameAction.dialog}
                            {openNatively.toast}
                        </>
                    )}
                </OpenNativelyAction>
            )}
        </RenamePathAction>
    );
}

/** Lets any path menu add or remove the current entry without duplicating selection wiring. */
export function SelectPathMenuButton(props: {
    agent: Agent;
    path: string;
    fileName: string;
    entryType: "file" | "directory";
    close: () => void;
}) {
    const selectedFileKeys = useAtomValue(selectedFileKeysAtom);
    const toggleSelectedFile = useSetAtom(toggleSelectedFileAtom);
    const activateBottomDrawerTab = useSetAtom(activateBottomDrawerTabAtom);
    const isSelected = selectedFileKeys.has(`${props.agent.id}:${props.path}`);
    const label = isSelected ? "Unselect" : "Select";

    return (
        <Checkbox
            checked={isSelected}
            label={label}
            title={false}
            className="w-full px-3 py-2"
            onCheckedChange={() => {
                props.close();
                toggleSelectedFile({
                    agentId: props.agent.id,
                    agentName: props.agent.name,
                    path: props.path,
                    fileName: props.fileName,
                    entryType: props.entryType,
                });
                if (!isSelected) {
                    // Menu selection has no listing checkbox, so show the chosen path immediately.
                    activateBottomDrawerTab("selected");
                }
            }}
        >
            {label}
        </Checkbox>
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
    secondaryDownload?: boolean;
    /** Lets a view keep Reload next to Download without hiding it in More. */
    afterDownload?: React.ReactNode;
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
            aria-label="Download"
            className={
                props.secondaryDownload
                    ? "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                    : "inline-flex items-center gap-2 rounded-md bg-[var(--app-primary)] px-3.5 py-2 text-sm font-medium text-[var(--app-primary-ink)] transition-colors hover:bg-[var(--app-primary-hover)]"
            }
        >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Download</span>
        </a>
    );

    return (
        <>
            <div className="flex items-center gap-1">
                <Tooltip content={props.downloadTooltip ?? "Download"}>
                    {downloadLink}
                </Tooltip>
                {props.afterDownload}
                <PathActionMenu
                    label="More"
                    agent={props.agent}
                    path={props.path}
                    currentName={props.currentName}
                    entryType={props.entryType}
                    view={props.view}
                    showOpenNatively={true}
                    showSelect={true}
                    onDelete={() => {
                        deleteMutation.reset();
                        setIsConfirmDeleteOpen(true);
                    }}
                />
            </div>
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
