/*
 * Which folded lines of a diff are revealed, by the reader or by the diff search stepping to a
 * match inside a fold.
 */
import React from "react";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import { useDiffSearchTarget } from "#ui/components/browser/diff-search";
import type { DiffFile } from "#ui/utils/diff-parse";
import { foldRevealFor, type FoldReveal } from "#ui/utils/diff-search";

const NOTHING_REVEALED: FoldReveal = { fromTop: 0, fromBottom: 0 };

/** How far each fold is revealed, by fold index, for every file a history entry showed. */
type FoldRevealsByFile = ReadonlyMap<string, ReadonlyMap<number, FoldReveal>>;

const foldRevealStates = new HistoryEntryStore<FoldRevealsByFile>();

/**
 * Remembers how far each fold of a file is revealed. The folds are identified by the file's
 * paths and hunk layout rather than the parsed object, so switching the inline layout, which
 * parses the patch again, keeps what the reader opened, while a patch whose hunks moved starts
 * over. Every file of a history entry shares one stored map, because a store keeps a bounded
 * number of values and a long diff list would otherwise push out other entries' state. It is
 * kept per history entry because revealed lines change the list's height, which the restored
 * scroll position depends on when the reader comes back from a file.
 */
export function useFoldReveals(file: DiffFile) {
    const fileKey = React.useMemo(
        () =>
            JSON.stringify([
                file.oldPath,
                file.newPath,
                file.hunks.map((hunk) =>
                    hunk.type === "hunk" ? hunk.header : String(hunk.count),
                ),
            ]),
        [file],
    );

    const [revealsByFile, update] = useHistoryEntryState<FoldRevealsByFile>({
        store: foldRevealStates,
        // One scope for the whole entry, since the file key already tells the files apart.
        scope: "diff-folds",
        initial: () => new Map(),
    });

    const reveals = revealsByFile.get(fileKey);

    // Stable while nothing changes, so the search's reveal effect runs only when it must.
    const get = React.useCallback(
        (index: number) => reveals?.get(index) ?? NOTHING_REVEALED,
        [reveals],
    );

    const set = React.useCallback(
        (index: number, reveal: FoldReveal) =>
            update((previous) =>
                new Map(previous).set(
                    fileKey,
                    new Map(previous.get(fileKey)).set(index, reveal),
                ),
            ),
        [update, fileKey],
    );

    return { get, set };
}

/**
 * Reveals the fold line the diff search's current match is on, so stepping to a match in a
 * folded stretch shows it. The reveal is stored like one the reader made, so the fold stays
 * open after the search moves on and the page does not jump back.
 */
export function useRevealSearchTarget(options: {
    file: DiffFile;
    diffIndex: number;
    wholeFile: boolean;
    reveals: ReturnType<typeof useFoldReveals>;
}) {
    const target = useDiffSearchTarget(options.diffIndex);
    const hunks = options.file.hunks;
    const wholeFile = options.wholeFile;
    const getReveal = options.reveals.get;
    const setReveal = options.reveals.set;

    React.useEffect(() => {
        if (target === null || wholeFile) {
            return;
        }

        const hunk = hunks[target.hunkIndex];

        if (hunk?.type !== "skip" || hunk.lines === null) {
            return;
        }

        const reveal = foldRevealFor(
            hunk.lines.length,
            getReveal(target.hunkIndex),
            target.lineIndex,
        );

        if (reveal !== null) {
            setReveal(target.hunkIndex, reveal);
        }
    }, [target, hunks, wholeFile, getReveal, setReveal]);
}
