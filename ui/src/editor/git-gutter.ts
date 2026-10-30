import {
    RangeSet,
    StateEffect,
    StateField,
    type EditorState,
    type Extension,
    type Text,
} from "@codemirror/state";
import {
    EditorView,
    gutter,
    GutterMarker,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
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

/** How long typing must pause before the marks are recomputed against the bases. */
const REFRESH_DELAY_MS = 250;

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

/** Labels for the marks, which tests and assistive tooling read from the gutter. */
const CHANGE_LABELS: Record<GitLineChange, string> = {
    added: "Added",
    modified: "Modified",
    deleted_above: "Lines deleted above",
    deleted_below: "Lines deleted below",
};

/** One kind of mark in the gutter. Instances are shared, so equal marks compare by identity. */
class GitLineMarker extends GutterMarker {
    /** Describes the change this marker stands for. */
    constructor(
        readonly change: GitLineChange,
        readonly staged: boolean,
    ) {
        super();
    }

    /** Lets CodeMirror keep the element when a line keeps the same kind of mark. */
    override eq(other: GutterMarker): boolean {
        return (
            other instanceof GitLineMarker &&
            other.change === this.change &&
            other.staged === this.staged
        );
    }

    /**
     * Draws the bar or deletion wedge. The data attributes name the change, since the gutter
     * is hidden from the accessibility tree like the line numbers.
     */
    override toDOM(): HTMLElement {
        const element = document.createElement("div");
        element.className = `cm-gitLine cm-gitLine-${this.change}${
            this.staged ? " cm-gitLine-staged" : ""
        }`;
        element.dataset.gitLineChange = this.change;
        element.dataset.gitLineStaged = this.staged ? "true" : "false";
        element.setAttribute(
            "aria-label",
            `${CHANGE_LABELS[this.change]}, ${this.staged ? "staged" : "not staged"}`,
        );

        return element;
    }
}

/** Every marker the gutter can show, keyed by change and staging. */
const MARKERS = new Map(
    (["added", "modified", "deleted_above", "deleted_below"] as const).flatMap(
        (change) =>
            [false, true].map(
                (staged) =>
                    [
                        `${change}:${String(staged)}`,
                        new GitLineMarker(change, staged),
                    ] as const,
            ),
    ),
);

/** The shared marker for a mark. */
function markerFor(mark: GitLineMark): GitLineMarker {
    const marker = MARKERS.get(`${mark.change}:${String(mark.staged)}`);

    if (marker === undefined) {
        throw new Error(`No Git gutter marker for ${mark.change}`);
    }

    return marker;
}

/** Places the marks of a document at the starts of their lines. */
function markersFor(
    doc: Text,
    source: GitGutterSource,
): RangeSet<GutterMarker> {
    if (source.kind !== "bases") {
        return RangeSet.empty;
    }

    const marks = gitLineMarks(doc.toJSON(), source.bases);

    return RangeSet.of(
        marks.map((mark) =>
            markerFor(mark).range(doc.line(mark.line + 1).from),
        ),
    );
}

/** What one buffer's gutter holds. */
type GitGutterState = {
    source: GitGutterSource;
    markers: RangeSet<GutterMarker>;
    /** The document changed since the markers were computed; they were only moved along. */
    stale: boolean;
};

/** Gives a buffer new bases, or hides or empties its gutter. */
const setGitGutterSource = StateEffect.define<GitGutterSource>();

/** Recomputes stale markers against the current document after typing paused. */
const refreshGitMarkers = StateEffect.define<null>();

/**
 * The gutter's data, kept in each buffer's own state so switching files keeps their marks.
 * Edits move the marks along at once and leave the diff to a debounced refresh, so typing in
 * a large file never runs a whole-file diff per keystroke.
 */
export const gitGutterField = StateField.define<GitGutterState>({
    create: () => ({
        source: GIT_GUTTER_HIDDEN,
        markers: RangeSet.empty,
        stale: false,
    }),
    update(value, transaction) {
        let next = value;

        if (transaction.docChanged && next.source.kind === "bases") {
            next = {
                ...next,
                markers: next.markers.map(transaction.changes),
                stale: true,
            };
        }

        for (const effect of transaction.effects) {
            if (effect.is(setGitGutterSource)) {
                next = {
                    source: effect.value,
                    markers: markersFor(transaction.state.doc, effect.value),
                    stale: false,
                };
            } else if (effect.is(refreshGitMarkers) && next.stale) {
                next = {
                    ...next,
                    markers: markersFor(transaction.state.doc, next.source),
                    stale: false,
                };
            }
        }

        return next;
    },
});

/** The effect that gives a state `source`, or none when it already has it. */
export function gitGutterSourceEffects(
    state: EditorState,
    source: GitGutterSource,
): StateEffect<unknown>[] {
    return state.field(gitGutterField).source === source
        ? []
        : [setGitGutterSource.of(source)];
}

/** Schedules the recomputation of stale markers once typing pauses. */
const gitRefreshPlugin = ViewPlugin.fromClass(
    class {
        private timer: number | undefined;

        /** A state swapped in with stale markers is refreshed too. */
        constructor(private readonly view: EditorView) {
            this.schedule(view.state);
        }

        /** Restarts the delay on every edit, so the diff runs only after a pause. */
        update(update: ViewUpdate) {
            if (update.docChanged) {
                this.schedule(update.state);
            }
        }

        /** Stops a pending refresh of a view that is going away. */
        destroy() {
            window.clearTimeout(this.timer);
        }

        /** Arms the refresh timer when the markers are out of date. */
        private schedule(state: EditorState) {
            window.clearTimeout(this.timer);

            if (!state.field(gitGutterField).stale) {
                return;
            }

            this.timer = window.setTimeout(() => {
                this.view.dispatch({ effects: refreshGitMarkers.of(null) });
            }, REFRESH_DELAY_MS);
        }
    },
);

/** The bar colours: green added, amber modified (as in the file list), red deleted. */
const COLORS = {
    added: "#10b981",
    modified: "#f59e0b",
    deleted: "#ef4444",
};

/** Size of the deletion wedge, which sits on the boundary between two lines. */
const WEDGE_PX = 4;

/**
 * A staged change is drawn dashed rather than solid, so it is told apart by shape and not
 * only by a shade of the same colour.
 */
function stagedBar(color: string) {
    return {
        background: `repeating-linear-gradient(to bottom, ${color} 0 3px, transparent 3px 5px)`,
    };
}

/** A wedge pointing into the text at the top or bottom edge of its line. */
function wedge(edge: "top" | "bottom") {
    return {
        position: "absolute",
        left: "0",
        width: "0",
        height: "0",
        [edge]: `-${String(WEDGE_PX)}px`,
        borderTop: `${String(WEDGE_PX)}px solid transparent`,
        borderBottom: `${String(WEDGE_PX)}px solid transparent`,
        borderLeft: `${String(WEDGE_PX)}px solid ${COLORS.deleted}`,
    };
}

/**
 * The gutter itself, left of the line numbers. It is only part of a buffer's configuration
 * inside a repository, so other files keep their full width.
 */
export const gitGutter: Extension = [
    gutter({
        class: "cm-gitGutter",
        markers: (view) => view.state.field(gitGutterField).markers,
    }),
    gitRefreshPlugin,
    EditorView.baseTheme({
        ".cm-gutter.cm-gitGutter": { width: "4px", minWidth: "4px" },
        ".cm-gitGutter .cm-gutterElement": {
            position: "relative",
            padding: "0",
            overflow: "visible",
        },
        ".cm-gitLine": { width: "3px", height: "100%" },
        ".cm-gitLine-added": { background: COLORS.added },
        ".cm-gitLine-modified": { background: COLORS.modified },
        ".cm-gitLine-added.cm-gitLine-staged": stagedBar(COLORS.added),
        ".cm-gitLine-modified.cm-gitLine-staged": stagedBar(COLORS.modified),
        ".cm-gitLine-deleted_above": wedge("top"),
        ".cm-gitLine-deleted_below": wedge("bottom"),
        ".cm-gitLine-deleted_above.cm-gitLine-staged, .cm-gitLine-deleted_below.cm-gitLine-staged":
            { opacity: "0.5" },
    }),
];
