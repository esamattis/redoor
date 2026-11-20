/*
 * Finding text in parsed diffs. The search reads the parsed rows instead of the page, so it
 * also finds text in collapsed files and patches that have never been rendered, which the
 * browser's own find in page cannot see. It searches only the changed hunks, never the folded
 * unchanged lines between them, because a reader searches the changes they review, and
 * matches in surrounding context would bury them.
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
 * Where a match sits: the card, the file of its patch, the hunk, the row in it and the
 * characters of the row's text.
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
 * Finds every case-insensitive occurrence of `query` in the rows of the files' changed hunks.
 * Matches never span rows, since a diff row is the unit a reader
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
                // Folds hold unchanged context, not the changes being searched.
                if (hunk.type === "skip") {
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
