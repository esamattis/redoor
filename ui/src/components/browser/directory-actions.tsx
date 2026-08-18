import React from "react";
import { useSetAtom } from "jotai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
    ClipboardPaste,
    Eye,
    EyeOff,
    FilePlus,
    FolderPlus,
    Plus,
    RefreshCw,
    Upload,
} from "lucide-react";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { TextField } from "#ui/components/text-field";
import { requestClipboardPaste } from "#ui/components/global-file-import-handler";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { ToggleButton } from "#ui/components/toggle-button";
import type { Agent } from "#ui/api-client";
import { getErrorMessage, joinBrowserPath } from "#ui/components/browser/utils";
import { enqueueUploadBatchAtom } from "#ui/upload-queue";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import { refreshBrowserPath } from "#ui/components/browser/refresh";

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
            <ActionMenu
                label="Upload"
                icon={<Upload className="h-4 w-4" />}
                hideLabelOnMobile
            >
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
            <form noValidate onSubmit={handleSubmit} className="mt-4">
                <TextField
                    label="Directory name"
                    value={directoryName}
                    placeholder="logs"
                    description="The name of the new directory."
                    required
                    autoFocus
                    disabled={isCreating}
                    onChange={(value) => {
                        setDirectoryName(value);
                        setValidationError(null);
                        createDirectoryMutation.reset();
                    }}
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

                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={closeDialog}
                        disabled={isCreating}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={isCreating}>
                        <FolderPlus className="h-4 w-4" />
                        {isCreating ? "Creating..." : "Create directory"}
                    </Button>
                </DialogActions>
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
            <form noValidate onSubmit={handleSubmit} className="mt-4">
                <TextField
                    label="File name"
                    value={fileName}
                    placeholder="notes.txt"
                    description="The name of the new empty text file."
                    required
                    autoFocus
                    disabled={isCreating}
                    onChange={(value) => {
                        setFileName(value);
                        setValidationError(null);
                        createFileMutation.reset();
                    }}
                />

                {createFilePath ? (
                    <div className="mt-4">
                        <p className="mb-2 text-sm text-slate-400">File path</p>
                        <p className="break-all rounded bg-[#0b0d12] px-3 py-2 font-mono text-sm text-slate-300">
                            {createFilePath}
                        </p>
                    </div>
                ) : null}

                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={closeDialog}
                        disabled={isCreating}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={isCreating}>
                        <FilePlus className="h-4 w-4" />
                        {isCreating ? "Creating..." : "Create file"}
                    </Button>
                </DialogActions>
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
            <ActionMenu
                label="New"
                icon={<Plus className="h-4 w-4" />}
                hideLabelOnMobile
            >
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
    const router = useRouter();
    const queryClient = useQueryClient();
    const [isReloading, setIsReloading] = React.useState(false);
    const directoryName =
        props.directoryPath.split("/").filter(Boolean).pop() ?? "/";
    const archiveName = `${directoryName === "/" ? "archive" : directoryName}.tar.gz`;

    /** Shares the same ls reload as returning to the tab. */
    const reloadListing = async () => {
        if (isReloading) {
            return;
        }
        setIsReloading(true);
        try {
            await refreshBrowserPath({
                router,
                queryClient,
            });
        } finally {
            setIsReloading(false);
        }
    };

    return (
        <div
            aria-label="Files view actions"
            className="flex flex-wrap items-center justify-between gap-1 border-b border-slate-800 bg-slate-900/35 p-1.5 sm:gap-2 sm:p-2"
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
                <span className="hidden sm:inline">
                    {props.showHiddenFiles ? "Hide hidden" : "Show hidden"}
                </span>
            </ToggleButton>
            <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain">
                <Tooltip content="Pasted text or images are created as new files in this directory.">
                    <Button
                        type="button"
                        variant="subtle"
                        onClick={requestClipboardPaste}
                        aria-label="Paste files or text"
                        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                    >
                        <ClipboardPaste className="h-4 w-4 text-slate-400" />
                        <span className="hidden sm:inline">Paste</span>
                    </Button>
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
                    afterDownload={
                        <Tooltip content="Reload directory listing from the agent">
                            <Button
                                type="button"
                                variant="subtle"
                                aria-label="Reload directory listing"
                                onClick={() => {
                                    void reloadListing();
                                }}
                                disabled={isReloading}
                                isLoading={isReloading}
                                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                            >
                                <RefreshCw className="h-4 w-4 text-slate-400" />
                                <span className="hidden sm:inline">
                                    {isReloading ? "Reloading..." : "Reload"}
                                </span>
                            </Button>
                        </Tooltip>
                    }
                />
            </div>
        </div>
    );
}
