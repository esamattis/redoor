import { atom } from "jotai";

import type { GitChangeKind } from "#ui/components/browser/git-parts";

/** One file of the diff on screen, as the side menu lists it. */
export type ChangedFilesOutlineFile = {
    /** The absolute path, which is the file's identity in the diff list. */
    path: string;
    /** The repository-relative path, which names the file in the list. */
    relativePath: string;
    /** The Git change badge, or null where the kind of change is not known. */
    change: GitChangeKind | null;
};

/** The files of the diff list on screen and how to bring one of them into view. */
export type ChangedFilesOutlineSnapshot = {
    files: ReadonlyArray<ChangedFilesOutlineFile>;
    /** Expands the file's diff and scrolls the list to it. */
    reveal: (path: string) => void;
};

/**
 * The files of the diff list on screen, or null when no diff list is shown. The side menu and
 * the list are in separate trees under the app shell, so the list publishes its files here
 * while it is mounted instead of the menu reaching into the browser route. A long change set
 * can then be navigated by name without scrolling past every patch.
 */
export const changedFilesOutlineAtom = atom<ChangedFilesOutlineSnapshot | null>(
    null,
);
