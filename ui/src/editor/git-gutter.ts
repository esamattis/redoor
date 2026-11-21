import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { GIT_GUTTER_HIDDEN, gitLineMarks } from "./git-line-marks";
import type {
    GitGutterSource,
    GitLineChange,
    GitLineMark,
} from "./git-line-marks";

/** How long typing must pause before the marks are recomputed against the bases. */
const REFRESH_DELAY_MS = 250;

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
