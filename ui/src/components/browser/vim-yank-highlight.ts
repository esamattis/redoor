import {
    StateEffect,
    StateField,
    type Extension,
    type Text,
} from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    type DecorationSet,
} from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";

/**
 * This extension requires `patches/@replit__codemirror-vim-core@0.1.0.patch`.
 * Upstream exposes no event with the resolved yank range, so the patch emits `vim-yank`
 * from the operator after motions, counts, mappings, and Visual mode have been applied.
 */

/** Describes the operator-resolved Vim range before it is converted to document offsets. */
type VimYankEvent = {
    from: VimPosition;
    to: VimPosition;
    linewise: boolean;
};

/** Uses the zero-based line and UTF-16 column convention of the Vim adapter. */
type VimPosition = {
    line: number;
    ch: number;
};

/** Keeps enough information to render either an exact mark or complete visible lines. */
type YankHighlightRange = {
    from: number;
    to: number;
    linewise: boolean;
};

const setYankHighlight = StateEffect.define<YankHighlightRange | null>();

const characterYankDecoration = Decoration.mark({
    class: "cm-vim-yank-highlight",
    attributes: { "data-vim-yank-highlight": "character" },
});

const lineYankDecoration = Decoration.line({
    class: "cm-vim-yank-highlight-line",
    attributes: { "data-vim-yank-highlight": "line" },
});

/** Builds decorations from the post-motion range without including an invisible trailing newline. */
function createYankDecorations(
    document: Text,
    range: YankHighlightRange,
): DecorationSet {
    const from = Math.max(0, Math.min(range.from, document.length));
    const to = Math.max(0, Math.min(range.to, document.length));
    const start = Math.min(from, to);
    const end = Math.max(from, to);

    if (!range.linewise) {
        return start < end
            ? Decoration.set([characterYankDecoration.range(start, end)])
            : Decoration.none;
    }

    const firstLine = document.lineAt(start);
    const lastOffset = end > start ? end - 1 : end;
    const lastLine = document.lineAt(lastOffset);
    const decorations = [];
    for (
        let lineNumber = firstLine.number;
        lineNumber <= lastLine.number;
        lineNumber += 1
    ) {
        decorations.push(
            lineYankDecoration.range(document.line(lineNumber).from),
        );
    }
    return Decoration.set(decorations);
}

const yankHighlightField = StateField.define<DecorationSet>({
    /** Starts each editor without a yank flash. */
    create() {
        return Decoration.none;
    },
    /** Maps an active flash through edits and replaces it only for explicit yank effects. */
    update(value, transaction) {
        let nextValue = value.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (!effect.is(setYankHighlight)) {
                continue;
            }
            nextValue =
                effect.value === null
                    ? Decoration.none
                    : createYankDecorations(
                          transaction.state.doc,
                          effect.value,
                      );
        }
        return nextValue;
    },
    provide: (field) => EditorView.decorations.from(field),
});

/** Converts Vim's zero-based positions to clamped CodeMirror document offsets. */
function vimPositionToOffset(view: EditorView, position: VimPosition): number {
    const lineNumber = Math.max(
        1,
        Math.min(position.line + 1, view.state.doc.lines),
    );
    const line = view.state.doc.line(lineNumber);
    return Math.max(line.from, Math.min(line.from + position.ch, line.to));
}

const yankHighlightTheme = EditorView.baseTheme({
    "&light .cm-vim-yank-highlight": {
        backgroundColor: "rgb(245 158 11 / 0.3)",
    },
    "&dark .cm-vim-yank-highlight": {
        backgroundColor: "rgb(250 204 21 / 0.3)",
    },
    "&light .cm-vim-yank-highlight-line": {
        backgroundImage:
            "linear-gradient(rgb(245 158 11 / 0.2), rgb(245 158 11 / 0.2))",
    },
    "&dark .cm-vim-yank-highlight-line": {
        backgroundImage:
            "linear-gradient(rgb(250 204 21 / 0.2), rgb(250 204 21 / 0.2))",
    },
});

const yankHighlightPlugin = ViewPlugin.fromClass(
    class {
        private readonly cm;
        private clearTimer: ReturnType<typeof setTimeout> | undefined;

        /** Subscribes to the adapter attached by the preceding Vim extension. */
        constructor(private readonly view: EditorView) {
            this.cm = getCM(view);
            this.cm?.on("vim-yank", this.handleYank);
        }

        /** Flashes the resolved operator range and resets this editor's own clear timer. */
        private readonly handleYank = (event: VimYankEvent) => {
            if (this.clearTimer !== undefined) {
                clearTimeout(this.clearTimer);
            }
            this.view.dispatch({
                effects: setYankHighlight.of({
                    from: vimPositionToOffset(this.view, event.from),
                    to: vimPositionToOffset(this.view, event.to),
                    linewise: event.linewise,
                }),
            });
            this.clearTimer = setTimeout(() => {
                this.view.dispatch({ effects: setYankHighlight.of(null) });
                this.clearTimer = undefined;
            }, 180);
        };

        /** Removes the Vim listener and pending timer before the editor is destroyed. */
        destroy() {
            this.cm?.off("vim-yank", this.handleYank);
            if (this.clearTimer !== undefined) {
                clearTimeout(this.clearTimer);
            }
        }
    },
);

/** Adds an operator-driven yank flash to an editor that has the Vim extension. */
export const vimYankHighlightExtension: Extension = [
    yankHighlightField,
    yankHighlightTheme,
    yankHighlightPlugin,
];
