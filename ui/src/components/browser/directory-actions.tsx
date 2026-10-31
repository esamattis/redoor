import React from "react";
import { isVaultPath, VAULT_SUFFIX } from "#ui/vault/vault-path";
import { newWriteKeys } from "#ui/vault/vault-keys";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
    ClipboardPaste,
    Eye,
    EyeOff,
    FilePlus,
    FolderPlus,
    LockKeyhole,
    Plus,
    RefreshCw,
    Upload,
} from "lucide-react";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { FileInput, type FileInputHandle } from "#ui/components/file-input";
import { PathNameDialog } from "#ui/components/browser/path-name-dialog";
import { browserRoute } from "#ui/browser-route";
import {
    useClipboardImport,
    useFileUpload,
} from "#ui/components/global-file-import-handler";
import { Tooltip } from "#ui/components/tooltip";
import { ToggleButton } from "#ui/components/toggle-button";
import type { Agent } from "#ui/api-client";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { getDirectoryArchiveName } from "#ui/utils/archive";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { isPlainKey } from "#ui/utils/keyboard";
import { getBaseName } from "#ui/utils/path";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import { useRefreshBrowserPath } from "#ui/components/browser/refresh";

const rootRouteApi = getRouteApi("__root__");

/**
 * Sends file and directory selections through the same conflict check and bounded global
 * queue as dropped files, which also report their errors.
 */
function UploadFilesAction(props: {
    agent: Agent;
    directoryPath: string;
    disabled: boolean;
}) {
    const uploadFilesTo = useFileUpload();
    const { vault } = rootRouteApi.useRouteContext();
    const fileInputRef = React.useRef<FileInputHandle>(null);
    const directoryInputRef = React.useRef<FileInputHandle>(null);
    const encryptedInputRef = React.useRef<FileInputHandle>(null);

    /**
     * Encrypts each picked file into `name.redoorvault`. The vault is unlocked after the pick
     * and before the conflict check, so the check sees the encrypted names.
     */
    const handleEncryptedSelection = (selectedFiles: File[]) => {
        void vault
            .requestUnlock("Uploading encrypted files needs the vault key")
            .then((unlocked) =>
                uploadFilesTo(
                    { agent: props.agent, path: props.directoryPath },
                    selectedFiles.map((file) => ({
                        file,
                        relativePath: `${file.name}${VAULT_SUFFIX}`,
                    })),
                    { encryptWith: unlocked },
                ),
            )
            .catch(() => undefined);
    };

    /** Queues the picked files, keeping directory structure when the browser reports it. */
    const handleFileSelection = (selectedFiles: File[]) => {
        void uploadFilesTo(
            { agent: props.agent, path: props.directoryPath },
            selectedFiles.map((file) => ({
                file,
                relativePath: file.webkitRelativePath || file.name,
            })),
        );
    };

    return (
        <div className="flex items-center gap-1">
            <FileInput
                ref={fileInputRef}
                label="Choose files to upload"
                onSelect={handleFileSelection}
            />
            <FileInput
                ref={directoryInputRef}
                label="Choose directory to upload"
                directory
                onSelect={handleFileSelection}
            />
            <FileInput
                ref={encryptedInputRef}
                label="Choose files to encrypt and upload"
                onSelect={handleEncryptedSelection}
            />
            <ActionMenu
                label="Upload"
                icon={<Upload className="h-4 w-4" />}
                hideLabelOnMobile
                disabled={props.disabled}
            >
                {(close) => (
                    <>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                fileInputRef.current?.open();
                            }}
                        >
                            <Upload className="h-4 w-4 text-slate-400" />
                            Upload files
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                directoryInputRef.current?.open();
                            }}
                        >
                            <FolderPlus className="h-4 w-4 text-slate-400" />
                            Upload directory
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => {
                                close();
                                encryptedInputRef.current?.open();
                            }}
                        >
                            <LockKeyhole className="h-4 w-4 text-slate-400" />
                            Upload encrypted files
                        </ActionMenuButton>
                        <p className="border-t border-slate-800 px-3 pt-3 text-xs leading-relaxed text-slate-400">
                            You can also upload files by dragging and dropping
                            them into this directory.
                        </p>
                    </>
                )}
            </ActionMenu>
        </div>
    );
}

/**
 * Names a new directory in the current one and opens it. The agent creates every missing
 * parent, so the name may span several levels, such as `logs/2026`.
 */
function CreateDirectoryDialog(props: {
    agent: Agent;
    directoryPath: string;
    onClose: () => void;
}) {
    const navigate = useNavigate();

    const createDirectoryMutation = useMutation({
        mutationFn: (name: string) =>
            props.agent.createDirectory(
                joinBrowserPath(props.directoryPath, name),
            ),
        onSuccess: async (_, name) => {
            await navigate(
                browserRoute(
                    props.agent,
                    joinBrowserPath(props.directoryPath, name),
                ),
            );
            props.onClose();
        },
    });

    return (
        <PathNameDialog
            title="Create directory"
            description="Create a new directory in the current location."
            closeAriaLabel="Close create directory dialog"
            kind="Directory"
            fieldLabel="Directory name"
            placeholder="logs"
            fieldDescription="The name of the new directory. Separate levels with a slash to create several at once."
            initialName=""
            allowNested
            preview={{
                label: "Directory path",
                pathFor: (name) => joinBrowserPath(props.directoryPath, name),
            }}
            submitLabel="Create directory"
            busyLabel="Creating..."
            submitIcon={<FolderPlus className="h-4 w-4" />}
            mutation={createDirectoryMutation}
            onClose={props.onClose}
        />
    );
}

/** Creates an empty text file and opens it immediately in the editor. */
function CreateFileDialog(props: {
    agent: Agent;
    directoryPath: string;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const { vault } = rootRouteApi.useRouteContext();

    const createFileMutation = useMutation({
        mutationFn: async (name: string) => {
            const path = joinBrowserPath(props.directoryPath, name);

            // A `.redoorvault` file is encrypted from the start, so it never exists as an
            // empty plaintext file on the device.
            if (isVaultPath(name)) {
                const unlocked = await vault.requestUnlock(
                    "Creating an encrypted file needs the vault key",
                );

                return props.agent.vaultUpload(path, {
                    content: new Blob([]),
                    keys: await newWriteKeys(unlocked),
                });
            }

            return props.agent.upload(
                path,
                new globalThis.File([""], name, {
                    type: "text/plain",
                }),
            );
        },
        onSuccess: async (_, name) => {
            await navigate(
                browserRoute(
                    props.agent,
                    joinBrowserPath(props.directoryPath, name),
                ),
            );
            props.onClose();
        },
    });

    return (
        <PathNameDialog
            title="Create file"
            description="Create an empty text file and open it for editing."
            closeAriaLabel="Close create file dialog"
            kind="File"
            fieldLabel="File name"
            placeholder="notes.txt"
            fieldDescription="The name of the new empty text file. Names ending in .redoorvault are encrypted with your vault."
            initialName=""
            preview={{
                label: "File path",
                pathFor: (name) => joinBrowserPath(props.directoryPath, name),
            }}
            submitLabel="Create file"
            busyLabel="Creating..."
            submitIcon={<FilePlus className="h-4 w-4" />}
            mutation={createFileMutation}
            onClose={props.onClose}
        />
    );
}

/** Groups file and directory creation without mixing their modal workflows. */
function DirectoryNewAction(props: {
    agent: Agent;
    directoryPath: string;
    disabled: boolean;
}) {
    const [dialogType, setDialogType] = React.useState<
        "file" | "directory" | null
    >(null);

    // A dialog is already open, or about to be, so the keys must not stack a second one.
    useShortcut(
        {
            name: "new-file",
            phase: "bubble",
            priority: shortcutPriority.view,
            skipTypingTargets: true,
            match: (event) => isPlainKey(event, "n", { allowShift: true }),
            run: () => setDialogType("file"),
        },
        dialogType === null && !props.disabled,
    );

    useShortcut(
        {
            name: "new-directory",
            phase: "bubble",
            priority: shortcutPriority.view,
            skipTypingTargets: true,
            match: (event) => isPlainKey(event, "d", { allowShift: true }),
            run: () => setDialogType("directory"),
        },
        dialogType === null && !props.disabled,
    );

    return (
        <>
            <ActionMenu
                label="New"
                icon={<Plus className="h-4 w-4" />}
                hideLabelOnMobile
                disabled={props.disabled}
            >
                {(close) => (
                    <>
                        <Tooltip
                            content="Create a new file (n)"
                            className="w-full"
                        >
                            <ActionMenuButton
                                onClick={() => {
                                    close();
                                    setDialogType("file");
                                }}
                            >
                                <FilePlus className="h-4 w-4 text-slate-400" />
                                New file
                            </ActionMenuButton>
                        </Tooltip>
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
            {dialogType === "file" ? (
                <CreateFileDialog
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    onClose={() => setDialogType(null)}
                />
            ) : null}
            {dialogType === "directory" ? (
                <CreateDirectoryDialog
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    onClose={() => setDialogType(null)}
                />
            ) : null}
        </>
    );
}

/** Keeps controls that affect only the file-list representation inside that view. */
export function DirectoryFilesActions(props: {
    agent: Agent;
    directoryPath: string;
    showHiddenFiles: boolean;
    onToggleHiddenFiles: () => void;
    /**
     * The commit id of a committed Git revision this toolbar shows: everything that writes
     * into the directory (paste, new, upload, file operations) is disabled, and Download
     * archives the directory as committed.
     */
    revision?: string;
}) {
    const revision = props.revision;
    const readOnly = revision !== undefined;
    const refreshBrowser = useRefreshBrowserPath(props.agent.id);
    const importFromClipboard = useClipboardImport();
    const [isReloading, setIsReloading] = React.useState(false);

    const directoryName = getBaseName(props.directoryPath);

    /** Shares the same ls reload as returning to the tab. */
    const reloadListing = async () => {
        if (isReloading) {
            return;
        }

        setIsReloading(true);

        try {
            await refreshBrowser();
        } finally {
            setIsReloading(false);
        }
    };

    return (
        <div
            aria-label="Files view actions"
            className="flex flex-wrap items-center justify-between gap-1 border-b border-slate-800 bg-slate-900/35 p-1.5 @xl:gap-2 @xl:p-2"
        >
            <ToggleButton
                onClick={props.onToggleHiddenFiles}
                pressed={props.showHiddenFiles}
                label={
                    props.showHiddenFiles
                        ? "Hide hidden files"
                        : "Show hidden files"
                }
                tooltip={
                    props.showHiddenFiles
                        ? "Hide hidden files"
                        : "Show hidden files"
                }
                variant="subtle"
                size="sm"
            >
                {props.showHiddenFiles ? (
                    <EyeOff className="h-4 w-4" />
                ) : (
                    <Eye className="h-4 w-4" />
                )}
                <span className="hidden @xl:inline">
                    {props.showHiddenFiles ? "Hide hidden" : "Show hidden"}
                </span>
            </ToggleButton>
            <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain">
                <Button
                    tooltip="Pasted text or images are created as new files in this directory."
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={importFromClipboard}
                    disabled={readOnly}
                    aria-label="Paste files or text"
                    className="rounded-md"
                >
                    <ClipboardPaste className="h-4 w-4 text-slate-400" />
                    <span className="hidden @xl:inline">Paste</span>
                </Button>
                <DirectoryNewAction
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    disabled={readOnly}
                />
                <UploadFilesAction
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    disabled={readOnly}
                />
                <PersistentPathActions
                    agent={props.agent}
                    path={props.directoryPath}
                    currentName={directoryName}
                    entryType="directory"
                    downloadUrl={
                        revision === undefined
                            ? props.agent.getRawUrl(props.directoryPath, {
                                  download: true,
                              })
                            : props.agent.getGitDownloadUrl(
                                  props.directoryPath,
                                  revision,
                              )
                    }
                    downloadName={getDirectoryArchiveName(directoryName)}
                    downloadTooltip={
                        revision === undefined
                            ? "Downloads this directory as a .tar.gz archive."
                            : "Downloads this directory as committed at this revision, as a .tar.gz archive."
                    }
                    secondaryDownload
                    revision={
                        revision === undefined
                            ? undefined
                            : { commitId: revision, transferable: true }
                    }
                    afterDownload={
                        <Button
                            tooltip="Reload directory listing from the device"
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label="Reload directory listing"
                            onClick={() => {
                                void reloadListing();
                            }}
                            disabled={isReloading}
                            isLoading={isReloading}
                            className="rounded-md"
                        >
                            <RefreshCw className="h-4 w-4 text-slate-400" />
                            <span className="hidden @xl:inline">
                                {isReloading ? "Reloading..." : "Reload"}
                            </span>
                        </Button>
                    }
                />
            </div>
        </div>
    );
}
