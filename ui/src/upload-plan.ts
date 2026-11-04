import {
    type DestinationChoice,
    type DestinationNames,
    type PlannedDestination,
    planDestinationNames,
} from "#ui/destination-plan";
import {
    normalizeRelativePath,
    type UploadBatchFile,
    type UploadSourceFile,
} from "#ui/upload-queue";
import { VAULT_SUFFIX } from "#ui/vault/vault-path";

/** How an item reached the upload dialog, so its row can say what it is. */
export type UploadItemOrigin = "picked" | "dropped" | "pasted";

/**
 * One item the upload creates directly in the destination: a file, or a directory with
 * everything below it. The dialog shows one row per item, because only these names can
 * collide with what is already there, and a dropped tree stays one row instead of hundreds.
 */
export type UploadDraftItem = {
    /** Stays the same while the item is in the dialog, so its choices follow it. */
    key: string;
    /** The top-level name the source gave the item. */
    name: string;
    entryType: "file" | "directory";
    origin: UploadItemOrigin;
    /**
     * True when the name was made up rather than chosen by the user, such as for pasted
     * text or a clipboard screenshot. Such a name is replaced by a free one instead of
     * asking whether to replace the existing item it happens to match.
     */
    hasGeneratedName: boolean;
    /** Every file of the item, with paths relative to the destination starting at `name`. */
    files: UploadSourceFile[];
    /** Directories to create even when empty, with paths starting at `name`. */
    directories: string[];
    /** The pasted text, so the row can show which clipboard content it is. */
    pastedText: string | null;
};

/** Everything one pick, drop or paste adds to the upload. */
export type UploadSource = {
    files: UploadSourceFile[];
    directories?: string[];
    origin: UploadItemOrigin;
    hasGeneratedName?: boolean;
    pastedText?: string;
};

/** What the user changed on one row; anything left out follows the suggestion. */
export type UploadItemChoice = DestinationChoice & {
    encrypt?: boolean;
};

/** The user's changes keyed by item key, kept apart from the items added by drops and pastes. */
export type UploadChoices = Readonly<Record<string, UploadItemChoice>>;

/** One row as it will be uploaded, with whether it is encrypted. */
export type PlannedUploadRow = PlannedDestination<UploadDraftItem> & {
    encrypt: boolean;
};

/** The queue batch the dialog sends, plus what must be cleared before it may run. */
export type ResolvedUpload = {
    files: UploadBatchFile[];
    directories: string[];
    /** Existing directories an uploaded directory replaces, removed before the upload starts. */
    replacedDirectoryNames: string[];
};

let nextItemKey = 1;

/** Splits a relative upload path into the item it creates in the destination and the rest. */
function splitTopLevel(path: string): { name: string; rest: string | null } {
    const separator = path.indexOf("/");

    return separator === -1
        ? { name: path, rest: null }
        : { name: path.slice(0, separator), rest: path.slice(separator + 1) };
}

/**
 * Groups a pick, drop or paste into the items it creates directly in the destination.
 * Throws for paths that would escape the destination, like the queue does, so a bad source
 * is refused before it reaches the dialog.
 */
export function createUploadItems(source: UploadSource): UploadDraftItem[] {
    const items = new Map<string, UploadDraftItem>();

    /** Returns the item a path belongs to, creating it on first use. */
    const itemFor = (name: string): UploadDraftItem => {
        const existing = items.get(name);

        if (existing !== undefined) {
            return existing;
        }

        const created: UploadDraftItem = {
            key: `upload-item-${nextItemKey++}`,
            name,
            entryType: "file",
            origin: source.origin,
            hasGeneratedName: source.hasGeneratedName ?? false,
            files: [],
            directories: [],
            pastedText: source.pastedText ?? null,
        };

        items.set(name, created);

        return created;
    };

    for (const file of source.files) {
        const relativePath = normalizeRelativePath(file.relativePath);
        const { name, rest } = splitTopLevel(relativePath);
        const item = itemFor(name);

        item.files.push({ file: file.file, relativePath });

        if (rest !== null) {
            item.entryType = "directory";
        }
    }

    for (const directory of source.directories ?? []) {
        const relativePath = normalizeRelativePath(directory);
        const item = itemFor(splitTopLevel(relativePath).name);

        item.directories.push(relativePath);
        item.entryType = "directory";
    }

    return Array.from(items.values());
}

/** Counts the files an upload holds, which is what the queue limit applies to. */
export function countUploadFiles(items: readonly UploadDraftItem[]): number {
    return items.reduce((count, item) => count + item.files.length, 0);
}

/**
 * Plans every row with the shared destination rules. Encrypting a file appends the vault
 * suffix, so conflicts and suggestions are judged on the encrypted name; a directory keeps
 * its name and only the files inside get the suffix. `destination` is null while the
 * listing loads.
 */
export function planUploadRows(props: {
    items: readonly UploadDraftItem[];
    destination: DestinationNames | null;
    choices: UploadChoices;
}): PlannedUploadRow[] {
    const isEncrypted = (item: UploadDraftItem) =>
        props.choices[item.key]?.encrypt ?? false;

    return planDestinationNames({
        items: props.items,
        destination: props.destination,
        choices: props.choices,
        suffixOf: (item) =>
            isEncrypted(item) && item.entryType === "file" ? VAULT_SUFFIX : "",
    }).map((row) => ({ ...row, encrypt: isEncrypted(row.item) }));
}

/**
 * Turns valid rows into the queue batch: every path moves under the row's final name, files
 * of an encrypted directory get the vault suffix one by one, and each file carries the
 * conflict policy of its row. Renamed and new items use the error policy, so a name taken
 * in the meantime fails instead of being overwritten.
 */
export function resolveUpload(
    rows: readonly PlannedUploadRow[],
): ResolvedUpload {
    const files: UploadBatchFile[] = [];
    const directories: string[] = [];
    const replacedDirectoryNames: string[] = [];

    for (const row of rows) {
        /** Moves a path below the item's original name under its final name. */
        const rename = (path: string, suffix: string) => {
            const { rest } = splitTopLevel(path);

            return rest === null
                ? row.finalName
                : `${row.finalName}/${rest}${suffix}`;
        };

        for (const file of row.item.files) {
            files.push({
                file: file.file,
                relativePath: rename(
                    file.relativePath,
                    row.encrypt ? VAULT_SUFFIX : "",
                ),
                onExisting: row.onExisting,
                encrypt: row.encrypt,
            });
        }

        for (const directory of row.item.directories) {
            directories.push(rename(directory, ""));
        }

        if (
            row.conflict !== null &&
            row.resolution === "override" &&
            row.item.entryType === "directory"
        ) {
            replacedDirectoryNames.push(row.finalName);
        }
    }

    return { files, directories, replacedDirectoryNames };
}
