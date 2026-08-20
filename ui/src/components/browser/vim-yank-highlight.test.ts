// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { vimYankHighlightExtension } from "./vim-yank-highlight";

const views: EditorView[] = [];

// JSDOM does not measure text ranges, while CodeMirror's cursor layer only needs a stable stub here.
Range.prototype.getClientRects = () => document.body.getClientRects();
Range.prototype.getBoundingClientRect = () => new DOMRect();

/** Creates the same Vim-before-observer extension order used by CodeEditor. */
function createVimEditor(documentText: string): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: documentText,
            extensions: [vim(), vimYankHighlightExtension],
        }),
    });
    views.push(view);
    return view;
}

/** Sends mapped Vim keys through its command dispatcher rather than inferring keyboard input. */
function runVimKeys(view: EditorView, keys: string): void {
    const cm = getCM(view);
    if (cm === null) {
        throw new Error("Vim adapter was not created");
    }
    for (const key of keys) {
        cm.operation(() => Vim.handleKey(cm, key, "user"));
    }
}

/** Returns rendered yank decorations by their stable semantic test attribute. */
function yankHighlights(view: EditorView, kind: "character" | "line") {
    return view.dom.querySelectorAll(`[data-vim-yank-highlight="${kind}"]`);
}

afterEach(() => {
    for (const view of views.splice(0)) {
        view.destroy();
    }
    vi.useRealTimers();
    document.body.replaceChildren();
});

test("renders resolved counted, characterwise, and Visual yank ranges", () => {
    vi.useFakeTimers();
    const view = createVimEditor(`one two
three four

five`);

    runVimKeys(view, "yy");
    // A doubled yank operator resolves to one complete non-final line.
    expect(yankHighlights(view, "line")).toHaveLength(1);
    expect(yankHighlights(view, "line").item(0).textContent).toBe("one two");
    vi.advanceTimersByTime(180);

    runVimKeys(view, "3yy");
    const lineHighlights = yankHighlights(view, "line");
    // Counted linewise yanks include every visible line and retain an empty-line element.
    expect(lineHighlights).toHaveLength(3);
    expect(
        Array.from(lineHighlights, (element) => element.textContent),
    ).toEqual(["one two", "three four", ""]);
    vi.advanceTimersByTime(180);
    expect(yankHighlights(view, "line")).toHaveLength(0);

    runVimKeys(view, "ggyw");
    // Vim's word motion includes the trailing space, proving the range came from the operator.
    expect(yankHighlights(view, "character").item(0).textContent).toBe("one ");
    vi.advanceTimersByTime(180);

    runVimKeys(view, "ggvey");
    // The former Visual selection remains available to the flash after Vim exits Visual mode.
    expect(yankHighlights(view, "character").item(0).textContent).toBe("one");
});

test("keeps clear timers isolated per editor and cancels them on destroy", () => {
    vi.useFakeTimers();
    const firstView = createVimEditor("first");
    const secondView = createVimEditor("second");

    runVimKeys(firstView, "yy");
    vi.advanceTimersByTime(100);
    runVimKeys(secondView, "yy");
    vi.advanceTimersByTime(80);

    // The first editor clears on its own schedule without clearing the newer second flash.
    expect(yankHighlights(firstView, "line")).toHaveLength(0);
    expect(yankHighlights(secondView, "line")).toHaveLength(1);
    firstView.destroy();
    views.splice(views.indexOf(firstView), 1);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(yankHighlights(secondView, "line")).toHaveLength(0);
});

test("resets the clear timer when the same editor yanks again", () => {
    vi.useFakeTimers();
    const view = createVimEditor("latest");

    runVimKeys(view, "yy");
    vi.advanceTimersByTime(100);
    runVimKeys(view, "yy");
    vi.advanceTimersByTime(80);

    // The first timeout must not clear the newer flash from the same editor.
    expect(yankHighlights(view, "line")).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(yankHighlights(view, "line")).toHaveLength(0);
});
