import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { ClipboardPaste, Upload } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";
import {
    enqueueUploadBatchAtom,
    type UploadSourceFile,
} from "#ui/upload-queue";
import { Dialog } from "./dialog";
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
function getErrorMessage(error: unknown, fallbackMessage: string) {
    return error instanceof Error ? error.message : fallbackMessage;
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
    const extensionByType: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "application/pdf": "pdf",
    };
    const extension = extensionByType[type] ?? "bin";
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

/** Validates text-import names so pasted content cannot escape the current directory. */
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

/** Enqueues source manifests and opens the queue view for the active destination. */
function useFileUploader(props: { destination: DirectoryDestination | null }) {
    const navigate = useNavigate();
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
            await navigate({
                to: destination.agent.getBrowserUrl(destination.path),
                search: { view: "upload_queue" },
            });
        },
        [enqueue, navigate, props.destination, showMissingDirectoryError],
    );

    return {
        importState,
        setImportState,
        showMissingDirectoryError,
        uploadFiles,
    };
}

/** Owns the filename prompt required before plain clipboard text becomes a file. */
function usePastedTextImport(props: {
    destination: DirectoryDestination | null;
    showMissingDirectoryError: () => void;
    uploadFiles: (files: UploadSourceFile[]) => Promise<void>;
}) {
    const [pastedText, setPastedText] = React.useState<string | null>(null);
    const [textFileName, setTextFileName] = React.useState("pasted-text.txt");
    const [textFileNameError, setTextFileNameError] = React.useState<
        string | null
    >(null);

    const openTextFileDialog = React.useCallback(
        (text: string) => {
            if (!props.destination) {
                props.showMissingDirectoryError();
                return;
            }

            setPastedText(text);
            setTextFileName("pasted-text.txt");
            setTextFileNameError(null);
        },
        [props.destination, props.showMissingDirectoryError],
    );

    const handleTextFileSubmit = React.useCallback(
        async (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const trimmedFileName = textFileName.trim();
            const validationError = getFileNameError(trimmedFileName);
            if (validationError) {
                setTextFileNameError(validationError);
                return;
            }
            if (pastedText === null) {
                return;
            }

            setPastedText(null);
            const file = new File([pastedText], trimmedFileName, {
                type: "text/plain",
            });
            await props.uploadFiles([{ file, relativePath: file.name }]);
        },
        [pastedText, props.uploadFiles, textFileName],
    );

    React.useEffect(() => {
        if (!props.destination) {
            setPastedText(null);
        }
    }, [props.destination]);

    return {
        pastedText,
        textFileName,
        textFileNameError,
        setPastedText,
        setTextFileName,
        setTextFileNameError,
        openTextFileDialog,
        handleTextFileSubmit,
    };
}

/** Reads the permission-gated clipboard API for imports requested by toolbar controls. */
function useClipboardImporter(props: {
    destination: DirectoryDestination | null;
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
                    await props.uploadFiles(
                        files.map((file) => ({
                            file,
                            relativePath: file.name,
                        })),
                    );
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
                void props.uploadFiles(
                    files.map((file) => ({ file, relativePath: file.name })),
                );
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

/** Prompts for a safe filename before pasted text is uploaded. */
function PastedTextFileDialog(props: {
    destination: DirectoryDestination | null;
    handleTextFileSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    pastedText: string | null;
    setPastedText: React.Dispatch<React.SetStateAction<string | null>>;
    setTextFileName: React.Dispatch<React.SetStateAction<string>>;
    setTextFileNameError: React.Dispatch<React.SetStateAction<string | null>>;
    textFileName: string;
    textFileNameError: string | null;
}) {
    const isOpen = props.pastedText !== null;

    return (
        <Dialog
            isOpen={isOpen}
            title="Save pasted text"
            description={
                props.destination
                    ? `Choose a filename for the text pasted into ${props.destination.path}.`
                    : undefined
            }
            closeAriaLabel="Close save pasted text dialog"
            errorMessage={props.textFileNameError}
            onClose={() => props.setPastedText(null)}
        >
            <form onSubmit={props.handleTextFileSubmit} className="mt-4">
                <label
                    htmlFor="pasted-text-file-name"
                    className="mb-2 block text-sm font-medium text-slate-300"
                >
                    Filename
                </label>
                <input
                    ref={focusAndSelectFileNameStem}
                    id="pasted-text-file-name"
                    type="text"
                    value={props.textFileName}
                    onChange={(event) => {
                        props.setTextFileName(event.target.value);
                        props.setTextFileNameError(null);
                    }}
                    autoFocus
                    className="w-full rounded border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
                />
                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={() => props.setPastedText(null)}
                        className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                    >
                        <ClipboardPaste className="h-4 w-4" />
                        Upload text
                    </button>
                </div>
            </form>
        </Dialog>
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
    const textImport = usePastedTextImport({
        destination: props.destination,
        showMissingDirectoryError: uploader.showMissingDirectoryError,
        uploadFiles: uploader.uploadFiles,
    });
    const importFromClipboard = useClipboardImporter({
        destination: props.destination,
        openTextFileDialog: textImport.openTextFileDialog,
        setImportState: uploader.setImportState,
        showMissingDirectoryError: uploader.showMissingDirectoryError,
        uploadFiles: uploader.uploadFiles,
    });
    const isDraggingFiles = useGlobalImportEvents({
        destination: props.destination,
        importFromClipboard,
        openTextFileDialog: textImport.openTextFileDialog,
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
            <PastedTextFileDialog
                destination={props.destination}
                handleTextFileSubmit={textImport.handleTextFileSubmit}
                pastedText={textImport.pastedText}
                setPastedText={textImport.setPastedText}
                setTextFileName={textImport.setTextFileName}
                setTextFileNameError={textImport.setTextFileNameError}
                textFileName={textImport.textFileName}
                textFileNameError={textImport.textFileNameError}
            />
        </>
    );
}
