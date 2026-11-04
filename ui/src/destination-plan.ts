import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { LsEntry } from "#bindings/LsEntry";
import { suggestAvailableFileName } from "#ui/utils/file-name";
import { validatePathComponent } from "#ui/utils/path";

/**
 * What the user chooses for an existing destination. Rename is not a server policy: it is
 * sent as the error policy with a new destination name, so if that name got taken in the
 * meantime the transfer still fails instead of overwriting anything. Leaving the existing
 * item alone without transferring is what removing the item from the dialog is for.
 */
export type ConflictResolution = "rename" | "override" | "merge";

/** Maps the choice to the API policy, keeping renamed destinations non-overwriting. */
export function toExistingMode(
    resolution: ConflictResolution,
): CopyExistingMode {
    return resolution === "rename" ? "error" : resolution;
}

/**
 * Falls back to Rename when Merge is no longer offered, for example after the item it
 * applied to changed, so a hidden choice is never submitted.
 */
function getEffectiveResolution(
    resolution: ConflictResolution,
    canMerge: boolean,
): ConflictResolution {
    return resolution === "merge" && !canMerge ? "rename" : resolution;
}

/** The names already taken in a destination directory, and which of them can be merged into. */
export type DestinationNames = {
    names: ReadonlySet<string>;
    directoryNames: ReadonlySet<string>;
};

/** Reads the taken names from a destination listing. */
export function describeDestinationEntries(
    entries: readonly LsEntry[],
): DestinationNames {
    return {
        names: new Set(entries.map((entry) => entry.name)),
        directoryNames: new Set(
            entries.flatMap((entry) =>
                entry.type === "directory" ? [entry.name] : [],
            ),
        ),
    };
}

/** One item that is about to be created in a destination directory under a name. */
export type DestinationItem = {
    /** Stays the same while the item is in a dialog, so its choices follow it. */
    key: string;
    /** The name the item has where it comes from. */
    name: string;
    entryType: "file" | "directory";
    /**
     * True when the name was made up rather than chosen by the user, such as for pasted
     * text. Such a name is replaced by a free one instead of asking whether to replace the
     * existing item it happens to match.
     */
    hasGeneratedName?: boolean;
    /**
     * True when the item already sits at its destination path, such as a file copied into
     * the directory it is in. The server refuses that transfer itself, so it is not offered
     * as a conflict to resolve.
     */
    isAtDestination?: boolean;
};

/** What the user changed on one item; anything left out follows the suggestion. */
export type DestinationChoice = {
    /** The raw name input, kept untrimmed so typing whitespace does not jump the caret. */
    name?: string;
    resolution?: ConflictResolution;
};

/** One item with the name it will get and the reason it cannot, when its name is invalid. */
export type PlannedDestination<T extends DestinationItem> = {
    item: T;
    /** The value of the name input. */
    value: string;
    /** The name the item gets in the destination, including any suffix. */
    finalName: string;
    /**
     * Set when the item's own name is already taken in the destination, so the user chooses
     * whether to rename, replace or merge. Null when there is nothing to ask.
     */
    conflict: { existingName: string; canMerge: boolean } | null;
    resolution: ConflictResolution;
    /** The policy to send: the chosen one for a conflict, otherwise never overwrite. */
    onExisting: CopyExistingMode;
    error: string | null;
};

/**
 * Picks the name an item starts with: its own when that is free, otherwise the first free
 * `name_2` style variant. Freeness is judged on the final name, so a suffix that makes the
 * own name free again, such as the vault suffix, keeps it.
 */
function suggestName(
    item: DestinationItem,
    suffix: string,
    takenNames: ReadonlySet<string>,
): string {
    if (!takenNames.has(item.name + suffix)) {
        return item.name;
    }

    // suggestAvailableFileName compares bare names, so strip the suffix of taken names first.
    const takenBareNames = new Set(
        Array.from(takenNames).flatMap((name) =>
            suffix === ""
                ? [name]
                : name.endsWith(suffix)
                  ? [name.slice(0, -suffix.length)]
                  : [],
        ),
    );

    return suggestAvailableFileName(item.name, item.entryType, takenBareNames);
}

/**
 * Works out every item's final name, conflict choice and validation for upload, copy, move
 * and sync, so all of them ask the same question the same way. Earlier items win a name, so
 * a later item with the same name gets a free suggestion instead, and a typed name must avoid
 * both the destination and the other items. `destination` is null while it is still being
 * read, which checks against nothing yet.
 */
export function planDestinationNames<T extends DestinationItem>(props: {
    items: readonly T[];
    destination: DestinationNames | null;
    choices: Readonly<Record<string, DestinationChoice>>;
    /** Appended to the typed name, such as the vault suffix of a file that is encrypted. */
    suffixOf?: (item: T) => string;
}): PlannedDestination<T>[] {
    const destinationNames = props.destination?.names ?? new Set<string>();

    const destinationDirectories =
        props.destination?.directoryNames ?? new Set<string>();

    const usedNames = new Set<string>();

    return props.items.map((item) => {
        const choice = props.choices[item.key] ?? {};
        const suffix = props.suffixOf?.(item) ?? "";
        const ownName = item.name + suffix;

        const conflict =
            item.hasGeneratedName !== true &&
            item.isAtDestination !== true &&
            destinationNames.has(ownName)
                ? {
                      existingName: ownName,
                      canMerge:
                          item.entryType === "directory" &&
                          destinationDirectories.has(ownName),
                  }
                : null;

        const resolution =
            conflict === null
                ? "rename"
                : getEffectiveResolution(
                      choice.resolution ?? "rename",
                      conflict.canMerge,
                  );

        // Replace and Merge land on the existing item, so the item keeps its own name.
        const keepsOwnName = conflict !== null && resolution !== "rename";

        const value = keepsOwnName
            ? item.name
            : (choice.name ??
              (item.isAtDestination === true
                  ? item.name
                  : suggestName(
                        item,
                        suffix,
                        new Set([...destinationNames, ...usedNames]),
                    )));

        const name = value.trim();
        const finalName = name + suffix;

        // An item at its own destination may keep that name; the server explains the refusal.
        const mayUseTakenName =
            keepsOwnName ||
            (item.isAtDestination === true && finalName === ownName);

        const error =
            validatePathComponent(
                name,
                item.entryType === "file" ? "File" : "Directory",
            ) ??
            (usedNames.has(finalName)
                ? "Another item already uses this name"
                : !mayUseTakenName && destinationNames.has(finalName)
                  ? `${finalName} already exists in this directory`
                  : null);

        usedNames.add(finalName);

        return {
            item,
            value,
            finalName,
            conflict,
            resolution,
            onExisting:
                conflict === null ? "error" : toExistingMode(resolution),
            error,
        };
    });
}

/**
 * The choice every conflicting item shares, so one control can show and set them all. Null
 * when the items differ, and also when there is nothing to choose for.
 */
export function getSharedResolution(
    rows: readonly PlannedDestination<DestinationItem>[],
): ConflictResolution | null {
    const resolutions = new Set(
        rows.flatMap((row) => (row.conflict === null ? [] : [row.resolution])),
    );

    const [only] = resolutions;

    return resolutions.size === 1 && only !== undefined ? only : null;
}

/**
 * Applies one choice to every conflicting item. Merge reads "merge directories and replace
 * files", so an item that cannot be merged, such as a file, is replaced instead.
 */
export function resolveAllConflicts(
    rows: readonly PlannedDestination<DestinationItem>[],
    resolution: ConflictResolution,
): Record<string, ConflictResolution> {
    return Object.fromEntries(
        rows.flatMap((row) =>
            row.conflict === null
                ? []
                : [
                      [
                          row.item.key,
                          resolution === "merge" && !row.conflict.canMerge
                              ? "override"
                              : resolution,
                      ],
                  ],
        ),
    );
}
