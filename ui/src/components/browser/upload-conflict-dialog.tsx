import React from "react";
import { useMutation } from "@tanstack/react-query";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { LsEntry } from "#bindings/LsEntry";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { AffectedPathsList } from "#ui/components/browser/affected-paths-list";
import {
    canMergeConflicts,
    type ConflictCandidate,
    describeDestinationEntries,
    type ConflictResolution,
    ExistingItemOptions,
    getEffectiveResolution,
    NewNameFields,
    planRenames,
    toExistingMode,
} from "#ui/components/browser/destination-conflict";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { normalizeRelativePath, type UploadSourceFile } from "#ui/upload-queue";
import { getErrorMessage } from "#ui/utils/error";

/** An upload whose top-level items collide with entries already in the destination. */
export type ConflictingUpload = {
    agent: Agent;
    destinationPath: string;
    files: UploadSourceFile[];
    directories: string[];
    destinationEntries: LsEntry[];
    /** Carried through the conflict choice, so an encrypted upload stays encrypted. */
    encrypt: boolean;
};

/** The upload to enqueue once the user has chosen how to treat existing entries. */
export type ResolvedUpload = {
    files: UploadSourceFile[];
    directories: string[];
    onExisting: CopyExistingMode;
    encrypt?: boolean;
};

/** Splits a relative upload path into the item it creates in the destination and the rest. */
function splitTopLevel(path: string): { name: string; rest: string | null } {
    const normalized = normalizeRelativePath(path);
    const separator = normalized.indexOf("/");

    return separator === -1
        ? { name: normalized, rest: null }
        : {
              name: normalized.slice(0, separator),
              rest: normalized.slice(separator + 1),
          };
}

/**
 * Collapses an upload manifest into the items it creates directly in the destination, since
 * only those can collide with existing entries there. Throws for paths that would escape the
 * destination, like the queue does.
 */
export function getTopLevelUploadItems(
    files: UploadSourceFile[],
    directories: string[],
): ConflictCandidate[] {
    const items = new Map<string, ConflictCandidate>();

    const sources = [
        ...files.map((file) => ({ path: file.relativePath, isFile: true })),
        ...directories.map((path) => ({ path, isFile: false })),
    ];

    for (const source of sources) {
        const { name, rest } = splitTopLevel(source.path);
        const isDirectory = rest !== null || !source.isFile;

        const entryType =
            isDirectory || items.get(name)?.entryType === "directory"
                ? "directory"
                : "file";

        items.set(name, { key: name, fileName: name, entryType });
    }

    return Array.from(items.values());
}

/** Moves every path below a renamed top-level item under its new name. */
function renameTopLevel(
    path: string,
    newNames: ReadonlyMap<string, string>,
): string {
    const { name, rest } = splitTopLevel(path);
    const newName = newNames.get(name) ?? name;

    return rest === null ? newName : `${newName}/${rest}`;
}

/**
 * Asks the same Rename / Replace / Merge question as Copy and Move before an upload would
 * write over existing destination entries. The caller mounts it only while a conflicting
 * upload waits, so each prompt starts from the safe Rename default.
 */
export function UploadConflictDialog(props: {
    upload: ConflictingUpload;
    onClose: () => void;
    onResolved: (upload: ResolvedUpload) => void;
}) {
    const [chosenResolution, setResolution] =
        React.useState<ConflictResolution>("rename");

    // Only names the user edited are stored; the rest follow the current suggestion.
    const [editedNames, setEditedNames] = React.useState<
        Record<string, string>
    >({});

    const items = getTopLevelUploadItems(
        props.upload.files,
        props.upload.directories,
    );

    const destination = describeDestinationEntries(
        props.upload.destinationEntries,
    );

    const conflicts = items.filter((item) =>
        destination.fileNames.has(item.fileName),
    );

    const canMerge = canMergeConflicts(conflicts, destination.directoryNames);
    const resolution = getEffectiveResolution(chosenResolution, canMerge);
    const isRenaming = resolution === "rename";

    const renames = planRenames({
        items,
        conflicts,
        destinationFileNames: destination.fileNames,
        editedNames,
    });

    const hasInvalidName =
        isRenaming && renames.some((rename) => rename.error !== null);

    const resolveMutation = useMutation({
        mutationFn: async (): Promise<ResolvedUpload> => {
            const upload = props.upload;

            if (isRenaming) {
                const newNames = new Map(
                    renames.map((rename) => [
                        rename.item.fileName,
                        rename.name,
                    ]),
                );

                return {
                    files: upload.files.map((file) => ({
                        ...file,
                        relativePath: renameTopLevel(
                            file.relativePath,
                            newNames,
                        ),
                    })),
                    directories: upload.directories.map((path) =>
                        renameTopLevel(path, newNames),
                    ),
                    onExisting: "error",
                };
            }

            if (resolution === "override") {
                // Uploads write one file at a time, so a directory cannot atomically replace
                // what is there. The existing entry is cleared first, into the trash when the
                // agent has one, so a failed upload does not lose it for good.
                await Promise.all(
                    conflicts
                        .filter(
                            (conflict) => conflict.entryType === "directory",
                        )
                        .map((conflict) =>
                            upload.agent.deleteFile(
                                joinBrowserPath(
                                    upload.destinationPath,
                                    conflict.fileName,
                                ),
                                { trash: upload.agent.supportsMoveToTrash },
                            ),
                        ),
                );
            }

            return {
                files: upload.files,
                directories: upload.directories,
                onExisting: toExistingMode(resolution),
            };
        },
        onSuccess: (resolved) => props.onResolved(resolved),
    });

    return (
        <Dialog
            isOpen={true}
            size="wide"
            isBusy={resolveMutation.isPending}
            title="Destination items already exist"
            description={`${conflicts.length} uploaded ${conflicts.length === 1 ? "item has" : "items have"} the same name as an item in this directory. Choose how to handle the existing destination.`}
            closeAriaLabel="Close upload conflict dialog"
            errorMessage={
                resolveMutation.error
                    ? getErrorMessage(
                          resolveMutation.error,
                          "The existing items could not be replaced.",
                      )
                    : null
            }
            onClose={props.onClose}
        >
            <AffectedPathsList
                paths={items.map((item) => ({
                    agentId: props.upload.agent.id,
                    agentName: "Upload from this browser",
                    path: item.fileName,
                    fileName: item.fileName,
                    entryType: item.entryType,
                }))}
            />
            <ExistingItemOptions
                radioGroupName="upload-on-existing"
                value={resolution}
                canMerge={canMerge}
                onChange={setResolution}
            />
            {isRenaming ? (
                <NewNameFields
                    renames={renames}
                    onChange={(key, value) =>
                        setEditedNames((names) => ({ ...names, [key]: value }))
                    }
                />
            ) : null}
            <DialogActions>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={props.onClose}
                    disabled={resolveMutation.isPending}
                    className="rounded-md text-slate-300"
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    disabled={hasInvalidName}
                    isLoading={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate()}
                    className="rounded-md font-semibold"
                >
                    Continue uploading
                </Button>
            </DialogActions>
        </Dialog>
    );
}
