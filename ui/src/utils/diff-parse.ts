/*
 * Unified diff parsing for the diff viewer.
 *
 * The pairing of similar deleted and inserted lines into one "modified" row with inline word
 * and character changes is ported from the MIT-licensed diff viewer by Fredrika Lindh
 * (https://github.com/fredrikalindh/ui, registry/ui/diff/utils/parse.ts).
 *
 * The original reads patches with gitdiff-parser. That parser only recognises patches that
 * start with a `diff --git` line, strips two characters from every path and reads an explicit
 * `,0` hunk length as one line. Every patch redoor renders comes from the `similar` crate,
 * which writes bare `---`/`+++` headers (absolute paths for Sync), so a small tolerant reader
 * lives here instead.
 */
import { diffChars, diffWordsWithSpace } from "diff";

/** A run of a line's text and whether it was added, removed or kept. */
export interface LineSegment {
    value: string;
    type: "insert" | "delete" | "normal";
}

/**
 * One rendered row. A "modified" row is a deleted and an inserted line that were similar
 * enough to show as one row, so it carries both line numbers and its segments hold the text
 * of both sides: normal and delete segments spell the old line, normal and insert segments
 * the new one.
 */
export interface DiffLine {
    kind: "normal" | "insert" | "delete" | "modified";
    /** The line in the old file, absent for inserted lines. */
    oldLineNumber: number | null;
    /** The line in the new file, absent for deleted lines. */
    newLineNumber: number | null;
    segments: LineSegment[];
    /** Git's "\ No newline at end of file" followed this line on at least one side. */
    missingNewline: boolean;
}

/** One `@@` hunk with its lines already paired. */
export interface DiffHunk {
    type: "hunk";
    /** The `@@ -a,b +c,d @@` header, kept for keys and for skip-block context. */
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

/** The unchanged lines between two hunks, which the view folds away. */
export interface SkipBlock {
    type: "skip";
    count: number;
    /** The function or section name Git prints after the next hunk's header. */
    content: string;
    /**
     * The folded rows when the patch carried every unchanged line, so the view can reveal
     * them without asking the server again; null when the patch left them out.
     */
    lines: DiffLine[] | null;
}

/** How the patch changed the file as a whole. */
export type DiffFileType = "add" | "delete" | "modify" | "rename" | "copy";

/** One file of a patch. */
export interface DiffFile {
    /** Null when the file did not exist before, as `/dev/null` says in Git patches. */
    oldPath: string | null;
    /** Null when the file no longer exists, as `/dev/null` says in Git patches. */
    newPath: string | null;
    type: DiffFileType;
    isBinary: boolean;
    hunks: Array<DiffHunk | SkipBlock>;
}

/**
 * How a patch is read: mostly tuning for pairing deleted and inserted lines. The defaults are
 * what the viewer uses, except that `mergeModifiedLines` and `fullContext` follow the reader's
 * preference and what the server sent.
 */
export interface ParseOptions {
    /**
     * Whether the patch holds every unchanged line of its files, so they fold to
     * `CONTEXT_LINES` around each change and stay expandable instead of being dropped.
     */
    fullContext: boolean;
    /** How many lines apart a deleted and an inserted line may be and still pair. */
    maxDiffDistance: number;
    /** The largest share of changed characters at which two lines still count as similar. */
    maxChangeRatio: number;
    /**
     * Whether a similar removed and added line show as one row. When off, every -/+ line
     * keeps its own row, but similar ones are still paired so their changed words stand out.
     */
    mergeModifiedLines: boolean;
    /** Replaced words differing by at most this many characters show a character diff. */
    inlineMaxCharEdits: number;
}

const DEFAULT_OPTIONS: ParseOptions = {
    fullContext: false,
    maxDiffDistance: 30,
    maxChangeRatio: 0.45,
    mergeModifiedLines: true,
    inlineMaxCharEdits: 4,
};

/**
 * Lines longer than this never pair. Word diffs of minified or generated lines are slow and
 * their inline result is unreadable anyway, so such lines stay plain deletes and inserts.
 */
const MAX_PAIRABLE_LINE_LENGTH = 1000;

/**
 * The unchanged lines kept around each change when a whole file is folded, matching what
 * `git diff` and the server send when a file is too large to send whole.
 */
const CONTEXT_LINES = 3;

/** A patch line as read, before similar deletes and inserts are paired. */
type RawChange =
    | {
          type: "insert";
          content: string;
          lineNumber: number;
          missingNewline: boolean;
      }
    | {
          type: "delete";
          content: string;
          lineNumber: number;
          missingNewline: boolean;
      }
    | {
          type: "normal";
          content: string;
          oldLineNumber: number;
          newLineNumber: number;
          missingNewline: boolean;
      };

type DeleteChange = Extract<RawChange, { type: "delete" }>;

type InsertChange = Extract<RawChange, { type: "insert" }>;

/** A hunk as read, before pairing. */
interface RawHunk {
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    context: string;
    changes: RawChange[];
}

/** A file as read, before pairing. `type` stays null until the headers say what happened. */
interface RawFile {
    oldPath: string | null;
    newPath: string | null;
    type: DiffFileType | null;
    isBinary: boolean;
    hunks: RawHunk[];
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Reads a `---`/`+++` path. Tools append a tab and a timestamp after the name, and Git writes
 * `/dev/null` for the missing side of an added or deleted file.
 */
function readHeaderPath(text: string): string | null {
    const tab = text.indexOf("\t");
    const path = tab === -1 ? text : text.slice(0, tab);

    return path === "/dev/null" ? null : path;
}

/**
 * Drops Git's `a/` and `b/` prefixes, but only when both sides carry them, so absolute paths
 * from a Sync comparison or a real directory named `a` stay untouched.
 */
function stripGitPrefixes(file: RawFile) {
    const oldOk = file.oldPath === null || file.oldPath.startsWith("a/");
    const newOk = file.newPath === null || file.newPath.startsWith("b/");

    if (!oldOk || !newOk || (file.oldPath === null && file.newPath === null)) {
        return;
    }

    file.oldPath = file.oldPath === null ? null : file.oldPath.slice(2);
    file.newPath = file.newPath === null ? null : file.newPath.slice(2);
}

/**
 * Settles what happened to a file once all its lines are read. Explicit Git headers win;
 * otherwise a hunk starting at line 0 on one side means that side was empty, which is how
 * `similar` writes added and deleted files without `/dev/null`.
 */
function resolveFileType(file: RawFile): DiffFileType {
    if (file.type !== null) {
        return file.type;
    }

    if (file.oldPath === null && file.newPath !== null) {
        return "add";
    }

    if (file.newPath === null && file.oldPath !== null) {
        return "delete";
    }

    const onlyHunk = file.hunks.length === 1 ? file.hunks[0] : undefined;

    if (onlyHunk?.oldStart === 0 && onlyHunk.oldLines === 0) {
        return "add";
    }

    if (onlyHunk?.newStart === 0 && onlyHunk.newLines === 0) {
        return "delete";
    }

    return "modify";
}

/**
 * Splits a patch into files and hunks. It accepts Git patches with or without `diff --git`
 * lines, and bare hunks without any file header, so every patch the server sends renders.
 */
function readPatch(patch: string): RawFile[] {
    const files: RawFile[] = [];
    const lines = patch.split("\n");

    // A patch ends with a newline, which would otherwise read as one more empty line.
    if (lines.at(-1) === "") {
        lines.pop();
    }

    let file: RawFile | null = null;
    let hunk: RawHunk | null = null;
    let oldLine = 0;
    let newLine = 0;
    let oldRemaining = 0;
    let newRemaining = 0;

    const startFile = (): RawFile => {
        const next: RawFile = {
            oldPath: null,
            newPath: null,
            type: null,
            isBinary: false,
            hunks: [],
        };

        files.push(next);
        hunk = null;

        return next;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";

        if (line.startsWith("\\")) {
            // "\ No newline at end of file" belongs to the line right before it.
            const last = hunk?.changes.at(-1);

            if (last !== undefined) {
                last.missingNewline = true;
            }

            continue;
        }

        if (hunk !== null && (oldRemaining > 0 || newRemaining > 0)) {
            // Some tools strip the space from an empty context line, so "" is context too.
            const marker = line === "" ? " " : line.charAt(0);
            const content = line.slice(1);

            if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
                hunk.changes.push({
                    type: "normal",
                    content,
                    oldLineNumber: oldLine++,
                    newLineNumber: newLine++,
                    missingNewline: false,
                });
                oldRemaining--;
                newRemaining--;
                continue;
            }

            if (marker === "-" && oldRemaining > 0) {
                hunk.changes.push({
                    type: "delete",
                    content,
                    lineNumber: oldLine++,
                    missingNewline: false,
                });
                oldRemaining--;
                continue;
            }

            if (marker === "+" && newRemaining > 0) {
                hunk.changes.push({
                    type: "insert",
                    content,
                    lineNumber: newLine++,
                    missingNewline: false,
                });
                newRemaining--;
                continue;
            }
        }

        if (line.startsWith("diff --git ")) {
            file = startFile();
            // The paths here are ambiguous with spaces; `---`/`+++` or rename lines refine them.
            const paths = /^diff --git (a\/.*) (b\/.*)$/.exec(line);
            file.oldPath = paths?.[1] ?? null;
            file.newPath = paths?.[2] ?? null;
            continue;
        }

        const nextLine = lines[index + 1];

        if (line.startsWith("--- ") && nextLine?.startsWith("+++ ") === true) {
            // A `---` header opens a new file unless a `diff --git` line just did.
            if (file === null || file.hunks.length > 0 || hunk !== null) {
                file = startFile();
            }

            file.oldPath = readHeaderPath(line.slice(4));
            file.newPath = readHeaderPath(nextLine.slice(4));
            index++;
            continue;
        }

        const header = HUNK_HEADER_REGEX.exec(line);

        if (header !== null) {
            file ??= startFile();
            // An omitted length means one line; an explicit 0 means an empty side.
            const oldStart = Number(header[1]);
            const oldLines = header[2] === undefined ? 1 : Number(header[2]);
            const newStart = Number(header[3]);
            const newLines = header[4] === undefined ? 1 : Number(header[4]);

            hunk = {
                header: line,
                oldStart,
                oldLines,
                newStart,
                newLines,
                context: (header[5] ?? "").trim(),
                changes: [],
            };
            file.hunks.push(hunk);
            oldLine = oldStart;
            newLine = newStart;
            oldRemaining = oldLines;
            newRemaining = newLines;
            continue;
        }

        if (file === null) {
            continue;
        }

        if (line.startsWith("new file mode")) {
            file.type = "add";
        } else if (line.startsWith("deleted file mode")) {
            file.type = "delete";
        } else if (line.startsWith("rename from ")) {
            file.type = "rename";
            file.oldPath = `a/${line.slice("rename from ".length)}`;
        } else if (line.startsWith("rename to ")) {
            file.type = "rename";
            file.newPath = `b/${line.slice("rename to ".length)}`;
        } else if (line.startsWith("copy from ")) {
            file.type = "copy";
            file.oldPath = `a/${line.slice("copy from ".length)}`;
        } else if (line.startsWith("copy to ")) {
            file.type = "copy";
            file.newPath = `b/${line.slice("copy to ".length)}`;
        } else if (
            line.startsWith("Binary files ") ||
            line === "GIT binary patch"
        ) {
            file.isBinary = true;
        }
    }

    for (const each of files) {
        stripGitPrefixes(each);
    }

    return files;
}

/**
 * Splits a word diff into segments. Whitespace counts as words, because the plain word diff
 * reports whitespace-only edits as unchanged and copies the new line's spacing into common
 * text, which would hide the change and break rebuilding the old line from the segments.
 */
function wordSegments(a: string, b: string): LineSegment[] {
    return diffWordsWithSpace(a, b).map((token) => ({
        value: token.value,
        type: token.added ? "insert" : token.removed ? "delete" : "normal",
    }));
}

/**
 * The share of both lines' characters that a word diff marks as changed. Lines longer than
 * the pairing limit, or whose length difference alone exceeds `maxChangeRatio`, return
 * Infinity without running the costly word diff, because a length difference must be
 * inserted or deleted and so bounds the ratio from below.
 */
function calculateChangeRatio(
    a: string,
    b: string,
    maxChangeRatio: number,
): number {
    const totalChars = a.length + b.length;

    if (totalChars === 0) {
        return 1;
    }

    if (
        a.length > MAX_PAIRABLE_LINE_LENGTH ||
        b.length > MAX_PAIRABLE_LINE_LENGTH ||
        Math.abs(a.length - b.length) / totalChars > maxChangeRatio
    ) {
        return Infinity;
    }

    const changedChars = wordSegments(a, b)
        .filter((segment) => segment.type !== "normal")
        .reduce((sum, segment) => sum + segment.value.length, 0);

    return changedChars / totalChars;
}

/** Decides whether two lines are close enough to read as one edited line. */
function isSimilarEnough(
    a: string,
    b: string,
    maxChangeRatio: number,
): boolean {
    if (maxChangeRatio <= 0) {
        return a === b;
    }

    if (maxChangeRatio >= 1) {
        return true;
    }

    return calculateChangeRatio(a, b, maxChangeRatio) <= maxChangeRatio;
}

/** Turns an unpaired patch line into a row of a single segment. */
function changeToLine(change: RawChange): DiffLine {
    const segments: LineSegment[] = [{ value: change.content, type: "normal" }];

    switch (change.type) {
        case "normal":
            return {
                kind: "normal",
                oldLineNumber: change.oldLineNumber,
                newLineNumber: change.newLineNumber,
                segments,
                missingNewline: change.missingNewline,
            };
        case "delete":
            return {
                kind: "delete",
                oldLineNumber: change.lineNumber,
                newLineNumber: null,
                segments,
                missingNewline: change.missingNewline,
            };
        case "insert":
            return {
                kind: "insert",
                oldLineNumber: null,
                newLineNumber: change.lineNumber,
                segments,
                missingNewline: change.missingNewline,
            };
    }
}

/**
 * Character-diffs a replaced word when only a few characters changed, so a renamed
 * identifier such as `count` to `counts` highlights the `s`, not the whole word.
 */
function diffCharsIfWithinEditLimit(
    a: string,
    b: string,
    maxEdits: number,
): LineSegment[] | null {
    const diffs = diffChars(a, b);
    let edits = 0;

    for (const part of diffs) {
        if (part.added || part.removed) {
            edits += part.value.length;

            if (edits > maxEdits) {
                return null;
            }
        }
    }

    return diffs.map((part) => ({
        value: part.value,
        type: part.added ? "insert" : part.removed ? "delete" : "normal",
    }));
}

/** Builds a modified row's segments: a word diff, refined to characters for small edits. */
function buildInlineDiffSegments(
    oldContent: string,
    newContent: string,
    options: ParseOptions,
): LineSegment[] {
    const segments = wordSegments(oldContent, newContent);
    const result: LineSegment[] = [];

    const mergeIntoResult = (segment: LineSegment) => {
        const last = result.at(-1);

        if (last !== undefined && last.type === segment.type) {
            last.value += segment.value;
        } else {
            result.push({ ...segment });
        }
    };

    for (let index = 0; index < segments.length; index++) {
        const current = segments[index];
        const next = segments[index + 1];

        if (current === undefined) {
            continue;
        }

        if (current.type === "delete" && next?.type === "insert") {
            const charDiff = diffCharsIfWithinEditLimit(
                current.value,
                next.value,
                options.inlineMaxCharEdits,
            );

            if (charDiff !== null) {
                charDiff.forEach(mergeIntoResult);
                index++;
                continue;
            }
        }

        mergeIntoResult(current);
    }

    return result;
}

/** The row for a deleted and an inserted line that read as one edit. */
function modifiedLine(
    del: DeleteChange,
    add: InsertChange,
    options: ParseOptions,
): DiffLine {
    return {
        kind: "modified",
        oldLineNumber: del.lineNumber,
        newLineNumber: add.lineNumber,
        segments: buildInlineDiffSegments(del.content, add.content, options),
        missingNewline: del.missingNewline || add.missingNewline,
    };
}

/**
 * A paired line on its own -/+ row. Its segments are one side of the pair's word diff, so
 * only the words that differ from the other line are marked.
 */
function separateLine(
    change: DeleteChange | InsertChange,
    pairSegments: LineSegment[],
): DiffLine {
    const skipped = change.type === "delete" ? "insert" : "delete";
    const segments: LineSegment[] = [];

    for (const segment of pairSegments) {
        if (segment.type === skipped) {
            continue;
        }

        const last = segments.at(-1);

        // Dropping the other side leaves kept text next to kept text, which reads as one run.
        if (last !== undefined && last.type === segment.type) {
            last.value += segment.value;
        } else {
            segments.push({ ...segment });
        }
    }

    return { ...changeToLine(change), segments };
}

/** Pairs only directly adjacent delete/insert lines, for a distance of one. */
function mergeAdjacentLines(
    changes: RawChange[],
    options: ParseOptions,
): DiffLine[] {
    const out: DiffLine[] = [];

    for (let index = 0; index < changes.length; index++) {
        const current = changes[index];
        const next = changes[index + 1];

        if (current === undefined) {
            continue;
        }

        if (
            current.type === "delete" &&
            next?.type === "insert" &&
            isSimilarEnough(
                current.content,
                next.content,
                options.maxChangeRatio,
            )
        ) {
            out.push(modifiedLine(current, next, options));
            index++;
        } else {
            out.push(changeToLine(current));
        }
    }

    return out;
}

const UNPAIRED = -1;

/**
 * Pairs similar deletes and inserts of one hunk anywhere within the distance limit. The
 * pairing tables are shared by every step, so they live on one object instead of being
 * threaded through each function.
 */
class HunkPairing {
    private readonly changes: RawChange[];
    private readonly options: ParseOptions;
    /** For each delete, the index of its paired insert, or UNPAIRED. */
    private readonly pairOfDel: Int32Array;
    /** For each insert, the index of its paired delete, or UNPAIRED. */
    private readonly pairOfAdd: Int32Array;
    /** The inserts in patch order, so pairing scans only those. */
    private readonly insertIdxs: number[] = [];
    /** Unpaired deletes before each index, to ask "any between these two?" in O(1). */
    private readonly unpairedDelPrefix: Int32Array;

    constructor(changes: RawChange[], options: ParseOptions) {
        this.changes = changes;
        this.options = options;
        this.pairOfDel = new Int32Array(changes.length).fill(UNPAIRED);
        this.pairOfAdd = new Int32Array(changes.length).fill(UNPAIRED);

        changes.forEach((change, index) => {
            if (change.type === "insert") {
                this.insertIdxs.push(index);
            }
        });

        this.pairGreedily();
        this.unpairedDelPrefix = this.buildUnpairedDeletePrefix();
    }

    /** Finds the most similar still-unpaired insert near a delete, or UNPAIRED. */
    private findBestInsertForDelete(del: DeleteChange): number {
        const lower = del.lineNumber - this.options.maxDiffDistance;
        const upper = del.lineNumber + this.options.maxDiffDistance;
        let bestAddIdx = UNPAIRED;
        let bestRatio = Infinity;

        for (const addIdx of this.insertIdxs) {
            const add = this.changes[addIdx];

            if (add?.type !== "insert" || this.pairOfAdd[addIdx] !== UNPAIRED) {
                continue;
            }

            if (add.lineNumber < lower) {
                continue;
            }

            if (add.lineNumber > upper) {
                break;
            }

            const ratio = calculateChangeRatio(
                del.content,
                add.content,
                this.options.maxChangeRatio,
            );

            if (ratio <= this.options.maxChangeRatio && ratio < bestRatio) {
                bestRatio = ratio;
                bestAddIdx = addIdx;
            }
        }

        return bestAddIdx;
    }

    /** Greedily pairs every delete with its best insert, in patch order. */
    private pairGreedily() {
        this.changes.forEach((change, deleteIdx) => {
            if (change.type !== "delete") {
                return;
            }

            const bestAddIdx = this.findBestInsertForDelete(change);

            if (bestAddIdx !== UNPAIRED) {
                this.pairOfDel[deleteIdx] = bestAddIdx;
                this.pairOfAdd[bestAddIdx] = deleteIdx;
            }
        });
    }

    /** Counts the deletes left unpaired up to each index. */
    private buildUnpairedDeletePrefix() {
        const prefix = new Int32Array(this.changes.length + 1);

        this.changes.forEach((change, index) => {
            const unpairedDelete =
                change.type === "delete" && this.pairOfDel[index] === UNPAIRED;

            prefix[index + 1] = (prefix[index] ?? 0) + (unpairedDelete ? 1 : 0);
        });

        return prefix;
    }

    /**
     * A paired delete is shown at its insert's position. If an unpaired delete sits between
     * them, moving the delete down would reorder the old file's lines, so the pair is dropped.
     */
    private hasUnpairedDeleteBetween(deleteIdx: number, insertIdx: number) {
        const lower = Math.max(0, deleteIdx);
        const upper = Math.max(lower, insertIdx);
        const prefix = this.unpairedDelPrefix;

        return (prefix[upper] ?? 0) - (prefix[lower] ?? 0) > 0;
    }

    /**
     * Emits every change as its own row in patch order, marking the changed words of paired
     * lines. Nothing moves, so pairs need none of the reordering checks of `lines()`.
     */
    separateLines(): DiffLine[] {
        /** Each pair's word diff by its delete's index, so both rows share one diff. */
        const pairSegments = new Map<number, LineSegment[]>();

        const segmentsOf = (
            del: DeleteChange,
            add: InsertChange,
            delIdx: number,
        ) => {
            let segments = pairSegments.get(delIdx);

            if (segments === undefined) {
                segments = buildInlineDiffSegments(
                    del.content,
                    add.content,
                    this.options,
                );
                pairSegments.set(delIdx, segments);
            }

            return segments;
        };

        return this.changes.map((change, index) => {
            if (change.type === "delete") {
                const addIdx = this.pairOfDel[index] ?? UNPAIRED;
                const add = this.changes[addIdx];

                return add?.type === "insert"
                    ? separateLine(change, segmentsOf(change, add, index))
                    : changeToLine(change);
            }

            if (change.type === "insert") {
                const delIdx = this.pairOfAdd[index] ?? UNPAIRED;
                const del = this.changes[delIdx];

                return del?.type === "delete"
                    ? separateLine(change, segmentsOf(del, change, delIdx))
                    : changeToLine(change);
            }

            return changeToLine(change);
        });
    }

    /** Emits rows in patch order, placing each modified row where its insert was. */
    lines(): DiffLine[] {
        const out: DiffLine[] = [];
        const processed = new Uint8Array(this.changes.length);

        this.changes.forEach((change, index) => {
            if (processed[index] === 1) {
                return;
            }

            processed[index] = 1;

            if (change.type === "normal") {
                out.push(changeToLine(change));

                return;
            }

            if (change.type === "delete") {
                const pairedAddIdx = this.pairOfDel[index] ?? UNPAIRED;
                const add = this.changes[pairedAddIdx];

                if (pairedAddIdx === UNPAIRED || add?.type !== "insert") {
                    out.push(changeToLine(change));
                } else if (pairedAddIdx > index) {
                    if (
                        this.hasUnpairedDeleteBetween(index + 1, pairedAddIdx)
                    ) {
                        this.pairOfAdd[pairedAddIdx] = UNPAIRED;
                        out.push(changeToLine(change));
                    }
                    // Otherwise the paired insert emits the modified row.
                } else {
                    out.push(modifiedLine(change, add, this.options));
                    processed[pairedAddIdx] = 1;
                }

                return;
            }

            const pairedDelIdx = this.pairOfAdd[index] ?? UNPAIRED;
            const del = this.changes[pairedDelIdx];

            if (pairedDelIdx === UNPAIRED || del?.type !== "delete") {
                out.push(changeToLine(change));
            } else {
                out.push(modifiedLine(del, change, this.options));
                processed[pairedDelIdx] = 1;
            }
        });

        return out;
    }
}

/** Turns a read hunk into rows, paired or plain depending on the options. */
function parseHunk(hunk: RawHunk, options: ParseOptions): DiffHunk {
    const lines = !options.mergeModifiedLines
        ? new HunkPairing(hunk.changes, options).separateLines()
        : options.maxDiffDistance === 1
          ? mergeAdjacentLines(hunk.changes, options)
          : new HunkPairing(hunk.changes, options).lines();

    return {
        type: "hunk",
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
    };
}

/** Folds a run of a hunk's unchanged lines into an expandable skip block. */
function foldedBlock(changes: RawChange[]): SkipBlock {
    return {
        type: "skip",
        count: changes.length,
        content: "",
        lines: changes.map(changeToLine),
    };
}

/**
 * The stretches of a hunk to show, as [start, end) change indexes: every change with
 * `CONTEXT_LINES` around it. A gap of a single line stays visible, because a row saying one
 * line is hidden takes as much room as the line.
 */
function visibleRanges(changes: RawChange[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];

    changes.forEach((change, index) => {
        if (change.type === "normal") {
            return;
        }

        const start = Math.max(0, index - CONTEXT_LINES);
        const end = Math.min(changes.length, index + 1 + CONTEXT_LINES);
        const last = ranges.at(-1);

        if (last !== undefined && start - last[1] <= 1) {
            last[1] = end;
        } else {
            ranges.push([start, end]);
        }
    });

    const first = ranges.at(0);
    const last = ranges.at(-1);

    if (first !== undefined && first[0] <= 1) {
        first[0] = 0;
    }

    if (last !== undefined && changes.length - last[1] <= 1) {
        last[1] = changes.length;
    }

    return ranges;
}

/**
 * Splits a hunk that carries its whole file into the hunks a default-context patch would
 * have, with the unchanged lines between them kept as expandable skip blocks. Similar lines
 * pair within each visible hunk only, as they would in a default-context patch, so revealing
 * unchanged lines never changes how edits pair.
 */
function foldHunk(
    hunk: RawHunk,
    options: ParseOptions,
): Array<DiffHunk | SkipBlock> {
    const ranges = visibleRanges(hunk.changes);

    if (ranges.length === 0) {
        return [parseHunk(hunk, options)];
    }

    // Where each change sits in the old and new file, so a visible stretch knows its start.
    const oldLineAt: number[] = [];
    const newLineAt: number[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const change of hunk.changes) {
        oldLineAt.push(oldLine);
        newLineAt.push(newLine);
        oldLine += change.type === "insert" ? 0 : 1;
        newLine += change.type === "delete" ? 0 : 1;
    }

    const result: Array<DiffHunk | SkipBlock> = [];
    let position = 0;

    for (const [start, end] of ranges) {
        if (start > position) {
            result.push(foldedBlock(hunk.changes.slice(position, start)));
        }

        const changes = hunk.changes.slice(start, end);
        const oldStart = oldLineAt[start] ?? hunk.oldStart;
        const newStart = newLineAt[start] ?? hunk.newStart;
        const oldLines = changes.filter((c) => c.type !== "insert").length;
        const newLines = changes.filter((c) => c.type !== "delete").length;

        result.push(
            parseHunk(
                {
                    header: `@@ -${String(oldStart)},${String(oldLines)} +${String(newStart)},${String(newLines)} @@`,
                    oldStart,
                    oldLines,
                    newStart,
                    newLines,
                    context: "",
                    changes,
                },
                options,
            ),
        );
        position = end;
    }

    if (position < hunk.changes.length) {
        result.push(foldedBlock(hunk.changes.slice(position)));
    }

    return result;
}

/**
 * Marks the unchanged stretches the patch skipped, so a gap is never silent. A patch that
 * carries whole files has one hunk per file, which folds into hunks and expandable blocks.
 */
function insertSkipBlocks(hunks: RawHunk[], options: ParseOptions) {
    const result: Array<DiffHunk | SkipBlock> = [];
    let lastHunkLine = 1;

    for (const hunk of hunks) {
        // An added file's hunk starts at old line 0, so nothing came before it.
        const hunkStart = Math.max(hunk.oldStart, 1);
        const distanceToLastHunk = hunkStart - lastHunkLine;

        if (hunk.oldLines > 0 && distanceToLastHunk > 0) {
            result.push({
                type: "skip",
                count: distanceToLastHunk,
                content: hunk.context,
                lines: null,
            });
        }

        lastHunkLine = Math.max(hunk.oldStart + hunk.oldLines, lastHunkLine);

        if (options.fullContext) {
            result.push(...foldHunk(hunk, options));
        } else {
            result.push(parseHunk(hunk, options));
        }
    }

    return result;
}

/** Whether any of the file's folded lines can be revealed from the patch itself. */
export function isExpandable(file: DiffFile): boolean {
    return file.hunks.some(
        (hunk) => hunk.type === "skip" && hunk.lines !== null,
    );
}

/** Every row the patch carries for a file, shown or folded, in file order. */
export function fileLines(file: DiffFile): DiffLine[] {
    return file.hunks.flatMap((hunk) =>
        hunk.type === "hunk" ? hunk.lines : (hunk.lines ?? []),
    );
}

/** Parses a unified diff into files of rows ready to render. */
export function parseDiff(
    diff: string,
    options?: Partial<ParseOptions>,
): DiffFile[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    return readPatch(diff).map((file) => ({
        oldPath: file.oldPath,
        newPath: file.newPath,
        type: resolveFileType(file),
        isBinary: file.isBinary,
        hunks: insertSkipBlocks(file.hunks, opts),
    }));
}

/**
 * Counts the lines a patch adds and removes. It only reads the patch, skipping the pairing
 * `parseDiff` does for rendering, so a summary can total many files without that cost, and
 * it follows the hunk lengths so a removed line starting with `--` is not taken for a header.
 */
export function countPatchLines(patch: string) {
    let added = 0;
    let removed = 0;

    for (const file of readPatch(patch)) {
        for (const hunk of file.hunks) {
            for (const change of hunk.changes) {
                if (change.type === "insert") {
                    added++;
                } else if (change.type === "delete") {
                    removed++;
                }
            }
        }
    }

    return { added, removed };
}

/** The text of one side of a row: the old line for "old", the new line for "new". */
export function lineSideText(line: DiffLine, side: "old" | "new"): string {
    const skipped = side === "old" ? "insert" : "delete";

    return line.segments
        .filter((segment) => segment.type !== skipped)
        .map((segment) => segment.value)
        .join("");
}
