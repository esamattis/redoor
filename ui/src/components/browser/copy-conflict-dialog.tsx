import React from "react";
import { Copy } from "lucide-react";
import type { Agent, CopyExistingMode } from "#ui/api-client";
import { Dialog } from "#ui/components/dialog";
import { Tooltip } from "#ui/components/tooltip";
import { joinBrowserPath } from "#ui/components/browser/utils";
import type { SelectedPath } from "#ui/selected-files";

const copyExistingOptions: Array<{
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
        label: "Merge directories",
        description: "Replace conflicts but preserve destination-only entries.",
    },
];

/** Prompts for the API conflict policy only when the loaded destination needs one. */
export function CopySelectedFilesTrigger(props: {
    selectedFiles: SelectedPath[];
    destinationAgent: Agent;
    directoryPath: string;
    destinationFileNames: string[];
    canCopy: boolean;
    onCopy: (mode: CopyExistingMode) => void;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [existingMode, setExistingMode] =
        React.useState<CopyExistingMode>("error");
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
    const handleCopy = () => {
        if (conflictingFiles.length === 0) {
            props.onCopy("error");
            return;
        }
        setExistingMode("error");
        setIsOpen(true);
    };

    return (
        <>
            {props.canCopy ? (
                <Tooltip content="Copy selected items to this directory">
                    <button
                        type="button"
                        onClick={handleCopy}
                        aria-label="Copy selected items to this directory"
                        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500"
                    >
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                    </button>
                </Tooltip>
            ) : null}
            <Dialog
                isOpen={isOpen}
                title="Destination items already exist"
                description={`${conflictingFiles.length} selected ${conflictingFiles.length === 1 ? "item has" : "items have"} the same name as an item in this directory. Choose how to handle the existing destination.`}
                closeAriaLabel="Close copy conflict dialog"
                onClose={() => setIsOpen(false)}
            >
                <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm leading-6 text-slate-300">
                    For files, Replace and Merge both replace the existing file.
                    For directories, Replace removes destination-only entries,
                    while Merge preserves them.
                </p>
                <fieldset className="mt-5 grid gap-3">
                    <legend className="sr-only">Existing item action</legend>
                    {copyExistingOptions.map((option) => (
                        <label
                            key={option.value}
                            className={`flex cursor-pointer gap-3 rounded-lg border px-4 py-3 transition ${
                                existingMode === option.value
                                    ? "border-blue-500/60 bg-blue-500/10"
                                    : "border-slate-700 bg-slate-950/50 hover:border-slate-600"
                            }`}
                        >
                            <input
                                type="radio"
                                name="copy-on-existing"
                                value={option.value}
                                checked={existingMode === option.value}
                                onChange={() => setExistingMode(option.value)}
                                className="mt-0.5 h-4 w-4 accent-blue-500"
                            />
                            <span>
                                <span className="block text-sm font-medium text-slate-100">
                                    {option.label}
                                </span>
                                <span className="mt-1 block text-xs leading-5 text-slate-400">
                                    {option.description}
                                </span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={() => setIsOpen(false)}
                        className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-white/5"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setIsOpen(false);
                            props.onCopy(existingMode);
                        }}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                    >
                        Continue copying
                    </button>
                </div>
            </Dialog>
        </>
    );
}
