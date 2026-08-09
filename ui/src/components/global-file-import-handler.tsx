import React from "react";
import { useRouter } from "@tanstack/react-router";
import { ClipboardPaste, Upload } from "lucide-react";
import type { Agent } from "../api-client";
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
    | { type: "uploading"; fileCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

/** Requests a clipboard import from controls outside the global handler. */
export function requestClipboardPaste() {
    window.dispatchEvent(new Event(REQUEST_CLIPBOARD_PASTE_EVENT));
}

/** Joins one browser-safe filename to the directory currently being viewed. */
function joinBrowserPath(directoryPath: string, fileName: string) {
    return directoryPath.endsWith("/")
        ? `${directoryPath}${fileName}`
        : `${directoryPath}/${fileName}`;
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

/**
 * Owns page-wide drop and paste workflows so imports remain available regardless
 * of which element has focus and unsupported destinations fail visibly.
 */
export function GlobalFileImportHandler(props: {
    destination: DirectoryDestination | null;
}) {
    const router = useRouter();
    const dragDepthRef = React.useRef(0);
    const [isDraggingFiles, setIsDraggingFiles] = React.useState(false);
    const [importState, setImportState] = React.useState<ImportState>({
        type: "idle",
    });
    const [pastedText, setPastedText] = React.useState<string | null>(null);
    const [textFileName, setTextFileName] = React.useState("pasted-text.txt");
    const [textFileNameError, setTextFileNameError] = React.useState<
        string | null
    >(null);

    const showMissingDirectoryError = React.useCallback(() => {
        setImportState({
            type: "error",
            message:
                "Open a directory before dropping or pasting files or text.",
        });
    }, []);

    const uploadFiles = React.useCallback(
        async (files: File[]) => {
            if (files.length === 0) {
                return;
            }
            if (!props.destination) {
                showMissingDirectoryError();
                return;
            }

            const destination = props.destination;
            setImportState({ type: "uploading", fileCount: files.length });
            const results = await Promise.allSettled(
                files.map((file) =>
                    destination.agent.upload(
                        joinBrowserPath(destination.path, file.name),
                        file,
                    ),
                ),
            );
            const successCount = results.filter(
                (result) => result.status === "fulfilled",
            ).length;
            const firstFailure = results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successCount > 0) {
                await router.invalidate();
            }

            if (firstFailure) {
                const failureMessage = getErrorMessage(
                    firstFailure.reason,
                    "Upload failed",
                );
                setImportState({
                    type: "error",
                    message:
                        successCount > 0
                            ? `Uploaded ${successCount} of ${files.length} files. ${failureMessage}`
                            : failureMessage,
                });
                return;
            }

            setImportState({
                type: "success",
                message:
                    files.length === 1
                        ? `Uploaded ${files[0]?.name ?? "file"}`
                        : `Uploaded ${files.length} files`,
            });
        },
        [props.destination, router, showMissingDirectoryError],
    );

    const openTextFileDialog = React.useCallback(
        (text: string) => {
            if (!props.destination) {
                showMissingDirectoryError();
                return;
            }

            setPastedText(text);
            setTextFileName("pasted-text.txt");
            setTextFileNameError(null);
        },
        [props.destination, showMissingDirectoryError],
    );

    const importFromClipboard = React.useCallback(async () => {
        if (!props.destination) {
            showMissingDirectoryError();
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
                    await uploadFiles(files);
                    return;
                }
            }

            const text = await navigator.clipboard.readText();
            if (text) {
                openTextFileDialog(text);
                return;
            }

            setImportState({
                type: "error",
                message: "The clipboard does not contain files or text.",
            });
        } catch (error) {
            setImportState({
                type: "error",
                message: getErrorMessage(
                    error,
                    "Clipboard access was not available.",
                ),
            });
        }
    }, [
        openTextFileDialog,
        props.destination,
        showMissingDirectoryError,
        uploadFiles,
    ]);

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
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!props.destination) {
                showMissingDirectoryError();
                return;
            }
            void uploadFiles(files);
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
                showMissingDirectoryError();
                return;
            }
            if (files.length > 0) {
                void uploadFiles(files);
                return;
            }

            openTextFileDialog(text);
        };

        /** Lets toolbar controls request the permission-gated Clipboard API workflow. */
        const handleClipboardRequest = () => {
            void importFromClipboard();
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
        importFromClipboard,
        openTextFileDialog,
        props.destination,
        showMissingDirectoryError,
        uploadFiles,
    ]);

    React.useEffect(() => {
        if (props.destination) {
            return;
        }

        setIsDraggingFiles(false);
        setPastedText(null);
        dragDepthRef.current = 0;
    }, [props.destination]);

    /** Uploads text as a File so it uses the same streaming endpoint as other imports. */
    const handleTextFileSubmit = async (
        event: React.FormEvent<HTMLFormElement>,
    ) => {
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
        await uploadFiles([
            new File([pastedText], trimmedFileName, { type: "text/plain" }),
        ]);
    };

    const statusMessage =
        importState.type === "uploading"
            ? `Uploading ${importState.fileCount} ${importState.fileCount === 1 ? "file" : "files"}...`
            : importState.type === "idle"
              ? null
              : importState.message;

    return (
        <>
            {isDraggingFiles && props.destination ? (
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
            ) : null}

            {statusMessage ? (
                <Toast
                    tone={
                        importState.type === "error"
                            ? "error"
                            : importState.type === "uploading"
                              ? "info"
                              : "success"
                    }
                    icon={
                        importState.type === "uploading" ? (
                            <Upload className="h-4 w-4 animate-pulse" />
                        ) : (
                            <ClipboardPaste className="h-4 w-4" />
                        )
                    }
                    dismissAriaLabel="Dismiss file import message"
                    onDismiss={
                        importState.type === "uploading"
                            ? undefined
                            : () => setImportState({ type: "idle" })
                    }
                >
                    {statusMessage}
                </Toast>
            ) : null}

            <Dialog
                isOpen={pastedText !== null}
                title="Save pasted text"
                description={
                    props.destination
                        ? `Choose a filename for the text pasted into ${props.destination.path}.`
                        : undefined
                }
                closeAriaLabel="Close save pasted text dialog"
                errorMessage={textFileNameError}
                onClose={() => setPastedText(null)}
            >
                <form onSubmit={handleTextFileSubmit} className="mt-4">
                    <label
                        htmlFor="pasted-text-file-name"
                        className="mb-2 block text-sm font-medium text-slate-300"
                    >
                        Filename
                    </label>
                    <input
                        id="pasted-text-file-name"
                        type="text"
                        value={textFileName}
                        onChange={(event) => {
                            setTextFileName(event.target.value);
                            setTextFileNameError(null);
                        }}
                        autoFocus
                        className="w-full rounded border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
                    />
                    <div className="mt-6 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={() => setPastedText(null)}
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
        </>
    );
}
