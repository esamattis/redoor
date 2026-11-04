import { atom } from "jotai";
import { atomWithLocalStorage } from "./utils/local-storage-atom";

/**
 * Represents a path selected in the UI for later copy actions.
 */
export type SelectedPath = {
    agentId: string;
    agentName: string;
    path: string;
    fileName: string;
    entryType: "file" | "directory";
    /**
     * The commit id a path was selected at while browsing Git history. Absent for the
     * working tree. A revision can only be copied: it has nothing to move or delete.
     */
    rev?: string;
};

/** The fields that identify one selection, shared by every lookup and removal. */
export type SelectedPathIdentity = Pick<
    SelectedPath,
    "agentId" | "path" | "rev"
>;

/**
 * Identifies a selection across agents, since the same path can exist on several devices,
 * and across revisions, since the working file and its older versions are different sources.
 * Agent ids contain neither `@` nor `:`, so the two forms cannot collide.
 */
export function getSelectedFileKey(file: SelectedPathIdentity) {
    return file.rev === undefined
        ? `${file.agentId}:${file.path}`
        : `${file.agentId}@${file.rev}:${file.path}`;
}

/** True when the selection holds anything read from Git history rather than the worktree. */
export function hasRevisionSelection(files: SelectedPath[]) {
    return files.some((file) => file.rev !== undefined);
}

export const selectedFilesAtom = atomWithLocalStorage<SelectedPath[]>(
    "redoor.selected-files",
    [],
);

/**
 * Fast lookup set for checking whether a path is selected.
 */
export const selectedFileKeysAtom = atom((get) => {
    const selectedFiles = get(selectedFilesAtom);

    return new Set(selectedFiles.map((file) => getSelectedFileKey(file)));
});

/**
 * Returns true when the given path for an agent is currently selected.
 */
export const isFileSelectedAtom = atom(
    null,
    (get, _set, file: SelectedPathIdentity): boolean => {
        return get(selectedFileKeysAtom).has(getSelectedFileKey(file));
    },
);

/**
 * Adds a path to the current selection if it is not already selected.
 */
export const selectFileAtom = atom(null, (get, set, file: SelectedPath) => {
    const selectedFiles = get(selectedFilesAtom);
    const fileKey = getSelectedFileKey(file);

    const alreadySelected = selectedFiles.some(
        (entry) => getSelectedFileKey(entry) === fileKey,
    );

    if (alreadySelected) {
        return;
    }

    set(selectedFilesAtom, [...selectedFiles, file]);
});

/**
 * Removes a path from the current selection.
 */
export const unselectFileAtom = atom(
    null,
    (get, set, file: SelectedPathIdentity) => {
        const fileKey = getSelectedFileKey(file);
        const selectedFiles = get(selectedFilesAtom);

        set(
            selectedFilesAtom,
            selectedFiles.filter(
                (entry) => getSelectedFileKey(entry) !== fileKey,
            ),
        );
    },
);

/**
 * Toggles whether a path is part of the current selection.
 */
export const toggleSelectedFileAtom = atom(
    null,
    (get, set, file: SelectedPath) => {
        const fileKey = getSelectedFileKey(file);
        const selectedFiles = get(selectedFilesAtom);

        const isSelected = selectedFiles.some(
            (entry) => getSelectedFileKey(entry) === fileKey,
        );

        if (isSelected) {
            set(
                selectedFilesAtom,
                selectedFiles.filter(
                    (entry) => getSelectedFileKey(entry) !== fileKey,
                ),
            );

            return;
        }

        set(selectedFilesAtom, [...selectedFiles, file]);
    },
);

/** Updates a visible range in one write while preserving selections outside that range. */
export const setSelectedFilesAtom = atom(
    null,
    (get, set, update: { files: SelectedPath[]; selected: boolean }) => {
        const keys = new Set(update.files.map(getSelectedFileKey));

        const remaining = get(selectedFilesAtom).filter(
            (file) => !keys.has(getSelectedFileKey(file)),
        );

        set(
            selectedFilesAtom,
            update.selected ? [...remaining, ...update.files] : remaining,
        );
    },
);

/**
 * Removes all selected paths at once.
 */
export const clearSelectedFilesAtom = atom(null, (_get, set) => {
    set(selectedFilesAtom, []);
});

/**
 * Removes all selected paths for a single agent.
 */
export const clearSelectedFilesForAgentAtom = atom(
    null,
    (get, set, agentId: string) => {
        const selectedFiles = get(selectedFilesAtom);
        set(
            selectedFilesAtom,
            selectedFiles.filter((file) => file.agentId !== agentId),
        );
    },
);
