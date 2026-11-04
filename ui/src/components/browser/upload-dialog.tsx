import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
    ClipboardPaste,
    FileText,
    Folder,
    FolderPlus,
    LockKeyhole,
    LockKeyholeOpen,
    Upload,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { FileInput, type FileInputHandle } from "#ui/components/file-input";
import { Tooltip } from "#ui/components/tooltip";
import {
    ConflictBulkSelect,
    DestinationRow,
} from "#ui/components/browser/destination-conflict";
import { joinBrowserPath } from "#ui/components/browser/utils";
import {
    countUploadFiles,
    type PlannedUploadRow,
    planUploadRows,
    resolveUpload,
    type UploadChoices,
    type UploadDraftItem,
    type UploadItemChoice,
    type UploadSource,
} from "#ui/upload-plan";
import { describeDestinationEntries } from "#ui/destination-plan";
import { isLsDirectoryResponse } from "#ui/ls-response";
import {
    browserListingQueryOptions,
    vaultStatusQueryOptions,
} from "#ui/queries";
import { useUploads } from "#ui/use-uploads";
import { getErrorMessage } from "#ui/utils/error";
import { formatSize } from "#ui/utils/path";
import { VaultUnlockCancelled } from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/**
 * An upload waiting in the dialog. The destination is fixed when the dialog opens, so files
 * dropped or pasted while it is open join this upload even if the page behind it changes.
 */
export type PendingUpload = {
    agent: Agent;
    destinationPath: string;
    items: UploadDraftItem[];
    /** The row whose name field takes focus, so a paste can be named straight away. */
    focusKey: string | null;
    /** Why the last pick, drop or paste was not added, shown until the next one. */
    addError: string | null;
};

/** Sums the bytes an item uploads, so rows and the footer can show what is about to move. */
function getItemSize(item: UploadDraftItem): number {
    return item.files.reduce((total, file) => total + file.file.size, 0);
}

/** True for a single image file, which gets a thumbnail so pastes can be told apart. */
function isImageItem(item: UploadDraftItem): boolean {
    return (
        item.entryType === "file" &&
        item.files[0]?.file.type.startsWith("image/") === true
    );
}

/** Says what a row holds in a few words, since the name alone may be made up. */
function describeItem(item: UploadDraftItem): string {
    const size = formatSize(getItemSize(item));

    if (item.pastedText !== null) {
        const lineCount = item.pastedText.split("\n").length;

        return `Pasted text · ${lineCount} ${lineCount === 1 ? "line" : "lines"} · ${size}`;
    }

    if (item.entryType === "directory") {
        const fileCount = item.files.length;

        return `Directory · ${fileCount} ${fileCount === 1 ? "file" : "files"} · ${size}`;
    }

    if (item.origin === "pasted") {
        return `Pasted ${isImageItem(item) ? "image" : "file"} · ${size}`;
    }

    return `${item.origin === "dropped" ? "Dropped" : "Picked"} file · ${size}`;
}

/**
 * Shows a picture's thumbnail. The object URL is a browser resource that must be released
 * when the row goes away, which is why it is created in an effect.
 */
function ImageThumbnail(props: { file: File }) {
    const [url, setUrl] = React.useState<string | null>(null);

    React.useEffect(() => {
        const objectUrl = URL.createObjectURL(props.file);
        setUrl(objectUrl);

        return () => URL.revokeObjectURL(objectUrl);
    }, [props.file]);

    return url === null ? null : (
        <img src={url} alt="" className="h-full w-full object-cover" />
    );
}

/** A small preview that tells rows apart when their names are similar or generated. */
function ItemPreview(props: { item: UploadDraftItem }) {
    const firstFile = props.item.files[0];

    if (props.item.pastedText !== null) {
        return (
            <span className="line-clamp-3 w-full px-1 font-mono text-[8px] leading-tight break-all whitespace-pre-wrap">
                {props.item.pastedText.slice(0, 120)}
            </span>
        );
    }

    if (isImageItem(props.item) && firstFile !== undefined) {
        return <ImageThumbnail file={firstFile.file} />;
    }

    return props.item.entryType === "directory" ? (
        <Folder className="h-5 w-5 text-blue-400" />
    ) : (
        <FileText className="h-5 w-5" />
    );
}

/**
 * One item of the upload on the shared destination row, with the upload's own extras: a
 * preview, the name an encrypted item is saved under, and the Encrypt box.
 */
function UploadItemRow(props: {
    row: PlannedUploadRow;
    canEncrypt: boolean;
    hasFocus: boolean;
    disabled: boolean;
    onChange: (choice: UploadItemChoice) => void;
    onRemove: () => void;
}) {
    const item = props.row.item;

    return (
        <DestinationRow
            row={props.row}
            preview={<ItemPreview item={item} />}
            meta={describeItem(item)}
            notes={
                props.row.encrypt ? (
                    <p className="text-xs break-all text-slate-400 sm:pl-[3.25rem]">
                        Saved as{" "}
                        <span className="font-mono">{props.row.finalName}</span>
                        {item.entryType === "directory"
                            ? ", with every file inside encrypted on its own"
                            : null}
                    </p>
                ) : null
            }
            controls={
                <Tooltip
                    content={
                        props.canEncrypt
                            ? "Encrypt with your vault before it leaves this browser"
                            : "Unlock the vault to encrypt"
                    }
                >
                    <span className="inline-flex">
                        <Checkbox
                            role="checkbox"
                            label={`Encrypt ${item.name}`}
                            title={false}
                            checked={props.row.encrypt}
                            disabled={props.disabled || !props.canEncrypt}
                            onCheckedChange={(encrypt) =>
                                props.onChange({ encrypt })
                            }
                            className="min-h-9 px-2"
                        >
                            Encrypt
                        </Checkbox>
                    </span>
                </Tooltip>
            }
            remove={{
                label: `Remove ${item.name} from upload`,
                tooltip: "Remove from upload",
                onRemove: props.onRemove,
            }}
            hasFocus={props.hasFocus}
            disabled={props.disabled}
            onChange={props.onChange}
        />
    );
}

/**
 * Square, label-less buttons on phones, where the toolbar would otherwise wrap onto several
 * lines. The label stays for screen readers and the tooltip explains the icon. A modal
 * dialog is sized against the viewport, so this is a viewport breakpoint.
 */
const iconOnlyOnPhones =
    "rounded-md max-sm:h-10 max-sm:w-10 max-sm:justify-center max-sm:px-0";

/**
 * Shows whether encryption is available and offers to unlock or set up the vault, so the
 * disabled Encrypt boxes always come with the way to enable them.
 */
function VaultStatus(props: { isUnlocked: boolean }) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const vaultStatus = useQuery(vaultStatusQueryOptions(api));
    const hasNoVault = vaultStatus.isSuccess && vaultStatus.data.vault === null;

    if (props.isUnlocked) {
        return (
            <Tooltip content="Encryption is available">
                <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-slate-700 px-3 text-xs text-slate-300">
                    <LockKeyholeOpen className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="max-sm:sr-only">Vault unlocked</span>
                </span>
            </Tooltip>
        );
    }

    return (
        <Button
            type="button"
            variant="warning"
            size="sm"
            tooltip="Encrypting uploads needs the vault key"
            onClick={() => {
                // A cancelled unlock leaves the boxes disabled, which already says enough.
                void vault
                    .requestUnlock("Encrypting uploads needs the vault key")
                    .catch(() => undefined);
            }}
            className={iconOnlyOnPhones}
        >
            <LockKeyhole className="h-4 w-4" />
            <span className="max-sm:sr-only">
                {hasNoVault ? "Set up vault" : "Unlock vault"}
            </span>
        </Button>
    );
}

/**
 * Queues the upload once the user confirms: asks for the vault when anything is encrypted,
 * clears directories that are being replaced, and hands the batch to the upload queue.
 */
function useUploadSubmission(props: {
    upload: PendingUpload;
    rows: readonly PlannedUploadRow[];
    onQueued: (fileCount: number) => void;
}) {
    const { vault } = rootRouteApi.useRouteContext();
    const uploads = useUploads();

    return useMutation({
        mutationFn: async (): Promise<number> => {
            const upload = props.upload;

            if (props.rows.some((row) => row.encrypt)) {
                // The vault may have locked while the dialog was open; the boxes the user
                // checked stay checked, so ask for it instead of uploading plaintext.
                await vault.requestUnlock(
                    "Uploading encrypted files needs the vault key",
                );
            }

            const resolved = resolveUpload(props.rows);

            // Uploads write one file at a time, so a directory cannot atomically replace what
            // is there. The existing entry is cleared first, into the trash when the agent has
            // one, so a failed upload does not lose it for good.
            await Promise.all(
                resolved.replacedDirectoryNames.map((name) =>
                    upload.agent.deleteFile(
                        joinBrowserPath(upload.destinationPath, name),
                        { trash: upload.agent.supportsMoveToTrash },
                    ),
                ),
            );

            const result = uploads.enqueue({
                agentId: upload.agent.id,
                destinationPath: upload.destinationPath,
                files: resolved.files,
                directories: resolved.directories,
            });

            if (!result.ok) {
                throw new Error(result.message);
            }

            return result.fileCount;
        },
        onSuccess: (fileCount) => props.onQueued(fileCount),
    });
}

/**
 * The controls above the rows: buttons that add more items, which phones need because they
 * cannot drop files, and the vault state with the box that encrypts every item at once.
 */
function UploadToolbar(props: {
    disabled: boolean;
    isUnlocked: boolean;
    hasItems: boolean;
    allEncrypted: boolean;
    onPickFiles: () => void;
    onPickDirectory: () => void;
    onPasteFromClipboard: () => void;
    onEncryptAll: (encrypt: boolean) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Button
                type="button"
                variant="secondary"
                size="sm"
                tooltip="Choose more files to add to this upload"
                disabled={props.disabled}
                onClick={props.onPickFiles}
                className={iconOnlyOnPhones}
            >
                <Upload className="h-4 w-4" />
                <span className="max-sm:sr-only">Files</span>
            </Button>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                tooltip="Choose a directory to add to this upload"
                disabled={props.disabled}
                onClick={props.onPickDirectory}
                className={iconOnlyOnPhones}
            >
                <FolderPlus className="h-4 w-4" />
                <span className="max-sm:sr-only">Directory</span>
            </Button>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                tooltip="Add the clipboard's files, image or text to this upload"
                disabled={props.disabled}
                onClick={props.onPasteFromClipboard}
                className={iconOnlyOnPhones}
            >
                <ClipboardPaste className="h-4 w-4" />
                <span className="max-sm:sr-only">Paste</span>
            </Button>
            <span className="flex-1" />
            <VaultStatus isUnlocked={props.isUnlocked} />
            <Tooltip
                content={
                    props.isUnlocked
                        ? "Encrypt every item, or none"
                        : "Unlock the vault to encrypt"
                }
            >
                <span className="inline-flex">
                    <Checkbox
                        role="checkbox"
                        label="Encrypt all items"
                        title={false}
                        checked={props.allEncrypted}
                        disabled={
                            props.disabled ||
                            !props.isUnlocked ||
                            !props.hasItems
                        }
                        onCheckedChange={props.onEncryptAll}
                        className="min-h-9 px-2"
                    >
                        All
                    </Checkbox>
                </span>
            </Tooltip>
        </div>
    );
}

/**
 * Lists the rows, or says how to add some once every row was removed. While files are
 * dragged over the open dialog it shows where they will go, since the page's own drop
 * overlay is covered by the dialog.
 */
function UploadItemList(props: {
    rows: readonly PlannedUploadRow[];
    focusKey: string | null;
    canEncrypt: boolean;
    disabled: boolean;
    isDraggingFiles: boolean;
    onChange: (key: string, change: UploadItemChoice) => void;
    onRemove: (key: string) => void;
}) {
    return (
        <div className="relative mt-3">
            {props.rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
                    Nothing to upload. Add, drop or paste files.
                </p>
            ) : (
                <ul
                    aria-label="Items to upload"
                    className="flex max-h-[min(30rem,55dvh)] flex-col gap-2 overflow-y-auto overscroll-y-contain"
                >
                    {props.rows.map((row) => (
                        <UploadItemRow
                            key={row.item.key}
                            row={row}
                            canEncrypt={props.canEncrypt}
                            hasFocus={row.item.key === props.focusKey}
                            disabled={props.disabled}
                            onChange={(change) =>
                                props.onChange(row.item.key, change)
                            }
                            onRemove={() => props.onRemove(row.item.key)}
                        />
                    ))}
                </ul>
            )}
            {props.isDraggingFiles ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-blue-300 bg-blue-950/85 p-4 text-center">
                    <Upload className="h-8 w-8 text-blue-300" />
                    <p className="font-semibold text-white">
                        Drop to add to this upload
                    </p>
                </div>
            ) : null}
        </div>
    );
}

/** Totals what the upload will send, so a large or partly encrypted upload is not a surprise. */
function UploadSummary(props: { rows: readonly PlannedUploadRow[] }) {
    const items = props.rows.map((row) => row.item);
    const fileCount = countUploadFiles(items);

    const totalSize = items.reduce(
        (total, item) => total + getItemSize(item),
        0,
    );

    const encryptedCount = props.rows.filter((row) => row.encrypt).length;

    return (
        <span className="self-center text-center text-xs text-slate-500 sm:mr-auto sm:text-left">
            {fileCount} {fileCount === 1 ? "file" : "files"} ·{" "}
            {formatSize(totalSize)}
            {encryptedCount > 0 ? ` · ${encryptedCount} encrypted` : null}
        </span>
    );
}

/**
 * The one place every upload passes through: picked, dropped and pasted files are listed
 * here so the user can name each item, choose what happens to an existing item of the same
 * name, and encrypt items with the vault before anything is queued. Drops and pastes while
 * it is open add rows instead of starting another upload.
 *
 * The caller mounts it only while an upload is pending, so each upload starts from the safe
 * defaults: suggested free names, Rename for conflicts and no encryption.
 */
export function UploadDialog(props: {
    upload: PendingUpload;
    isDraggingFiles: boolean;
    onAdd: (source: UploadSource) => void;
    onPasteFromClipboard: () => void;
    onRemove: (key: string) => void;
    onClose: () => void;
    onQueued: (fileCount: number) => void;
}) {
    const { vault } = rootRouteApi.useRouteContext();
    const fileInputRef = React.useRef<FileInputHandle>(null);
    const directoryInputRef = React.useRef<FileInputHandle>(null);
    const [choices, setChoices] = React.useState<UploadChoices>({});

    const vaultState = React.useSyncExternalStore(
        vault.subscribe,
        vault.getSnapshot,
    );

    const isUnlocked = vaultState.status === "unlocked";

    // Read fresh, because the cached listing may predate a recent change and every conflict
    // is judged against it. Live refreshes keep it current while the dialog stays open.
    const listing = useQuery({
        ...browserListingQueryOptions(
            props.upload.agent,
            props.upload.destinationPath,
        ),
        staleTime: 0,
    });

    const destination =
        listing.data !== undefined && isLsDirectoryResponse(listing.data)
            ? describeDestinationEntries(listing.data.files)
            : null;

    const rows = planUploadRows({
        items: props.upload.items,
        destination,
        choices,
    });

    const updateChoice = (key: string, change: UploadItemChoice) =>
        setChoices((current) => ({
            ...current,
            [key]: { ...current[key], ...change },
        }));

    const uploadMutation = useUploadSubmission({
        upload: props.upload,
        rows,
        onQueued: props.onQueued,
    });

    const isBusy = uploadMutation.isPending;
    const itemCount = rows.length;

    const canUpload =
        itemCount > 0 &&
        destination !== null &&
        // The first fresh read must finish, but later background refreshes, which other
        // changes on the device trigger at any time, must not flicker the button off.
        listing.isFetchedAfterMount &&
        rows.every((row) => row.error === null) &&
        !isBusy;

    const errorMessage =
        (uploadMutation.error === null ||
        uploadMutation.error instanceof VaultUnlockCancelled
            ? null
            : getErrorMessage(
                  uploadMutation.error,
                  "The upload could not be started.",
              )) ??
        props.upload.addError ??
        (listing.isError
            ? getErrorMessage(
                  listing.error,
                  "The upload destination could not be checked.",
              )
            : null);

    /** Adds picked files, keeping directory structure when the browser reports it. */
    const addPickedFiles = (files: File[]) =>
        props.onAdd({
            origin: "picked",
            files: files.map((file) => ({
                file,
                relativePath: file.webkitRelativePath || file.name,
            })),
        });

    return (
        <Dialog
            isOpen={true}
            size="wide"
            isBusy={isBusy}
            title="Upload files"
            description={
                <>
                    To{" "}
                    <span className="font-mono break-all text-slate-300">
                        {props.upload.destinationPath}
                    </span>{" "}
                    on{" "}
                    <span className="font-semibold text-slate-300">
                        {props.upload.agent.name}
                    </span>
                </>
            }
            closeAriaLabel="Close upload dialog"
            errorMessage={errorMessage}
            onClose={props.onClose}
        >
            <form
                className="mt-4"
                onSubmit={(event) => {
                    event.preventDefault();

                    if (canUpload) {
                        uploadMutation.mutate();
                    }
                }}
            >
                <UploadToolbar
                    disabled={isBusy}
                    isUnlocked={isUnlocked}
                    hasItems={itemCount > 0}
                    allEncrypted={
                        itemCount > 0 && rows.every((row) => row.encrypt)
                    }
                    onPickFiles={() => fileInputRef.current?.open()}
                    onPickDirectory={() => directoryInputRef.current?.open()}
                    onPasteFromClipboard={props.onPasteFromClipboard}
                    onEncryptAll={(encrypt) => {
                        for (const item of props.upload.items) {
                            updateChoice(item.key, { encrypt });
                        }
                    }}
                />
                <ConflictBulkSelect
                    rows={rows}
                    disabled={isBusy}
                    onChange={(resolutions) =>
                        setChoices((current) => {
                            const next = { ...current };

                            for (const [key, resolution] of Object.entries(
                                resolutions,
                            )) {
                                next[key] = { ...next[key], resolution };
                            }

                            return next;
                        })
                    }
                />
                <UploadItemList
                    rows={rows}
                    focusKey={props.upload.focusKey}
                    canEncrypt={isUnlocked}
                    disabled={isBusy}
                    isDraggingFiles={props.isDraggingFiles}
                    onChange={updateChoice}
                    onRemove={props.onRemove}
                />
                <p className="mt-3 hidden text-center text-xs text-slate-500 sm:block">
                    Drop or paste more files to add them.
                </p>
                <DialogActions stackOnMobile>
                    <UploadSummary rows={rows} />
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={isBusy}
                        className="rounded-md text-slate-300"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        disabled={!canUpload}
                        isLoading={isBusy}
                        className="rounded-md font-semibold"
                    >
                        <Upload className="h-4 w-4" />
                        {itemCount === 0
                            ? "Upload"
                            : `Upload ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
                    </Button>
                </DialogActions>
                {/* Last in the form, so opening the dialog focuses a name field instead. */}
                <FileInput
                    ref={fileInputRef}
                    label="Add files to upload"
                    onSelect={addPickedFiles}
                />
                <FileInput
                    ref={directoryInputRef}
                    label="Add directory to upload"
                    directory
                    onSelect={addPickedFiles}
                />
            </form>
        </Dialog>
    );
}
