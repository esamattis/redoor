import React from "react";
import { File, Folder, X } from "lucide-react";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import { Select } from "#ui/components/select";
import {
    type ConflictResolution,
    type DestinationChoice,
    type DestinationItem,
    getSharedResolution,
    type PlannedDestination,
    planDestinationNames,
    resolveAllConflicts,
} from "#ui/destination-plan";
import { cn } from "#ui/utils/cn";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";

/** The conflict choices, worded the same in upload, copy, move and sync. */
const resolutionOptions: Array<{ value: ConflictResolution; label: string }> = [
    { value: "rename", label: "Rename" },
    { value: "override", label: "Replace existing" },
    { value: "merge", label: "Merge directories and replace files" },
];

/** Narrows a select value back to a resolution instead of trusting a cast. */
function parseResolution(value: string): ConflictResolution | null {
    return value === "rename" || value === "override" || value === "merge"
        ? value
        : null;
}

/** The file or directory icon for rows that have no richer preview. */
export function EntryTypeIcon(props: { entryType: "file" | "directory" }) {
    return props.entryType === "directory" ? (
        <Folder className="h-5 w-5 text-blue-400" />
    ) : (
        <File className="h-5 w-5" />
    );
}

/**
 * One item that is about to land in a destination directory: its name there, and what to
 * do when that name is taken. Upload, copy, move and sync all use it, so the question is
 * asked the same way everywhere. On phones the controls wrap below the name instead of
 * squeezing it.
 */
export function DestinationRow(props: {
    row: PlannedDestination<DestinationItem>;
    /** A small picture of the item, such as an icon or a thumbnail. */
    preview: React.ReactNode;
    /** Says what the item is or where it comes from. */
    meta: React.ReactNode;
    /** Notes under the name, such as the name an encrypted file is saved under. */
    notes?: React.ReactNode;
    /** Controls next to the meta line, such as Encrypt. */
    controls?: React.ReactNode;
    /** Takes the item out of the operation; left out where it cannot be removed. */
    remove?: { label: string; tooltip: string; onRemove: () => void };
    /** Focuses the name with its stem selected, so a made-up name can be typed over. */
    hasFocus?: boolean;
    disabled: boolean;
    onChange: (choice: DestinationChoice) => void;
}) {
    const item = props.row.item;
    const conflict = props.row.conflict;
    const keepsOwnName = conflict !== null && props.row.resolution !== "rename";

    const resolutions = resolutionOptions.filter(
        (option) => option.value !== "merge" || conflict?.canMerge === true,
    );

    return (
        <li
            className={cn(
                "flex flex-col gap-2 rounded-lg border p-3",
                conflict !== null
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-slate-800",
            )}
        >
            <div className="flex items-center gap-3">
                <div
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-700 bg-canvas text-slate-500"
                >
                    {props.preview}
                </div>
                <InputControl
                    ref={
                        props.hasFocus === true
                            ? focusAndSelectFileNameStem
                            : undefined
                    }
                    autoFocus={props.hasFocus}
                    aria-label={`Name for ${item.name}`}
                    aria-invalid={props.row.error !== null}
                    value={props.row.value}
                    disabled={props.disabled || keepsOwnName}
                    onChange={(event) =>
                        props.onChange({ name: event.target.value })
                    }
                    className={cn(
                        "min-w-0 flex-1 disabled:opacity-60",
                        props.row.error !== null &&
                            "border-red-500/70 focus:border-red-500",
                    )}
                />
                {props.remove !== undefined ? (
                    <IconButton
                        type="button"
                        label={props.remove.label}
                        tooltip={props.remove.tooltip}
                        variant="ghost"
                        size="xl"
                        className="flex shrink-0 items-center justify-center"
                        disabled={props.disabled}
                        onClick={props.remove.onRemove}
                    >
                        <X className="h-4 w-4" />
                    </IconButton>
                ) : null}
            </div>
            {props.notes}
            {conflict !== null ? (
                <p className="text-xs text-amber-300 sm:pl-[3.25rem]">
                    {props.row.resolution === "rename"
                        ? `${conflict.existingName} already exists here and is kept.`
                        : `${conflict.existingName} already exists here.`}
                </p>
            ) : null}
            {props.row.error !== null ? (
                <p
                    role="alert"
                    className="text-xs text-red-300 sm:pl-[3.25rem]"
                >
                    {props.row.error}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:pl-[3.25rem]">
                {conflict !== null ? (
                    <Select
                        aria-label={`If ${item.name} exists`}
                        value={props.row.resolution}
                        disabled={props.disabled}
                        containerClassName="w-full sm:w-auto"
                        className="text-sm"
                        onChange={(event) =>
                            props.onChange({
                                resolution:
                                    parseResolution(event.target.value) ??
                                    "rename",
                            })
                        }
                    >
                        {resolutions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </Select>
                ) : null}
                <span className="min-w-0 flex-1 text-xs break-all text-slate-500">
                    {props.meta}
                </span>
                {props.controls}
            </div>
        </li>
    );
}

/**
 * Sets the choice of every conflicting item at once, so ten existing items do not need ten
 * selects. It only appears with more than one conflict and shows "Choose for each" while
 * the items differ.
 */
export function ConflictBulkSelect(props: {
    rows: readonly PlannedDestination<DestinationItem>[];
    disabled: boolean;
    onChange: (resolutions: Record<string, ConflictResolution>) => void;
}) {
    const conflicts = props.rows.filter((row) => row.conflict !== null);

    if (conflicts.length < 2) {
        return null;
    }

    const shared = getSharedResolution(props.rows);
    const canMerge = conflicts.some((row) => row.conflict?.canMerge === true);

    return (
        <label className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
            <span className="min-w-0 flex-1">
                {conflicts.length} items already exist here
            </span>
            <Select
                aria-label="For every existing item"
                value={shared ?? ""}
                disabled={props.disabled}
                containerClassName="w-full sm:w-auto"
                className="text-sm"
                onChange={(event) => {
                    const resolution = parseResolution(event.target.value);

                    if (resolution !== null) {
                        props.onChange(
                            resolveAllConflicts(props.rows, resolution),
                        );
                    }
                }}
            >
                {shared === null ? (
                    <option value="" disabled>
                        Choose for each
                    </option>
                ) : null}
                <option value="rename">Rename all</option>
                <option value="override">Replace all existing</option>
                {canMerge ? (
                    <option value="merge">
                        Merge directories and replace files
                    </option>
                ) : null}
            </Select>
        </label>
    );
}

/**
 * Asks the shared Rename / Replace / Merge question for the Sync workspace, where a single
 * known destination exists. Callers mount it only while a conflict is being resolved, so
 * each prompt starts from the safe default and a fresh suggested name.
 */
export function DestinationConflictDialog(props: {
    title: string;
    description: string;
    closeAriaLabel: string;
    confirmLabel: string;
    /** The existing destination's name, which the suggested new name is derived from. */
    existingName: string;
    entryType: "file" | "directory";
    /** True only when a directory would land on an existing directory. */
    canMerge: boolean;
    onClose: () => void;
    /** Receives the new destination name when the user chose to rename, otherwise null. */
    onConfirm: (mode: CopyExistingMode, newName: string | null) => void;
}) {
    const [choices, setChoices] = React.useState<
        Record<string, DestinationChoice>
    >({});

    // Sync cannot see the destination's siblings, so only the known conflict is checked
    // here; the error policy still fails safely if the new name is taken too.
    const [row] = planDestinationNames({
        items: [
            {
                key: props.existingName,
                name: props.existingName,
                entryType: props.entryType,
            },
        ],
        destination: {
            names: new Set([props.existingName]),
            directoryNames: new Set(props.canMerge ? [props.existingName] : []),
        },
        choices,
    });

    return (
        <Dialog
            isOpen={true}
            size="wide"
            title={props.title}
            description={props.description}
            closeAriaLabel={props.closeAriaLabel}
            onClose={props.onClose}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();

                    if (row === undefined || row.error !== null) {
                        return;
                    }

                    props.onClose();
                    props.onConfirm(
                        row.onExisting,
                        row.resolution === "rename" ? row.finalName : null,
                    );
                }}
            >
                {row !== undefined ? (
                    <ul className="mt-4">
                        <DestinationRow
                            row={row}
                            preview={
                                <EntryTypeIcon entryType={props.entryType} />
                            }
                            meta={null}
                            disabled={false}
                            onChange={(change) =>
                                setChoices((current) => ({
                                    ...current,
                                    [row.item.key]: {
                                        ...current[row.item.key],
                                        ...change,
                                    },
                                }))
                            }
                        />
                    </ul>
                ) : null}
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        className="rounded-md text-slate-300"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        disabled={row === undefined || row.error !== null}
                        className="rounded-md font-semibold"
                    >
                        {props.confirmLabel}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}
