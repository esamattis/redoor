import { diffArrays } from "diff";
import type { GitFileBasesResponse } from "#bindings/GitFileBasesResponse";

/** A run of differing lines between two line lists, both sides counted from zero. */
export type LineHunk = {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
};

/**
 * The texts a buffer is compared with, prepared once per answer so typing only diffs the
 * buffer against the index.
 */
export type GitLineBases = {
    /** The staged lines, which unstaged changes are measured from. */
    index: readonly string[];
    /** What is staged: HEAD compared with the index, in index line numbers. */
    staged: readonly LineHunk[];
};

/**
 * What the gutter shows for one buffer: nothing at all outside a repository, an empty gutter
 * while the bases load or when the file cannot be compared (so the text does not shift when
 * marks arrive), or the marks against the bases.
 */
export type GitGutterSource =
    | { kind: "hidden" }
    | { kind: "empty" }
    | { kind: "bases"; bases: GitLineBases };

/** The one hidden source, because the workspace tells sources apart by identity. */
export const GIT_GUTTER_HIDDEN: GitGutterSource = { kind: "hidden" };

/** The one empty source, for the same reason. */
export const GIT_GUTTER_EMPTY: GitGutterSource = { kind: "empty" };

/**
 * How a line differs. A deletion has no line of its own, so it marks the line after it, or
 * the last line when the deleted lines were at the end.
 */
export type GitLineChange =
    "added" | "modified" | "deleted_above" | "deleted_below";

/** One marked line, counted from zero. */
export type GitLineMark = {
    line: number;
    change: GitLineChange;
    /** True when the change is staged, false when it is only in the buffer or worktree. */
    staged: boolean;
};

/**
 * Edit distance past which the line diff gives up and marks the whole differing middle as
 * one change. Myers' algorithm costs time proportional to the file length times this, and a
 * rewritten file is still shown as changed, just less precisely.
 */
const MAX_EDIT_LENGTH = 1000;

/** Upper bound on one diff, so a pathological file cannot freeze typing. */
const DIFF_TIMEOUT_MS = 100;

/** Splits text into lines the way CodeMirror does, so both sides number lines alike. */
export function splitLines(text: string): string[] {
    return text.split(/\r\n?|\n/);
}

/**
 * Turns the agent's answer into what the gutter shows. Files Git ignores or that left the
 * repository get no gutter; files that cannot be compared keep an empty one.
 */
export function gitGutterSource(
    response: GitFileBasesResponse,
): GitGutterSource {
    switch (response.status) {
        case "outside_worktree":
        case "ignored":
            return GIT_GUTTER_HIDDEN;
        case "conflicted":
        case "too_large":
        case "unsupported":
            return GIT_GUTTER_EMPTY;
        case "bases": {
            // A missing index entry (untracked file) makes every buffer line count as added.
            const index =
                response.index === null ? [] : splitLines(response.index);

            const head =
                response.head.type === "text"
                    ? splitLines(response.head.content)
                    : response.head.type === "missing"
                      ? []
                      : null;

            return {
                kind: "bases",
                bases: {
                    index,
                    staged: head === null ? [] : lineHunks(head, index),
                },
            };
        }
    }
}

/**
 * Diffs two line lists. The common head and tail are skipped first, which is all an edit in
 * one place needs, and only the differing middle goes through Myers' algorithm, with lines
 * interned as numbers so comparisons are cheap.
 */
export function lineHunks(
    oldLines: readonly string[],
    newLines: readonly string[],
): LineHunk[] {
    const shorter = Math.min(oldLines.length, newLines.length);
    let prefix = 0;

    while (prefix < shorter && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }

    let suffix = 0;

    while (
        suffix < shorter - prefix &&
        oldLines[oldLines.length - 1 - suffix] ===
            newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }

    const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
    const newMiddle = newLines.slice(prefix, newLines.length - suffix);

    const whole: LineHunk = {
        oldStart: prefix,
        oldCount: oldMiddle.length,
        newStart: prefix,
        newCount: newMiddle.length,
    };

    if (oldMiddle.length === 0 && newMiddle.length === 0) {
        return [];
    }

    if (oldMiddle.length === 0 || newMiddle.length === 0) {
        return [whole];
    }

    const ids = new Map<string, number>();

    const intern = (line: string) => {
        let id = ids.get(line);

        if (id === undefined) {
            id = ids.size;
            ids.set(line, id);
        }

        return id;
    };

    const changes = diffArrays(oldMiddle.map(intern), newMiddle.map(intern), {
        maxEditLength: MAX_EDIT_LENGTH,
        timeout: DIFF_TIMEOUT_MS,
    });

    if (changes === undefined) {
        return [whole];
    }

    const hunks: LineHunk[] = [];
    let oldPosition = prefix;
    let newPosition = prefix;
    let open: LineHunk | null = null;

    for (const change of changes) {
        if (!change.added && !change.removed) {
            open = null;
            oldPosition += change.count;
            newPosition += change.count;
            continue;
        }

        if (open === null) {
            open = {
                oldStart: oldPosition,
                oldCount: 0,
                newStart: newPosition,
                newCount: 0,
            };
            hunks.push(open);
        }

        if (change.removed) {
            open.oldCount += change.count;
            oldPosition += change.count;
        } else {
            open.newCount += change.count;
            newPosition += change.count;
        }
    }

    return hunks;
}

/**
 * Follows index lines into the buffer through the unstaged hunks. Lines must be asked for in
 * ascending order, which lets one pass over the hunks serve every staged change.
 */
class IndexLineMapper {
    private next = 0;
    private shift = 0;

    /** Starts before the first unstaged hunk. */
    constructor(private readonly unstaged: readonly LineHunk[]) {}

    /** The buffer line showing index line `line`, or null when the buffer changed it. */
    map(line: number): number | null {
        let hunk = this.unstaged[this.next];

        // Hunks wholly before the line, including insertions right before it, shift it.
        while (hunk !== undefined && hunk.oldStart + hunk.oldCount <= line) {
            this.shift += hunk.newCount - hunk.oldCount;
            this.next++;
            hunk = this.unstaged[this.next];
        }

        if (hunk !== undefined && hunk.oldStart <= line) {
            return null;
        }

        return line + this.shift;
    }
}

/** Where a deletion before line `start` is shown in a list of `lineCount` lines. */
function deletionMark(
    start: number,
    lineCount: number,
): Pick<GitLineMark, "line" | "change"> {
    return start < lineCount
        ? { line: start, change: "deleted_above" }
        : { line: Math.max(lineCount - 1, 0), change: "deleted_below" };
}

/** Whether a mark of this kind wins over another on the same line: own changes first. */
function outranks(mark: GitLineMark, other: GitLineMark): boolean {
    const rank = (candidate: GitLineMark) =>
        (candidate.change === "added" || candidate.change === "modified"
            ? 0
            : 2) + (candidate.staged ? 1 : 0);

    return rank(mark) < rank(other);
}

/**
 * Marks the buffer's lines. Unstaged changes come from comparing the buffer with the index.
 * Staged changes are HEAD compared with the index, carried onto the buffer lines that still
 * show those index lines. A line keeps one mark, its own unstaged change winning, because the
 * gutter is too thin for two.
 */
export function gitLineMarks(
    lines: readonly string[],
    bases: GitLineBases,
): GitLineMark[] {
    const marks = new Map<number, GitLineMark>();

    const add = (mark: GitLineMark) => {
        const current = marks.get(mark.line);

        if (current === undefined || outranks(mark, current)) {
            marks.set(mark.line, mark);
        }
    };

    const unstaged = lineHunks(bases.index, lines);

    for (const hunk of unstaged) {
        if (hunk.newCount === 0) {
            add({
                ...deletionMark(hunk.newStart, lines.length),
                staged: false,
            });
            continue;
        }

        for (
            let line = hunk.newStart;
            line < hunk.newStart + hunk.newCount;
            line++
        ) {
            add({
                line,
                change: hunk.oldCount === 0 ? "added" : "modified",
                staged: false,
            });
        }
    }

    const mapper = new IndexLineMapper(unstaged);

    for (const hunk of bases.staged) {
        if (hunk.newCount === 0) {
            if (hunk.newStart >= bases.index.length) {
                add({
                    ...deletionMark(lines.length, lines.length),
                    staged: true,
                });
                continue;
            }

            const line = mapper.map(hunk.newStart);

            if (line !== null) {
                add({ line, change: "deleted_above", staged: true });
            }

            continue;
        }

        for (
            let indexLine = hunk.newStart;
            indexLine < hunk.newStart + hunk.newCount;
            indexLine++
        ) {
            const line = mapper.map(indexLine);

            if (line !== null) {
                add({
                    line,
                    change: hunk.oldCount === 0 ? "added" : "modified",
                    staged: true,
                });
            }
        }
    }

    return [...marks.values()].sort((a, b) => a.line - b.line);
}
