import React from "react";
import { useSetAtom } from "jotai";
import { Copy, FolderInput } from "lucide-react";
import type { Agent, CopyExistingMode } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { type SelectedPath, unselectFileAtom } from "#ui/selected-files";
import { AffectedPathsList } from "#ui/components/browser/affected-paths-list";

/** Shared conflict policies so Copy and Move ask the same destination question. */
export const existingItemOptions: Array<{
    value: CopyExistingMode;
    label: string;
    description: string;
}> = [
    {
        value: "error",
        label: "Keep existing",
        description:
            "Report a conflict and leave each existing destination unchanged.",
    },
    {
        value: "override",
        label: "Replace existing",
        description:
            "Replace the entire existing file or directory with the source.",
    },
    {
        value: "merge",
        label: "Merge directories and replace files",
        description: "Replace conflicts but preserve destination-only entries.",
    },
];

/**
 * Operation-specific chrome lives here so Copy keeps its existing accessible
 * names while Move can reuse the same conflict gate.
 */
const transferTriggerCopy = {
    buttonLabel: "Copy",
    buttonTooltip: "Copy selected items to this directory",
    buttonAriaLabel: "Copy selected items to this directory",
    closeAriaLabel: "Close copy conflict dialog",
    confirmLabel: "Continue copying",
    radioGroupName: "copy-on-existing",
    Icon: Copy,
};

const transferTriggerMove = {
    buttonLabel: "Move",
    buttonTooltip: "Move selected items to this directory",
    buttonAriaLabel: "Move selected items to this directory",
    closeAriaLabel: "Close move conflict dialog",
    confirmLabel: "Continue moving",
    radioGroupName: "move-on-existing",
    Icon: FolderInput,
};

export type SelectedFilesTransferOperation = "copy" | "move";

/** Shared by listing buttons and the compact mobile menu so both start the same run. */
export type SelectedFilesTransferTriggerApi = {
    canTransfer: boolean;
    start: () => void;
    labels: typeof transferTriggerCopy;
};

/** Reuses one Keep / Replace / Merge prompt for listing transfers and the Sync workspace. */
export function DestinationConflictDialog(props: {
    isOpen: boolean;
    title: string;
    description: string;
    closeAriaLabel: string;
    confirmLabel: string;
    radioGroupName: string;
    onClose: () => void;
    onConfirm: (mode: CopyExistingMode) => void;
}) {
    const [existingMode, setExistingMode] =
        React.useState<CopyExistingMode>("error");

    // Reset to the safe default whenever the dialog reopens for a new conflict.
    React.useEffect(() => {
        if (props.isOpen) {
            setExistingMode("error");
        }
    }, [props.isOpen]);

    return (
        <Dialog
            isOpen={props.isOpen}
            title={props.title}
            description={props.description}
            closeAriaLabel={props.closeAriaLabel}
            onClose={props.onClose}
        >
            <RadioCardGroup
                legend="Existing item action"
                className="mt-5"
                legendClassName="sr-only"
            >
                {existingItemOptions.map((option) => (
                    <RadioCardOption
                        key={option.value}
                        name={props.radioGroupName}
                        value={option.value}
                        label={option.label}
                        description={option.description}
                        checked={existingMode === option.value}
                        layout="descriptive"
                        onChange={() => setExistingMode(option.value)}
                    />
                ))}
            </RadioCardGroup>
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
                    type="button"
                    onClick={() => {
                        props.onClose();
                        props.onConfirm(existingMode);
                    }}
                    className="rounded-md font-semibold"
                >
                    {props.confirmLabel}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

/** Always confirms selected paths and includes a conflict policy when needed. */
export function SelectedFilesTransferTrigger(props: {
    operation: SelectedFilesTransferOperation;
    selectedFiles: SelectedPath[];
    destinationAgent: Agent;
    directoryPath: string;
    destinationFileNames: string[];
    canTransfer: boolean;
    onConfirm: (mode: CopyExistingMode) => void;
    children: (trigger: SelectedFilesTransferTriggerApi) => React.ReactNode;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [existingMode, setExistingMode] =
        React.useState<CopyExistingMode>("error");
    const unselectFile = useSetAtom(unselectFileAtom);
    const copy = props.operation === "copy";
    const labels = copy ? transferTriggerCopy : transferTriggerMove;
    const destinationFileNames = new Set(props.destinationFileNames);
    const conflictingFiles = props.selectedFiles.filter((file) => {
        const destinationPath = joinBrowserPath(
            props.directoryPath,
            file.fileName,
        );
        const isSamePath =
            file.agentId === props.destinationAgent.id &&
            file.path === destinationPath;
        return !isSamePath && destinationFileNames.has(file.fileName);
    });

    /** Opens one confirmation surface for both ordinary and conflicting transfers. */
    const handleStart = () => {
        setExistingMode("error");
        setIsOpen(true);
    };

    const operationLabel = copy ? "Copy" : "Move";
    const hasConflicts = conflictingFiles.length > 0;

    React.useEffect(() => {
        if (isOpen && props.selectedFiles.length === 0) {
            setIsOpen(false);
        }
    }, [isOpen, props.selectedFiles.length]);

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
                title={
                    hasConflicts
                        ? "Destination items already exist"
                        : `${operationLabel} selected ${props.selectedFiles.length === 1 ? "item" : "items"}?`
                }
                description={
                    hasConflicts
                        ? `${conflictingFiles.length} selected ${conflictingFiles.length === 1 ? "item has" : "items have"} the same name as an item in this directory. Choose how to handle the existing destination.`
                        : `${operationLabel} the selected ${props.selectedFiles.length === 1 ? "item" : "items"} to ${props.destinationAgent.name}:${props.directoryPath}.`
                }
                closeAriaLabel={labels.closeAriaLabel}
                onClose={() => setIsOpen(false)}
            >
                <AffectedPathsList
                    paths={props.selectedFiles}
                    onDeselect={(path) =>
                        unselectFile({ agentId: path.agentId, path: path.path })
                    }
                />
                {hasConflicts ? (
                    <RadioCardGroup
                        legend="Existing item action"
                        className="mt-5"
                        legendClassName="sr-only"
                    >
                        {existingItemOptions.map((option) => (
                            <RadioCardOption
                                key={option.value}
                                name={labels.radioGroupName}
                                value={option.value}
                                label={option.label}
                                description={option.description}
                                checked={existingMode === option.value}
                                layout="descriptive"
                                onChange={() => setExistingMode(option.value)}
                            />
                        ))}
                    </RadioCardGroup>
                ) : null}
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
                        type="button"
                        onClick={() => {
                            setIsOpen(false);
                            props.onConfirm(existingMode);
                        }}
                        className="rounded-md font-semibold"
                    >
                        {hasConflicts
                            ? labels.confirmLabel
                            : `${operationLabel} selected ${props.selectedFiles.length === 1 ? "item" : "items"}`}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
