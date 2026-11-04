import React from "react";
import { ClipboardPaste, Upload } from "lucide-react";
import { type Agent } from "#ui/api-client";
import {
    type PendingUpload,
    UploadDialog,
} from "#ui/components/browser/upload-dialog";
import {
    countUploadFiles,
    createUploadItems,
    type UploadDraftItem,
    type UploadSource,
} from "#ui/upload-plan";
import { getErrorMessage } from "#ui/utils/error";
import { MAX_QUEUED_UPLOADS, type UploadSourceFile } from "#ui/upload-queue";
import { Toast } from "./toast";

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

/**
 * Adds a pick, drop or paste to the upload dialog, opening it for the destination when no
 * upload is pending yet. Nothing is queued until the user confirms the dialog.
 */
type AddToUpload = (
    destination: DirectoryDestination | null,
    source: UploadSource,
) => void;

/** The name pasted text is offered under; it is replaced by a free name when taken. */
const PASTED_TEXT_NAME = "pasted-text.txt";

/**
 * Lets controls outside the handler, such as the toolbar's Paste and Upload buttons, start
 * the same imports as dropping and pasting. The handler owns the destination and the dialog
 * an import opens, so it hands the control a direct call instead of the control signalling
 * it through the window.
 */
const FileImportContext = React.createContext<{
    importFromClipboard: () => void;
    addToUpload: AddToUpload;
} | null>(null);

/** Reads the handler's imports, failing loudly when a control is rendered outside of it. */
function useFileImportContext() {
    const context = React.useContext(FileImportContext);

    if (context === null) {
        throw new Error("Missing GlobalFileImportHandler");
    }

    return context;
}

/** Returns the function that imports from the clipboard into the directory on screen. */
export function useClipboardImport(): () => void {
    return useFileImportContext().importFromClipboard;
}

/**
 * Returns the upload entry point shared with drag and drop, so picked files go through the
 * same dialog instead of silently replacing existing items.
 */
export function useFileUpload(): AddToUpload {
    return useFileImportContext().addToUpload;
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

/** Turns pasted text into a file item whose name the user can still change. */
function pastedTextSource(text: string): UploadSource {
    return {
        origin: "pasted",
        hasGeneratedName: true,
        pastedText: text,
        files: [
            {
                file: new File([text], PASTED_TEXT_NAME, {
                    type: "text/plain",
                }),
                relativePath: PASTED_TEXT_NAME,
            },
        ],
    };
}

/**
 * Turns pasted files into upload sources. Clipboard images are named by the browser (such
 * as `image.png`) rather than the user, so they get free names instead of a replace prompt;
 * other pasted files keep the names they had where they were copied.
 */
function pastedFileSources(
    files: File[],
    hasGeneratedNames: boolean,
): UploadSource[] {
    const toSource = (selected: File[], hasGeneratedName: boolean) => ({
        origin: "pasted" as const,
        hasGeneratedName,
        files: selected.map((file) => ({ file, relativePath: file.name })),
    });

    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));

    return [toSource(images, true), toSource(others, hasGeneratedNames)].filter(
        (source) => source.files.length > 0,
    );
}

/**
 * Holds the upload waiting in the dialog and adds every pick, drop and paste to it. Items
 * are only queued once the user confirms the dialog.
 */
function useUploadCollector() {
    const [pendingUpload, setPendingUpload] =
        React.useState<PendingUpload | null>(null);

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

    const isDialogOpen = pendingUpload !== null;

    const addToUpload: AddToUpload = React.useCallback(
        (destination, source) => {
            let items: UploadDraftItem[];

            try {
                items = createUploadItems(source);
            } catch (error) {
                setImportState({
                    type: "error",
                    message: getErrorMessage(
                        error,
                        "The upload paths are invalid.",
                    ),
                });

                return;
            }

            if (items.length === 0) {
                return;
            }

            if (destination === null && !isDialogOpen) {
                showMissingDirectoryError();

                return;
            }

            const limitMessage = `Upload queues are limited to ${MAX_QUEUED_UPLOADS} files.`;

            // A selection that can never fit is refused whole, before any dialog opens.
            if (countUploadFiles(items) > MAX_QUEUED_UPLOADS) {
                setImportState({ type: "error", message: limitMessage });

                return;
            }

            const [onlyItem] = items;

            // A single paste is usually named right away, so its name field takes focus.
            const focusKey =
                source.origin === "pasted" &&
                items.length === 1 &&
                onlyItem !== undefined
                    ? onlyItem.key
                    : null;

            setPendingUpload((current) => {
                if (current === null) {
                    return destination === null
                        ? null
                        : {
                              agent: destination.agent,
                              destinationPath: destination.path,
                              items,
                              focusKey,
                              addError: null,
                          };
                }

                if (
                    countUploadFiles(current.items) + countUploadFiles(items) >
                    MAX_QUEUED_UPLOADS
                ) {
                    return { ...current, addError: limitMessage };
                }

                return {
                    ...current,
                    items: [...current.items, ...items],
                    focusKey: focusKey ?? current.focusKey,
                    addError: null,
                };
            });
        },
        [isDialogOpen, showMissingDirectoryError],
    );

    return {
        pendingUpload,
        addToUpload,
        removeFromUpload: (key: string) =>
            setPendingUpload((current) =>
                current === null
                    ? null
                    : {
                          ...current,
                          items: current.items.filter(
                              (item) => item.key !== key,
                          ),
                          addError: null,
                      },
            ),
        closeUpload: () => setPendingUpload(null),
        /** Closes the dialog once its items are queued and says how many files went. */
        finishUpload: (fileCount: number) => {
            setPendingUpload(null);
            setImportState({
                type: "success",
                message: `Queued ${fileCount} ${fileCount === 1 ? "file" : "files"}.`,
            });
        },
        importState,
        setImportState,
        showMissingDirectoryError,
    };
}

/** Reads the permission-gated clipboard API for imports requested by toolbar controls. */
function useClipboardImporter(props: {
    destination: DirectoryDestination | null;
    addToUpload: AddToUpload;
    setImportState: React.Dispatch<React.SetStateAction<ImportState>>;
}) {
    return React.useCallback(async () => {
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
                    // The Clipboard API gives blobs without names, so every name is made up.
                    for (const source of pastedFileSources(files, true)) {
                        props.addToUpload(props.destination, source);
                    }

                    return;
                }
            }

            const text = await navigator.clipboard.readText();

            if (text) {
                props.addToUpload(props.destination, pastedTextSource(text));

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
    }, [props.destination, props.addToUpload, props.setImportState]);
}

/**
 * Registers page-wide drag, drop, and paste handlers while tracking the drop overlay. They
 * stay active while the upload dialog is open, so more files can be dropped or pasted into it.
 */
function useGlobalImportEvents(props: {
    destination: DirectoryDestination | null;
    /** True while the upload dialog is open, which accepts drops without a destination. */
    isDialogOpen: boolean;
    addToUpload: AddToUpload;
    showMissingDirectoryError: () => void;
}) {
    const dragDepthRef = React.useRef(0);
    const [isDraggingFiles, setIsDraggingFiles] = React.useState(false);
    const canAccept = props.destination !== null || props.isDialogOpen;

    React.useEffect(() => {
        /** Keeps dragged files from being opened by the browser itself. */
        const handleDragEnter = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            dragDepthRef.current += 1;

            if (canAccept) {
                setIsDraggingFiles(true);
            }
        };

        /** Marks the page as a valid file-drop surface while a directory or the dialog is open. */
        const handleDragOver = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();

            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = canAccept ? "copy" : "none";
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

        /** Adds dropped files to the upload dialog or explains why the current route cannot. */
        const handleDrop = (event: DragEvent) => {
            if (!containsDraggedFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);

            if (!canAccept) {
                props.showMissingDirectoryError();

                return;
            }

            const dataTransfer = event.dataTransfer;

            if (!dataTransfer) {
                return;
            }

            void readDroppedFiles(dataTransfer)
                .then((manifest) =>
                    props.addToUpload(props.destination, {
                        origin: "dropped",
                        files: manifest.files,
                        directories: manifest.directories,
                    }),
                )
                .catch(() => props.showMissingDirectoryError());
        };

        /** Adds pasted files or text to the upload dialog, where they are named. */
        const handlePaste = (event: ClipboardEvent) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            const text = event.clipboardData?.getData("text/plain") ?? "";

            // Text pasted into a field stays there. Files cannot go into the dialog's name
            // fields, which take focus after every paste, so they still join the upload.
            if (
                isEditableTarget(event.target) &&
                !(props.isDialogOpen && files.length > 0)
            ) {
                return;
            }

            if (files.length === 0 && !text) {
                return;
            }

            event.preventDefault();

            const sources =
                files.length > 0
                    ? pastedFileSources(files, false)
                    : [pastedTextSource(text)];

            for (const source of sources) {
                props.addToUpload(props.destination, source);
            }
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        window.addEventListener("paste", handlePaste);

        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
            window.removeEventListener("paste", handlePaste);
        };
    }, [
        canAccept,
        props.isDialogOpen,
        props.destination,
        props.addToUpload,
        props.showMissingDirectoryError,
    ]);

    React.useEffect(() => {
        if (canAccept) {
            return;
        }

        setIsDraggingFiles(false);
        dragDepthRef.current = 0;
    }, [canAccept]);

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

/**
 * Owns page-wide drop and paste workflows so imports remain available regardless
 * of which element has focus and unsupported destinations fail visibly.
 */
export function GlobalFileImportHandler(props: {
    destination: DirectoryDestination | null;
    children: React.ReactNode;
}) {
    const collector = useUploadCollector();

    const importFromClipboard = useClipboardImporter({
        destination: props.destination,
        addToUpload: collector.addToUpload,
        setImportState: collector.setImportState,
    });

    const isDraggingFiles = useGlobalImportEvents({
        destination: props.destination,
        isDialogOpen: collector.pendingUpload !== null,
        addToUpload: collector.addToUpload,
        showMissingDirectoryError: collector.showMissingDirectoryError,
    });

    const addToUpload = collector.addToUpload;

    const fileImport = React.useMemo(
        () => ({
            importFromClipboard: () => void importFromClipboard(),
            addToUpload,
        }),
        [importFromClipboard, addToUpload],
    );

    return (
        <FileImportContext value={fileImport}>
            {props.children}
            {collector.pendingUpload !== null ? (
                <UploadDialog
                    upload={collector.pendingUpload}
                    isDraggingFiles={isDraggingFiles}
                    onAdd={(source) => addToUpload(null, source)}
                    onPasteFromClipboard={() => void importFromClipboard()}
                    onRemove={collector.removeFromUpload}
                    onClose={collector.closeUpload}
                    onQueued={collector.finishUpload}
                />
            ) : (
                <FileImportDropOverlay
                    destination={props.destination}
                    isDraggingFiles={isDraggingFiles}
                />
            )}
            <FileImportToast
                importState={collector.importState}
                setImportState={collector.setImportState}
            />
        </FileImportContext>
    );
}
