import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { ClipboardPaste, Upload } from "lucide-react";
import { ApiError, type Agent } from "#ui/api-client";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { browserListingQueryOptions } from "#ui/queries";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";
import {
    enqueueUploadBatchAtom,
    type UploadSourceFile,
} from "#ui/upload-queue";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { DialogActions } from "./dialog-actions";
import { InputControl } from "./input-control";
import { Toast } from "./toast";

export const REQUEST_CLIPBOARD_PASTE_EVENT = "redoor:request-clipboard-paste";

/** Identifies the agent directory that can accept imported files. */
type DirectoryDestination = {
    agent: Agent;
    path: string;
};

/** Represents user-visible progress for global file imports. */
type ImportState =
    | { type: "idle" }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/** Requests a clipboard import from controls outside the global handler. */
export function requestClipboardPaste() {
    window.dispatchEvent(new Event(REQUEST_CLIPBOARD_PASTE_EVENT));
}

/** Produces a useful message without exposing unknown thrown values to the UI. */
function getErrorMessage(cause: unknown, fallbackMessage: string) {
    return cause instanceof Error ? cause.message : fallbackMessage;
}

/** Avoids replacing the browser's normal paste behavior while the user is editing. */
function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
    );
}

/** Detects file drags before the browser exposes their File objects on drop. */
function containsDraggedFiles(dataTransfer: DataTransfer | null) {
    return Array.from(dataTransfer?.types ?? []).includes("Files");
}

/** Generates a recognizable filename when clipboard blobs do not provide one. */
function getClipboardFileName(type: string, index: number) {
    const extensionByType = new Map([
        ["image/png", "png"],
        ["image/jpeg", "jpg"],
        ["image/gif", "gif"],
        ["image/webp", "webp"],
        ["application/pdf", "pdf"],
    ]);
    const extension = extensionByType.get(type) ?? "bin";
    const suffix = index === 0 ? "" : `-${index + 1}`;
    return `pasted-file${suffix}.${extension}`;
}

/** Converts Clipboard API blobs into uploadable files while preserving MIME types. */
async function readClipboardFiles(items: ClipboardItem[]) {
    const files: File[] = [];

    for (const item of items) {
        const binaryType = item.types.find((type) => !type.startsWith("text/"));
        if (!binaryType) {
            continue;
        }

        const blob = await item.getType(binaryType);
        files.push(
            new File([blob], getClipboardFileName(binaryType, files.length), {
                type: binaryType,
            }),
        );
    }

    return files;
}

/** Validates pasted-content names so imports cannot escape the current directory. */
function getFileNameError(fileName: string) {
    if (!fileName.trim()) {
        return "Filename is required";
    }
    if (fileName === "." || fileName === "..") {
        return "Filename must identify a file";
    }
    if (fileName.includes("/") || fileName.includes("\\")) {
        return "Filename cannot contain path separators";
    }

    return null;
}

/** Reads every chunk because Chromium limits one directory-reader result batch. */
async function readDirectoryEntries(entry: FileSystemDirectoryEntry) {
    const reader = entry.createReader();
    const entries: FileSystemEntry[] = [];
    while (true) {
        const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
        );
        if (chunk.length === 0) {
            return entries;
        }
        entries.push(...chunk);
    }
}

/** Narrows the legacy entry API before invoking its file-only operation. */
function isDroppedFileEntry(
    entry: FileSystemEntry,
): entry is FileSystemFileEntry {
    return entry.isFile;
}

/** Narrows the legacy entry API before enumerating directory children. */
function isDroppedDirectoryEntry(
    entry: FileSystemEntry,
): entry is FileSystemDirectoryEntry {
    return entry.isDirectory;
}

type DroppedManifest = {
    files: UploadSourceFile[];
    directories: string[];
};

/** Converts legacy drag entries into the same source manifest used by every importer. */
async function traverseDroppedEntry(
    entry: FileSystemEntry,
    parentPath: string,
    manifest: DroppedManifest,
) {
    const relativePath = parentPath
        ? `${parentPath}/${entry.name}`
        : entry.name;
    if (isDroppedFileEntry(entry)) {
        const file = await new Promise<File>((resolve, reject) =>
            entry.file(resolve, reject),
        );
        manifest.files.push({ file, relativePath });
        return;
    }
    if (!isDroppedDirectoryEntry(entry)) {
        return;
    }

    manifest.directories.push(relativePath);
    const children = await readDirectoryEntries(entry);
    for (const child of children) {
        await traverseDroppedEntry(child, relativePath, manifest);
    }
}

/** Extracts directories when available and falls back to ordinary dropped files. */
async function readDroppedFiles(dataTransfer: DataTransfer) {
    const entries = Array.from(dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter((entry): entry is FileSystemEntry => entry !== null);
    if (entries.length === 0) {
        return {
            files: Array.from(dataTransfer.files, (file) => ({
                file,
                relativePath: file.name,
            })),
            directories: [],
        };
    }

    const manifest: DroppedManifest = { files: [], directories: [] };
    for (const entry of entries) {
        await traverseDroppedEntry(entry, "", manifest);
    }
    return manifest;
}

/** Enqueues source manifests for the active destination. */
function useFileUploader(props: { destination: DirectoryDestination | null }) {
    const enqueue = useSetAtom(enqueueUploadBatchAtom);
    const [importState, setImportState] = React.useState<ImportState>({
        type: "idle",
    });

    const showMissingDirectoryError = React.useCallback(() => {
        setImportState({
            type: "error",
            message:
                "Open a directory before dropping or pasting files or text.",
        });
    }, []);

    const uploadFiles = React.useCallback(
        async (files: UploadSourceFile[], directories: string[] = []) => {
            if (files.length === 0 && directories.length === 0) {
                return;
            }
            if (!props.destination) {
                showMissingDirectoryError();
                return;
            }

            const destination = props.destination;
            const result = enqueue({
                agentId: destination.agent.id,
                destinationPath: destination.path,
                files,
                directories,
            });
            if (!result.ok) {
                setImportState({
                    type: "error",
                    message: result.message,
                });
                return;
            }
            setImportState({
                type: "success",
                message: `Queued ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}.`,
            });
        },
        [enqueue, props.destination, showMissingDirectoryError],
    );

    return {
        importState,
        setImportState,
        showMissingDirectoryError,
        uploadFiles,
    };
}

type PastedContent = {
    blob: Blob;
    kind: "image" | "text";
    suggestedName: string;
};

/** Owns filename confirmation so clipboard content is not uploaded implicitly. */
function usePastedContentImport(props: {
    destination: DirectoryDestination | null;
    setImportState: React.Dispatch<React.SetStateAction<ImportState>>;
    showMissingDirectoryError: () => void;
}) {
    const queryClient = useQueryClient();
    const [pastedContents, setPastedContents] = React.useState<PastedContent[]>(
        [],
    );
    const [fileName, setFileName] = React.useState("");
    const [fileNameError, setFileNameError] = React.useState<string | null>(
        null,
    );
    const pastedContent = pastedContents[0] ?? null;
    const uploadMutation = useMutation({
        mutationFn: async (request: {
            content: PastedContent;
            destination: DirectoryDestination;
            fileName: string;
        }) => {
            const file = new File([request.content.blob], request.fileName, {
                type: request.content.blob.type,
            });
            await request.destination.agent.upload(
                joinBrowserPath(request.destination.path, request.fileName),
                file,
                { on_existing: "error" },
            );
            return request.destination;
        },
        onSuccess: (destination) => {
            void queryClient.invalidateQueries(
                browserListingQueryOptions(destination.agent, destination.path),
            );
        },
    });

    const openPastedContentDialog = React.useCallback(
        (contents: PastedContent[]) => {
            const firstContent = contents[0];
            if (!firstContent) {
                return;
            }
            if (!props.destination) {
                props.showMissingDirectoryError();
                return;
            }

            setPastedContents(contents);
            setFileName(firstContent.suggestedName);
            setFileNameError(null);
        },
        [props.destination, props.showMissingDirectoryError],
    );

    const closePastedContentDialog = React.useCallback(() => {
        setPastedContents([]);
        setFileNameError(null);
    }, []);

    const handleFileSubmit = React.useCallback(
        async (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const trimmedFileName = fileName.trim();
            const validationError = getFileNameError(trimmedFileName);
            if (validationError) {
                setFileNameError(validationError);
                return;
            }
            if (!pastedContent) {
                return;
            }
            if (!props.destination) {
                props.showMissingDirectoryError();
                return;
            }

            try {
                await uploadMutation.mutateAsync({
                    content: pastedContent,
                    destination: props.destination,
                    fileName: trimmedFileName,
                });
                const remainingContents = pastedContents.slice(1);
                setPastedContents(remainingContents);
                setFileName(remainingContents[0]?.suggestedName ?? "");
                setFileNameError(null);
                props.setImportState({
                    type: "success",
                    message: `Uploaded ${trimmedFileName}.`,
                });
            } catch (cause) {
                setFileNameError(
                    cause instanceof ApiError && cause.status === 409
                        ? `A file named ${trimmedFileName} already exists. Choose a different filename.`
                        : getErrorMessage(
                              cause,
                              "The pasted content could not be uploaded.",
                          ),
                );
            }
        },
        [
            fileName,
            pastedContent,
            pastedContents,
            props.destination,
            props.setImportState,
            props.showMissingDirectoryError,
            uploadMutation,
        ],
    );

    React.useEffect(() => {
        if (!props.destination) {
            setPastedContents([]);
        }
    }, [props.destination]);

    return {
        closePastedContentDialog,
        fileName,
        fileNameError,
        handleFileSubmit,
        isUploading: uploadMutation.isPending,
        openImageFileDialog: (images: File[]) =>
            openPastedContentDialog(
                images.map((image) => ({
                    blob: image,
                    kind: "image",
                    suggestedName: image.name,
                })),
            ),
        openTextFileDialog: (text: string) =>
            openPastedContentDialog([
                {
                    blob: new Blob([text], { type: "text/plain" }),
                    kind: "text",
                    suggestedName: "pasted-text.txt",
                },
            ]),
        pastedContent,
        setFileName,
        setFileNameError,
    };
}

/** Reads the permission-gated clipboard API for imports requested by toolbar controls. */
function useClipboardImporter(props: {
    destination: DirectoryDestination | null;
    openImageFileDialog: (images: File[]) => void;
    openTextFileDialog: (text: string) => void;
    setImportState: React.Dispatch<React.SetStateAction<ImportState>>;
    showMissingDirectoryError: () => void;
    uploadFiles: (files: UploadSourceFile[]) => Promise<void>;
}) {
    return React.useCallback(async () => {
        if (!props.destination) {
            props.showMissingDirectoryError();
            return;
        }

        try {
            if (!navigator.clipboard) {
                throw new Error(
                    "Clipboard access is not available in this browser.",
                );
            }
            if (navigator.clipboard.read) {
                const items = await navigator.clipboard.read();
                const files = await readClipboardFiles(items);
                if (files.length > 0) {
                    const images = files.filter((file) =>
                        file.type.startsWith("image/"),
                    );
                    const otherFiles = files.filter(
                        (file) => !file.type.startsWith("image/"),
                    );
                    if (otherFiles.length > 0) {
                        await props.uploadFiles(
                            otherFiles.map((file) => ({
                                file,
                                relativePath: file.name,
                            })),
                        );
                    }
                    if (images.length > 0) {
                        props.openImageFileDialog(images);
                    }
                    return;
                }
            }

            const text = await navigator.clipboard.readText();
            if (text) {
                props.openTextFileDialog(text);
                return;
            }

            props.setImportState({
                type: "error",
                message: "The clipboard does not contain files or text.",
            });
        } catch (error) {
            props.setImportState({
                type: "error",
                message: getErrorMessage(
                    error,
                    "Clipboard access was not available.",
                ),
            });
        }
    }, [
        props.destination,
        props.openImageFileDialog,
        props.openTextFileDialog,
        props.setImportState,
        props.showMissingDirectoryError,
        props.uploadFiles,
    ]);
}

/** Registers page-wide drag, drop, and paste handlers while tracking the drop overlay. */
function useGlobalImportEvents(props: {
    destination: DirectoryDestination | null;
    importFromClipboard: () => Promise<void>;
    openImageFileDialog: (images: File[]) => void;
    openTextFileDialog: (text: string) => void;
    showMissingDirectoryError: () => void;
    uploadFiles: (
        files: UploadSourceFile[],
        directories?: string[],
    ) => Promise<void>;
}) {
    const dragDepthRef = React.useRef(0);
    const [isDraggingFiles, setIsDraggingFiles] = React.useState(false);

    React.useEffect(() => {
        /** Keeps dragged files from being opened by the browser itself. */
        const handleDragEnter = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            dragDepthRef.current += 1;
            if (props.destination) {
                setIsDraggingFiles(true);
            }
        };

        /** Marks the page as a valid file-drop surface while a directory is open. */
        const handleDragOver = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = props.destination
                    ? "copy"
                    : "none";
            }
        };

        /** Removes the overlay only after the dragged item leaves the whole window. */
        const handleDragLeave = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
                setIsDraggingFiles(false);
            }
        };

        /** Uploads dropped files immediately or explains why the current route cannot. */
        const handleDrop = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);
            if (!props.destination) {
                props.showMissingDirectoryError();
                return;
            }
            const dataTransfer = event.dataTransfer;
            if (!dataTransfer) {
                return;
            }
            void readDroppedFiles(dataTransfer)
                .then((manifest) =>
                    props.uploadFiles(manifest.files, manifest.directories),
                )
                .catch(() => props.showMissingDirectoryError());
        };

        /** Imports pasted files, or asks for a name when plain text is pasted. */
        const handlePaste = (event: ClipboardEvent) => {
            if (isEditableTarget(event.target)) {
                return;
            }

            const files = Array.from(event.clipboardData?.files ?? []);
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (files.length === 0 && !text) {
                return;
            }

            event.preventDefault();
            if (!props.destination) {
                props.showMissingDirectoryError();
                return;
            }
            if (files.length > 0) {
                const images = files.filter((file) =>
                    file.type.startsWith("image/"),
                );
                const otherFiles = files.filter(
                    (file) => !file.type.startsWith("image/"),
                );
                if (otherFiles.length > 0) {
                    void props.uploadFiles(
                        otherFiles.map((file) => ({
                            file,
                            relativePath: file.name,
                        })),
                    );
                }
                if (images.length > 0) {
                    props.openImageFileDialog(images);
                }
                return;
            }

            props.openTextFileDialog(text);
        };

        /** Lets toolbar controls request the permission-gated Clipboard API workflow. */
        const handleClipboardRequest = () => {
            void props.importFromClipboard();
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        window.addEventListener("paste", handlePaste);
        window.addEventListener(
            REQUEST_CLIPBOARD_PASTE_EVENT,
            handleClipboardRequest,
        );
        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
            window.removeEventListener("paste", handlePaste);
            window.removeEventListener(
                REQUEST_CLIPBOARD_PASTE_EVENT,
                handleClipboardRequest,
            );
        };
    }, [
        props.destination,
        props.importFromClipboard,
        props.openImageFileDialog,
        props.openTextFileDialog,
        props.showMissingDirectoryError,
        props.uploadFiles,
    ]);

    React.useEffect(() => {
        if (props.destination) {
            return;
        }

        setIsDraggingFiles(false);
        dragDepthRef.current = 0;
    }, [props.destination]);

    return isDraggingFiles;
}

/** Prompts for a safe filename before pasted clipboard content is uploaded. */
function PastedContentFileDialog(props: {
    closePastedContentDialog: () => void;
    destination: DirectoryDestination | null;
    fileName: string;
    fileNameError: string | null;
    handleFileSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    isUploading: boolean;
    pastedContent: PastedContent | null;
    setFileName: React.Dispatch<React.SetStateAction<string>>;
    setFileNameError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
    const kind = props.pastedContent?.kind ?? "text";

    return (
        <Dialog
            isOpen={props.pastedContent !== null}
            isBusy={props.isUploading}
            title={`Save pasted ${kind}`}
            description={
                props.destination
                    ? `Choose a filename for the ${kind} pasted into ${props.destination.path}.`
                    : undefined
            }
            closeAriaLabel={`Close save pasted ${kind} dialog`}
            errorMessage={props.fileNameError}
            onClose={props.closePastedContentDialog}
        >
            <form onSubmit={props.handleFileSubmit} className="mt-4">
                <label
                    htmlFor="pasted-content-file-name"
                    className="mb-2 block text-sm font-medium text-slate-300"
                >
                    Filename
                </label>
                <InputControl
                    ref={focusAndSelectFileNameStem}
                    id="pasted-content-file-name"
                    type="text"
                    value={props.fileName}
                    disabled={props.isUploading}
                    onChange={(event) => {
                        props.setFileName(event.target.value);
                        props.setFileNameError(null);
                    }}
                    autoFocus
                    className="w-full rounded shadow-sm focus:ring-blue-500/30"
                />
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.closePastedContentDialog}
                        disabled={props.isUploading}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={props.isUploading}>
                        <ClipboardPaste className="h-4 w-4" />
                        Upload {kind}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/** Displays the active target while files are being dragged across the page. */
function FileImportDropOverlay(props: {
    destination: DirectoryDestination | null;
    isDraggingFiles: boolean;
}) {
    if (!props.isDraggingFiles || !props.destination) {
        return null;
    }

    return (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-950/75 p-8 backdrop-blur-sm">
            <div className="flex max-w-3xl flex-col items-center gap-5 rounded-3xl border-4 border-dashed border-blue-300 bg-slate-950/90 px-12 py-16 text-center shadow-2xl shadow-blue-950">
                <Upload className="h-20 w-20 text-blue-300" />
                <p className="text-3xl font-bold text-white">
                    Drop files here to upload them to
                </p>
                <p className="max-w-full break-all font-mono text-2xl text-blue-200">
                    {props.destination.path}
                </p>
            </div>
        </div>
    );
}

/** Reports import progress and results through the shared transient feedback surface. */
function FileImportToast(props: {
    importState: ImportState;
    setImportState: React.Dispatch<React.SetStateAction<ImportState>>;
}) {
    const statusMessage =
        props.importState.type === "idle" ? null : props.importState.message;

    if (!statusMessage) {
        return null;
    }

    return (
        <Toast
            tone={props.importState.type === "error" ? "error" : "success"}
            icon={<ClipboardPaste className="h-4 w-4" />}
            dismissAriaLabel="Dismiss file import message"
            onDismiss={() => props.setImportState({ type: "idle" })}
        >
            {statusMessage}
        </Toast>
    );
}

/**
 * Owns page-wide drop and paste workflows so imports remain available regardless
 * of which element has focus and unsupported destinations fail visibly.
 */
export function GlobalFileImportHandler(props: {
    destination: DirectoryDestination | null;
}) {
    const uploader = useFileUploader({ destination: props.destination });
    const pastedContentImport = usePastedContentImport({
        destination: props.destination,
        setImportState: uploader.setImportState,
        showMissingDirectoryError: uploader.showMissingDirectoryError,
    });
    const importFromClipboard = useClipboardImporter({
        destination: props.destination,
        openImageFileDialog: pastedContentImport.openImageFileDialog,
        openTextFileDialog: pastedContentImport.openTextFileDialog,
        setImportState: uploader.setImportState,
        showMissingDirectoryError: uploader.showMissingDirectoryError,
        uploadFiles: uploader.uploadFiles,
    });
    const isDraggingFiles = useGlobalImportEvents({
        destination: props.destination,
        importFromClipboard,
        openImageFileDialog: pastedContentImport.openImageFileDialog,
        openTextFileDialog: pastedContentImport.openTextFileDialog,
        showMissingDirectoryError: uploader.showMissingDirectoryError,
        uploadFiles: uploader.uploadFiles,
    });

    return (
        <>
            <FileImportDropOverlay
                destination={props.destination}
                isDraggingFiles={isDraggingFiles}
            />
            <FileImportToast
                importState={uploader.importState}
                setImportState={uploader.setImportState}
            />
            <PastedContentFileDialog
                closePastedContentDialog={
                    pastedContentImport.closePastedContentDialog
                }
                destination={props.destination}
                fileName={pastedContentImport.fileName}
                fileNameError={pastedContentImport.fileNameError}
                handleFileSubmit={pastedContentImport.handleFileSubmit}
                isUploading={pastedContentImport.isUploading}
                pastedContent={pastedContentImport.pastedContent}
                setFileName={pastedContentImport.setFileName}
                setFileNameError={pastedContentImport.setFileNameError}
            />
        </>
    );
}
