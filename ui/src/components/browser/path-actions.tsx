import React from "react";
import {
    DecryptedDownloadMenuButton,
    useDecryptedDownload,
} from "#ui/components/vault/decrypted-download-button";
import { isVaultPath } from "#ui/vault/vault-path";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
    Archive,
    ArchiveRestore,
    Copy,
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
import { DeletePathDialog } from "#ui/components/browser/delete-path-dialog";
import { PathNameDialog } from "#ui/components/browser/path-name-dialog";
import { browserRoute } from "#ui/browser-route";
import { waitForTransfers } from "#ui/transfer-wait";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import {
    getImmediateParentPath,
    joinBrowserPath,
} from "#ui/components/browser/utils";
import { getErrorMessage } from "#ui/utils/error";
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";
import { invalidateAgentData } from "#ui/queries";
import {
    getSelectedFileKey,
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
} from "#ui/selected-files";

/**
 * The Git revision a path menu acts on. Write verbs stay disabled; selecting and downloading
 * read the commit, unless Git records the path as a symlink or submodule (`transferable`
 * false), which have no content to copy or download.
 */
export type PathRevision = {
    commitId: string;
    transferable: boolean;
};

const rootRouteApi = getRouteApi("__root__");

/** Renames the current entry in a focused workflow and follows its new URL. */
function RenamePathDialog(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    view?: "details" | "sync";
    navigateAfterRename: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const parentPath = getImmediateParentPath(props.path);

    const renameMutation = useMutation({
        mutationFn: (newName: string) => {
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
            if (parentPath === null) {
                return;
            }

            props.onClose();

            if (!props.navigateAfterRename) {
                await invalidateAgentData(queryClient, props.agent.id);

                return;
            }

            await navigate({
                ...browserRoute(
                    props.agent,
                    joinBrowserPath(parentPath, newName),
                ),
                search: { view: props.view },
            });
        },
    });

    return (
        <PathNameDialog
            title={`Rename ${props.entryType}`}
            description={`Choose a new name for ${props.currentName}.`}
            closeAriaLabel={`Close rename ${props.entryType} dialog`}
            kind={props.entryType === "file" ? "File" : "Directory"}
            fieldLabel="New name"
            fieldAriaLabel={`Rename ${props.entryType}`}
            placeholder={props.currentName}
            fieldDescription="The entry keeps its contents and moves to this name."
            initialName={props.currentName}
            requireChange
            selectNameStem
            unavailableMessage={
                parentPath === null
                    ? "The filesystem root cannot be renamed"
                    : null
            }
            submitLabel="Rename"
            busyLabel="Renaming..."
            submitIcon={<Pencil className="h-4 w-4" />}
            mutation={renameMutation}
            onClose={props.onClose}
        />
    );
}

/** Owns the rename workflow so different surfaces can provide their own trigger. */
function RenamePathAction(props: {
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
        dialog: isOpen ? (
            <RenamePathDialog
                agent={props.agent}
                path={props.path}
                currentName={props.currentName}
                entryType={props.entryType}
                view={props.view}
                navigateAfterRename={props.navigateAfterRename !== false}
                onClose={() => setIsOpen(false)}
            />
        ) : null,
    });
}

/** Copies the current entry beside its source so the original path stays in place. */
function DuplicatePathDialog(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
    onClose: () => void;
}) {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const parentPath = getImmediateParentPath(props.path);

    const duplicateMutation = useMutation({
        mutationFn: async (newName: string) => {
            if (parentPath === null) {
                throw new Error("The filesystem root cannot be duplicated");
            }

            const response = await props.agent.copyTo(
                {
                    agent: props.agent.id,
                    path: joinBrowserPath(parentPath, newName),
                },
                props.path,
            );

            // Copy returns a request id before the new name exists, so wait for publication.
            await waitForTransfers({
                queryClient,
                api,
                isSettled: (transfers) => {
                    const transfer = transfers.find(
                        (entry) =>
                            entry.request_id === response.copy_request_id,
                    );

                    if (transfer?.state === "errored") {
                        throw new Error(transfer.error ?? "Duplicate failed");
                    }

                    return transfer?.state === "completed";
                },
            });
        },
        onSuccess: async () => {
            props.onClose();
            await invalidateAgentData(queryClient, props.agent.id);
        },
    });

    return (
        <PathNameDialog
            title={`Duplicate ${props.entryType}`}
            description={`Choose a name for the copy of ${props.currentName}.`}
            closeAriaLabel={`Close duplicate ${props.entryType} dialog`}
            kind={props.entryType === "file" ? "File" : "Directory"}
            fieldLabel="New name"
            fieldAriaLabel={`Duplicate ${props.entryType}`}
            placeholder={props.currentName}
            fieldDescription="The copy is created beside the original."
            initialName={props.currentName}
            requireChange
            selectNameStem
            unavailableMessage={
                parentPath === null
                    ? "The filesystem root cannot be duplicated"
                    : null
            }
            submitLabel="Duplicate"
            busyLabel="Duplicating..."
            submitIcon={<Copy className="h-4 w-4" />}
            mutation={duplicateMutation}
            onClose={props.onClose}
        />
    );
}

/** Owns the duplicate workflow so the overflow menu can close before the dialog opens. */
function DuplicatePathAction(props: {
    agent: Agent;
    path: string;
    currentName: string;
    entryType: "file" | "directory";
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
        dialog: isOpen ? (
            <DuplicatePathDialog
                agent={props.agent}
                path={props.path}
                currentName={props.currentName}
                entryType={props.entryType}
                onClose={() => setIsOpen(false)}
            />
        ) : null,
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
                        : "Opened on the device"}
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
    duplicateDisabled: boolean;
    onDuplicate: () => void;
    showOpenNatively?: boolean;
    openNativelyPending?: boolean;
    onOpenNatively?: () => void;
    showSelect?: boolean;
    showDownload?: boolean;
    downloadUrl?: string;
    downloadName?: string;
    onDownloadDirectory?: () => void;
    /** Present for vault files, which also offer a decrypted download. */
    onDownloadDecrypted?: () => void;
    showUnarchive?: boolean;
    onUnarchive?: () => void;
    onCreateArchive?: () => void;
    onDelete?: () => void;
    deleteDisabled?: boolean;
    /**
     * Disables every write verb for a committed Git revision, since they would act on the
     * working file instead of the revision shown. Selecting and downloading read the commit.
     * Bookmarks only remember the path.
     */
    revision?: PathRevision;
}) {
    const readOnly = props.revision !== undefined;
    const transferDisabled = props.revision?.transferable === false;

    return (
        <>
            {props.showOpenNatively &&
            props.agent.supportsNativeOpen &&
            props.onOpenNatively ? (
                <ActionMenuButton
                    disabled={readOnly || props.openNativelyPending}
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
                disabled={readOnly || props.renameDisabled}
                onClick={() => {
                    props.close();
                    props.onRename();
                }}
            >
                <Pencil className="h-4 w-4 text-slate-400" />
                Rename
            </ActionMenuButton>
            <ActionMenuButton
                disabled={readOnly || props.duplicateDisabled}
                onClick={() => {
                    props.close();
                    props.onDuplicate();
                }}
            >
                <Copy className="h-4 w-4 text-slate-400" />
                Duplicate
            </ActionMenuButton>
            {props.showDownload ? (
                props.entryType === "directory" || transferDisabled ? (
                    <ActionMenuButton
                        disabled={transferDisabled}
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
            {props.showDownload && props.onDownloadDecrypted && !readOnly ? (
                <DecryptedDownloadMenuButton
                    onClick={() => {
                        props.close();
                        props.onDownloadDecrypted?.();
                    }}
                />
            ) : null}
            {props.showUnarchive && props.onUnarchive ? (
                <ActionMenuButton
                    disabled={readOnly}
                    onClick={() => {
                        props.close();
                        props.onUnarchive?.();
                    }}
                >
                    <ArchiveRestore className="h-4 w-4 text-slate-400" />
                    Unarchive
                </ActionMenuButton>
            ) : null}
            {props.onCreateArchive ? (
                <ActionMenuButton
                    disabled={readOnly}
                    onClick={() => {
                        props.close();
                        props.onCreateArchive?.();
                    }}
                >
                    <Archive className="h-4 w-4 text-slate-400" />
                    Create archive
                </ActionMenuButton>
            ) : null}
            {props.showSelect ? (
                <SelectPathMenuButton
                    agent={props.agent}
                    path={props.path}
                    fileName={props.currentName}
                    entryType={props.entryType}
                    close={props.close}
                    rev={props.revision?.commitId}
                    disabled={transferDisabled}
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
                        disabled={readOnly || props.deleteDisabled}
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
    onCreateArchive?: () => void;
    onDelete?: () => void;
    /** Keeps the menu's look for a Git revision with every write verb disabled. */
    revision?: PathRevision;
    /** Lets dense lists shrink the trigger, which otherwise sets their row height. */
    triggerClassName?: string;
}) {
    const canModify = getImmediateParentPath(props.path) !== null;
    const decrypted = useDecryptedDownload(props.agent, props.path);

    const isVaultFile = props.entryType === "file" && isVaultPath(props.path);

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
                <DuplicatePathAction
                    agent={props.agent}
                    path={props.path}
                    currentName={props.currentName}
                    entryType={props.entryType}
                >
                    {(duplicateAction) => (
                        <OpenNativelyAction
                            agent={props.agent}
                            path={props.path}
                        >
                            {(openNatively) => (
                                <>
                                    <ActionMenu
                                        label={props.label}
                                        icon={
                                            <MoreHorizontal className="h-4 w-4" />
                                        }
                                        variant="icon"
                                        className={props.triggerClassName}
                                    >
                                        {(close) => (
                                            <PathActionMenuItems
                                                agent={props.agent}
                                                path={props.path}
                                                currentName={props.currentName}
                                                entryType={props.entryType}
                                                close={close}
                                                renameDisabled={
                                                    renameAction.disabled
                                                }
                                                onRename={renameAction.open}
                                                duplicateDisabled={
                                                    duplicateAction.disabled
                                                }
                                                onDuplicate={
                                                    duplicateAction.open
                                                }
                                                showOpenNatively={
                                                    props.showOpenNatively
                                                }
                                                openNativelyPending={
                                                    openNatively.isPending
                                                }
                                                onOpenNatively={
                                                    openNatively.open
                                                }
                                                showSelect={props.showSelect}
                                                showDownload={
                                                    props.showDownload
                                                }
                                                downloadUrl={props.downloadUrl}
                                                downloadName={
                                                    props.downloadName
                                                }
                                                onDownloadDirectory={
                                                    props.onDownloadDirectory
                                                }
                                                onDownloadDecrypted={
                                                    isVaultFile
                                                        ? decrypted.start
                                                        : undefined
                                                }
                                                showUnarchive={
                                                    props.showUnarchive
                                                }
                                                onUnarchive={props.onUnarchive}
                                                onCreateArchive={
                                                    props.onCreateArchive
                                                }
                                                onDelete={props.onDelete}
                                                deleteDisabled={!canModify}
                                                revision={props.revision}
                                            />
                                        )}
                                    </ActionMenu>
                                    {renameAction.dialog}
                                    {duplicateAction.dialog}
                                    {openNatively.toast}
                                    {decrypted.toast}
                                </>
                            )}
                        </OpenNativelyAction>
                    )}
                </DuplicatePathAction>
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
    /** The commit a path is selected at while browsing history, which makes it copy-only. */
    rev?: string;
    /** Symlinks and submodules at a revision have no content a copy could write. */
    disabled?: boolean;
}) {
    const selectedFileKeys = useAtomValue(selectedFileKeysAtom);
    const toggleSelectedFile = useSetAtom(toggleSelectedFileAtom);
    const activateBottomDrawerTab = useSetAtom(activateBottomDrawerTabAtom);
    const rev = props.rev;

    const isSelected = selectedFileKeys.has(
        getSelectedFileKey({ agentId: props.agent.id, path: props.path, rev }),
    );

    const label = isSelected ? "Unselect" : "Select";

    return (
        <Checkbox
            checked={isSelected}
            label={label}
            title={false}
            disabled={props.disabled}
            className="w-full px-3 py-2"
            onCheckedChange={() => {
                props.close();
                toggleSelectedFile({
                    agentId: props.agent.id,
                    agentName: props.agent.name,
                    path: props.path,
                    fileName: props.fileName,
                    entryType: props.entryType,
                    rev,
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
    /**
     * Keeps the actions' look for a Git revision with file operations disabled, because
     * they would act on the working file rather than the revision. `downloadUrl` then names
     * the revision's download, which symlinks and submodules do not have.
     */
    revision?: PathRevision;
}) {
    const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = React.useState(false);
    const downloadDisabled = props.revision?.transferable === false;

    const downloadClassName = props.secondaryDownload
        ? "rounded-md px-3 text-slate-200 hover:bg-tint hover:text-slate-100"
        : "rounded-md px-3.5 font-semibold shadow-sm shadow-blue-950/30";

    const downloadLink = downloadDisabled ? (
        <Button
            type="button"
            aria-label="Download"
            variant={props.secondaryDownload ? "subtle" : "primary"}
            disabled
            className={downloadClassName}
        >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden @xl:inline">Download</span>
        </Button>
    ) : (
        <Button
            as="a"
            href={props.downloadUrl}
            download={props.downloadName}
            aria-label="Download"
            variant={props.secondaryDownload ? "subtle" : "primary"}
            className={downloadClassName}
        >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden @xl:inline">Download</span>
        </Button>
    );

    return (
        <>
            <div className="flex items-center gap-2">
                <Tooltip
                    content={
                        downloadDisabled
                            ? "Symlinks and submodules cannot be downloaded from a Git revision"
                            : (props.downloadTooltip ??
                              (props.revision === undefined
                                  ? "Download"
                                  : "Download as committed at this revision"))
                    }
                >
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
                    onDelete={() => setIsConfirmDeleteOpen(true)}
                    revision={props.revision}
                />
            </div>
            {isConfirmDeleteOpen ? (
                <DeletePathDialog
                    agent={props.agent}
                    path={props.path}
                    name={props.currentName}
                    entryType={props.entryType}
                    leaveToParent
                    onClose={() => setIsConfirmDeleteOpen(false)}
                />
            ) : null}
        </>
    );
}
