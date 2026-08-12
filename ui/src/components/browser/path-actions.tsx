import React from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
    Download,
    ExternalLink,
    LoaderCircle,
    MoreHorizontal,
    Pencil,
    Trash2,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Dialog } from "#ui/components/dialog";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";
import {
    getErrorMessage,
    getImmediateParentPath,
    joinBrowserPath,
} from "#ui/components/browser/utils";

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };
type RenameState =
    | { type: "idle" }
    | { type: "renaming" }
    | { type: "error"; message: string };
type NativeOpenState =
    | { type: "idle" }
    | { type: "opening" }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/** Renames the current entry in a focused workflow and follows its new URL. */
function RenamePathDialog(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit" | "diff" | "sync";
    navigateAfterRename: boolean;
    isOpen: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const router = useRouter();
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
            await props.agent.renamePath(
                parentPath,
                props.currentName,
                trimmedName,
            );
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
                          : props.view === "diff"
                            ? { view: "diff" }
                            : props.view === "sync"
                              ? { view: "sync" }
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
                    ref={focusAndSelectFileNameStem}
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
export function RenamePathAction(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit" | "diff" | "sync";
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
    view?: "details" | "edit" | "diff" | "sync";
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
export function PersistentPathActions(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "edit" | "diff" | "sync";
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
