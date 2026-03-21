import { atom } from "jotai";

/**
 * Represents a file selected in the UI for later copy actions.
 */
export type SelectedFile = {
    agentId: string;
    agentName: string;
    path: string;
    relativePath: string;
    fileName: string;
};

function getSelectedFileKey(file: Pick<SelectedFile, "agentId" | "path">) {
    return `${file.agentId}:${file.path}`;
}

export const selectedFilesAtom = atom<SelectedFile[]>([]);

/**
 * Fast lookup set for checking whether a file is selected.
 */
export const selectedFileKeysAtom = atom((get) => {
    const selectedFiles = get(selectedFilesAtom);
    return new Set(selectedFiles.map((file) => getSelectedFileKey(file)));
});

/**
 * Returns true when the given file path for an agent is currently selected.
 */
export const isFileSelectedAtom = atom(
    null,
    (get, _set, file: Pick<SelectedFile, "agentId" | "path">): boolean => {
        return get(selectedFileKeysAtom).has(getSelectedFileKey(file));
    },
);

/**
 * Adds a file to the current selection if it is not already selected.
 */
export const selectFileAtom = atom(null, (get, set, file: SelectedFile) => {
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
 * Removes a file from the current selection.
 */
export const unselectFileAtom = atom(
    null,
    (get, set, file: Pick<SelectedFile, "agentId" | "path">) => {
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
 * Toggles whether a file is part of the current selection.
 */
export const toggleSelectedFileAtom = atom(
    null,
    (get, set, file: SelectedFile) => {
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

/**
 * Removes all selected files at once.
 */
export const clearSelectedFilesAtom = atom(null, (_get, set) => {
    set(selectedFilesAtom, []);
});

/**
 * Removes all selected files for a single agent.
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
