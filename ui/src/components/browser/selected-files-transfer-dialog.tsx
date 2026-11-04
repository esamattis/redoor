import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "#ui/api-client";
import type { ResumeMode } from "#bindings/ResumeMode";
import { formatSize } from "#ui/utils/path";
import { useSetAtom } from "jotai";
import { Copy, FolderInput } from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { joinBrowserPath } from "#ui/components/browser/utils";
import {
    getSelectedFileKey,
    type SelectedPath,
    unselectFileAtom,
} from "#ui/selected-files";
import {
    ConflictBulkSelect,
    DestinationRow,
    EntryTypeIcon,
} from "#ui/components/browser/destination-conflict";
import { RevisionBadge } from "#ui/components/browser/git-parts";
import {
    type ConflictResolution,
    describeDestinationEntries,
    type DestinationChoice,
    type DestinationItem,
    type PlannedDestination,
    planDestinationNames,
} from "#ui/destination-plan";
import type { LsEntry } from "#bindings/LsEntry";

/**
 * Operation-specific chrome lives here so Copy keeps its existing accessible
 * names while Move can reuse the same conflict gate.
 */
const transferTriggerCopy = {
    buttonLabel: "Copy",
    buttonTooltip: "Copy selected items to this directory",
    buttonAriaLabel: "Copy selected items to this directory",
    closeAriaLabel: "Close copy dialog",
    Icon: Copy,
};

const transferTriggerMove = {
    buttonLabel: "Move",
    buttonTooltip: "Move selected items to this directory",
    buttonAriaLabel: "Move selected items to this directory",
    closeAriaLabel: "Close move dialog",
    Icon: FolderInput,
};

export type SelectedFilesTransferOperation = "copy" | "move";

/** Shared by listing buttons and the compact mobile menu so both start the same run. */
export type SelectedFilesTransferTriggerApi = {
    canTransfer: boolean;
    start: () => void;
    labels: typeof transferTriggerCopy;
};

/** Offers resuming an interrupted transfer, independently of the conflict choice. */
function ResumeOptions(props: {
    candidate: { partial_bytes: number; total_bytes: number };
    value: ResumeMode;
    onChange: (value: ResumeMode) => void;
}) {
    return (
        <RadioCardGroup
            legend={`Interrupted transfer: ${formatSize(props.candidate.partial_bytes)} / ${formatSize(props.candidate.total_bytes)}`}
            className="mt-5"
        >
            <RadioCardOption
                layout="descriptive"
                name="transfer-resume"
                value="auto"
                label="Resume"
                description="Verify and continue the partial file."
                checked={props.value === "auto"}
                onChange={() => props.onChange("auto")}
            />
            <RadioCardOption
                layout="descriptive"
                name="transfer-resume"
                value="restart"
                label="Start over"
                description="Discard partial progress and copy from the beginning."
                checked={props.value === "restart"}
                onChange={() => props.onChange("restart")}
            />
        </RadioCardGroup>
    );
}

/** One selected item with the destination name and policy chosen for it in the dialog. */
export type PlannedTransferItem = {
    file: SelectedPath;
    destinationName: string;
    existingMode: CopyExistingMode;
};

/** A selected path as a destination item, so the shared planner can name it. */
type SelectedDestinationItem = DestinationItem & { file: SelectedPath };

/**
 * Lists the selected items on the shared destination rows, with where each comes from and
 * a Deselect button, plus one control that resolves every existing item at once.
 */
function TransferItemList(props: {
    rows: readonly PlannedDestination<SelectedDestinationItem>[];
    operationLabel: string;
    onChange: (key: string, change: DestinationChoice) => void;
    onResolveAll: (resolutions: Record<string, ConflictResolution>) => void;
    onDeselect: (file: SelectedPath) => void;
}) {
    return (
        <>
            <ConflictBulkSelect
                rows={props.rows}
                disabled={false}
                onChange={props.onResolveAll}
            />
            <ul
                aria-label={`Items to ${props.operationLabel.toLowerCase()}`}
                className="mt-3 flex max-h-[min(30rem,55dvh)] flex-col gap-2 overflow-y-auto overscroll-y-contain"
            >
                {props.rows.map((row) => (
                    <DestinationRow
                        key={row.item.key}
                        row={row}
                        preview={
                            <EntryTypeIcon entryType={row.item.entryType} />
                        }
                        meta={
                            <>
                                {row.item.file.agentName}:{row.item.file.path}
                                {row.item.file.rev === undefined ? null : (
                                    <RevisionBadge
                                        commitId={row.item.file.rev}
                                    />
                                )}
                            </>
                        }
                        remove={{
                            label: `Deselect ${row.item.file.fileName}`,
                            tooltip: "Deselect",
                            onRemove: () => props.onDeselect(row.item.file),
                        }}
                        disabled={false}
                        onChange={(change) =>
                            props.onChange(row.item.key, change)
                        }
                    />
                ))}
            </ul>
        </>
    );
}

/**
 * Always confirms the selected paths in one dialog that lists every item with its name in
 * this directory and, when that name is taken, what happens to the existing item. It uses
 * the same rows as uploads, so the question is asked the same way everywhere.
 */
export function SelectedFilesTransferTrigger(props: {
    api: ApiClient;
    operation: SelectedFilesTransferOperation;
    selectedFiles: SelectedPath[];
    destinationAgent: Agent;
    directoryPath: string;
    /** The destination listing, whose entry types decide whether Merge is offered. */
    destinationEntries: LsEntry[];
    canTransfer: boolean;
    onConfirm: (items: PlannedTransferItem[], resume: ResumeMode) => void;
    children: (trigger: SelectedFilesTransferTriggerApi) => React.ReactNode;
}) {
    const [isOpen, setIsOpen] = React.useState(false);

    // Only what the user changed is stored; everything else follows the suggestions.
    const [choices, setChoices] = React.useState<
        Record<string, DestinationChoice>
    >({});

    const [resumeMode, setResumeMode] = React.useState<ResumeMode>("auto");

    const preflight = useQuery({
        queryKey: [
            "copy-preflight",
            props.destinationAgent.id,
            props.directoryPath,
            props.selectedFiles,
        ],
        enabled: isOpen,
        // A revision is read from a commit, so it never leaves a resumable partial.
        queryFn: async () =>
            Promise.all(
                props.selectedFiles
                    .filter((file) => file.rev === undefined)
                    .map((file) =>
                        props.api.copyPreflight({
                            source: { agent: file.agentId, path: file.path },
                            dest: {
                                agent: props.destinationAgent.id,
                                path: joinBrowserPath(
                                    props.directoryPath,
                                    file.fileName,
                                ),
                            },
                        }),
                    ),
            ),
    });

    const candidate = preflight.data?.find(
        (result) => result.resume_candidate,
    )?.resume_candidate;

    const unselectFile = useSetAtom(unselectFileAtom);
    const copy = props.operation === "copy";
    const labels = copy ? transferTriggerCopy : transferTriggerMove;
    const operationLabel = copy ? "Copy" : "Move";

    const items: SelectedDestinationItem[] = props.selectedFiles.map(
        (file) => ({
            key: getSelectedFileKey(file),
            name: file.fileName,
            entryType: file.entryType,
            // A revision is copied from a commit, so it conflicts even with its own working file.
            isAtDestination:
                file.rev === undefined &&
                file.agentId === props.destinationAgent.id &&
                file.path ===
                    joinBrowserPath(props.directoryPath, file.fileName),
            file,
        }),
    );

    const rows = planDestinationNames({
        items,
        destination: describeDestinationEntries(props.destinationEntries),
        choices,
    });

    const conflictCount = rows.filter((row) => row.conflict !== null).length;
    const selectedCount = props.selectedFiles.length;
    const itemsLabel = selectedCount === 1 ? "item" : "items";
    const destination = `${props.destinationAgent.name}:${props.directoryPath}`;

    // A failed preflight must not block the transfer; the server still resumes a valid
    // partial because the default mode is auto.
    const canConfirm =
        rows.length > 0 &&
        !preflight.isPending &&
        rows.every((row) => row.error === null);

    /** Opens one confirmation surface for both ordinary and conflicting transfers. */
    const handleStart = () => {
        setChoices({});
        setResumeMode("auto");
        setIsOpen(true);
    };

    // Clearing the selection dismisses the prompt. Resetting the state while rendering, rather
    // than hiding the dialog, keeps it from reappearing when something is selected again.
    if (isOpen && selectedCount === 0) {
        setIsOpen(false);
    }

    return (
        <>
            {props.children({
                canTransfer: props.canTransfer,
                start: handleStart,
                labels,
            })}
            <Dialog
                isOpen={isOpen}
                size="wide"
                title={`${operationLabel} selected ${itemsLabel}?`}
                description={
                    conflictCount > 0
                        ? `${conflictCount} of the selected ${itemsLabel} already ${conflictCount === 1 ? "exists" : "exist"} in ${destination}. Choose what happens to ${conflictCount === 1 ? "it" : "each"}.`
                        : `${operationLabel} the selected ${itemsLabel} to ${destination}.`
                }
                closeAriaLabel={labels.closeAriaLabel}
                onClose={() => setIsOpen(false)}
            >
                <form
                    onSubmit={(event) => {
                        event.preventDefault();

                        if (!canConfirm) {
                            return;
                        }

                        setIsOpen(false);
                        props.onConfirm(
                            rows.map((row) => ({
                                file: row.item.file,
                                destinationName: row.finalName,
                                existingMode: row.onExisting,
                            })),
                            resumeMode,
                        );
                    }}
                >
                    {candidate ? (
                        <ResumeOptions
                            candidate={candidate}
                            value={resumeMode}
                            onChange={setResumeMode}
                        />
                    ) : null}
                    {preflight.error ? (
                        <p role="alert" className="mt-5 text-sm text-amber-300">
                            Cannot check for an interrupted transfer:{" "}
                            {preflight.error.message}
                        </p>
                    ) : null}
                    <TransferItemList
                        rows={rows}
                        operationLabel={operationLabel}
                        onChange={(key, change) =>
                            setChoices((current) => ({
                                ...current,
                                [key]: { ...current[key], ...change },
                            }))
                        }
                        onResolveAll={(resolutions) =>
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
                        onDeselect={(file) => unselectFile(file)}
                    />
                    <DialogActions>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setIsOpen(false)}
                            className="rounded-md text-slate-300"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!canConfirm}
                            className="rounded-md font-semibold"
                        >
                            {`${operationLabel} selected ${itemsLabel}`}
                        </Button>
                    </DialogActions>
                </form>
            </Dialog>
        </>
    );
}
