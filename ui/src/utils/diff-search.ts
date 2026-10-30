/*
 * Finding text in parsed diffs. The search reads the parsed rows instead of the page, so it
 * also finds text in collapsed files, folded lines and patches that have never been rendered,
 * which the browser's own find in page cannot see.
 */
import type { DiffFile, DiffLine } from "#ui/utils/diff-parse";

/**
 * The most matches one search collects. A one-letter query in a large change set can match
 * hundreds of thousands of times, and every match costs a highlight range on screen, while a
 * reader only ever steps through the first few.
 */
export const MAX_DIFF_SEARCH_MATCHES = 10_000;

/** One file of a diff list, parsed the same way its card renders it. */
export interface DiffSearchFile {
    /** The card's path, which identifies the file in the list. */
    path: string;
    /** The files of the card's patch; a Git file's patch normally holds one. */
    diffFiles: DiffFile[];
}

/**
 * Where a match sits: the card, the file of its patch, the hunk or fold, the row in it and
 * the characters of the row's text. Rows are the parser's, so a fold's row is found by its
 * position among the fold's lines whether or not it is revealed.
 */
export interface DiffSearchMatch {
    path: string;
    diffIndex: number;
    hunkIndex: number;
    lineIndex: number;
    start: number;
    end: number;
}

/** The outcome of one search, in the order the rows appear on the page. */
export interface DiffSearchResult {
    matches: DiffSearchMatch[];
    /** Whether matches beyond `MAX_DIFF_SEARCH_MATCHES` were left out. */
    truncated: boolean;
}

/** How much of one fold is revealed from its top and from its bottom. */
export interface FoldReveal {
    fromTop: number;
    fromBottom: number;
}

/** Unchanged lines revealed around a match in a fold, so it is not shown out of context. */
const REVEAL_CONTEXT_LINES = 3;

/**
 * The text a row shows. A modified row shows its deleted and inserted words side by side, so
 * its text is every segment in order, which is what the reader sees and searches for.
 */
export function diffLineText(line: DiffLine): string {
    return line.segments.map((segment) => segment.value).join("");
}

/**
 * Identifies a rendered row within its card, so the search can find the row of a match in
 * the page. The view writes it on every row it renders.
 */
export function diffRowKey(
    diffIndex: number,
    hunkIndex: number,
    lineIndex: number,
): string {
    return `${String(diffIndex)}:${String(hunkIndex)}:${String(lineIndex)}`;
}

/** Identifies a match, so the current match can be found again in a newer result. */
export function diffMatchKey(match: DiffSearchMatch): string {
    return JSON.stringify([
        match.path,
        match.diffIndex,
        match.hunkIndex,
        match.lineIndex,
        match.start,
    ]);
}

/** Escapes a query so it matches literally, since readers search for code, not patterns. */
function literalPattern(query: string): RegExp {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/**
 * Finds every case-insensitive occurrence of `query` in the rows of the files, including the
 * folded rows a patch carries. Matches never span rows, since a diff row is the unit a reader
 * scans. A regular expression finds them, rather than comparing lowercased text, because
 * lowercasing can change a string's length and would shift the offsets.
 */
export function findDiffMatches(
    files: DiffSearchFile[],
    query: string,
): DiffSearchResult {
    const matches: DiffSearchMatch[] = [];

    if (query === "") {
        return { matches, truncated: false };
    }

    const pattern = literalPattern(query);

    for (const file of files) {
        for (const [diffIndex, diffFile] of file.diffFiles.entries()) {
            for (const [hunkIndex, hunk] of diffFile.hunks.entries()) {
                // A fold the patch left without its lines has nothing to search.
                if (hunk.lines === null) {
                    continue;
                }

                for (const [lineIndex, line] of hunk.lines.entries()) {
                    for (const found of diffLineText(line).matchAll(pattern)) {
                        if (matches.length === MAX_DIFF_SEARCH_MATCHES) {
                            return { matches, truncated: true };
                        }

                        matches.push({
                            path: file.path,
                            diffIndex,
                            hunkIndex,
                            lineIndex,
                            start: found.index,
                            end: found.index + found[0].length,
                        });
                    }
                }
            }
        }
    }

    return { matches, truncated: false };
}

/**
 * How far a fold must be revealed to show one of its lines, or null when the line already
 * shows. It reveals from whichever end is closer, so a match deep in a long fold does not
 * open every line above it, and keeps a few lines of context past the match.
 */
export function foldRevealFor(
    lineCount: number,
    reveal: FoldReveal,
    lineIndex: number,
): FoldReveal | null {
    const hiddenEnd = lineCount - reveal.fromBottom;

    if (lineIndex < reveal.fromTop || lineIndex >= hiddenEnd) {
        return null;
    }

    if (lineIndex - reveal.fromTop <= hiddenEnd - 1 - lineIndex) {
        return {
            fromTop: Math.min(hiddenEnd, lineIndex + 1 + REVEAL_CONTEXT_LINES),
            fromBottom: reveal.fromBottom,
        };
    }

    return {
        fromTop: reveal.fromTop,
        fromBottom: Math.min(
            lineCount - reveal.fromTop,
            lineCount - lineIndex + REVEAL_CONTEXT_LINES,
        ),
    };
}
