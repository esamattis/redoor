import React from "react";
import { Copy, FolderInput } from "lucide-react";
import type { Agent, CopyExistingMode } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { Tooltip } from "#ui/components/tooltip";
import { joinBrowserPath } from "#ui/components/browser/utils";
import type { SelectedPath } from "#ui/selected-files";

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

/** Prompts for the API conflict policy only when the loaded destination needs one. */
export function SelectedFilesTransferTrigger(props: {
    operation: SelectedFilesTransferOperation;
    selectedFiles: SelectedPath[];
    destinationAgent: Agent;
    directoryPath: string;
    destinationFileNames: string[];
    canTransfer: boolean;
    onConfirm: (mode: CopyExistingMode) => void;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
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

    /** Starts immediately when safe, otherwise opens the policy choice. */
    const handleStart = () => {
        if (conflictingFiles.length === 0) {
            props.onConfirm("error");
            return;
        }
        setIsOpen(true);
    };

    return (
        <>
            {props.canTransfer ? (
                <Tooltip content={labels.buttonTooltip}>
                    <Button
                        type="button"
                        onClick={handleStart}
                        aria-label={labels.buttonAriaLabel}
                        size="sm"
                        className="rounded-md px-3.5 font-semibold shadow-sm shadow-blue-950/30"
                    >
                        <labels.Icon className="h-3.5 w-3.5" />
                        {labels.buttonLabel}
                    </Button>
                </Tooltip>
            ) : null}
            <DestinationConflictDialog
                isOpen={isOpen}
                title="Destination items already exist"
                description={`${conflictingFiles.length} selected ${conflictingFiles.length === 1 ? "item has" : "items have"} the same name as an item in this directory. Choose how to handle the existing destination.`}
                closeAriaLabel={labels.closeAriaLabel}
                confirmLabel={labels.confirmLabel}
                radioGroupName={labels.radioGroupName}
                onClose={() => setIsOpen(false)}
                onConfirm={props.onConfirm}
            />
        </>
    );
}
