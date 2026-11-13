// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { applyVimConfig, parseVimConfig } from "./vim-config";

const views: EditorView[] = [];

Range.prototype.getClientRects = () => document.body.getClientRects();

Range.prototype.getBoundingClientRect = () => new DOMRect();

/** Runs commands against a real adapter so tests cover its mapping semantics. */
function editor(doc: string) {
    const view = new EditorView({
        parent: document.body,
        state: EditorState.create({ doc, extensions: [vim()] }),
    });

    views.push(view);

    return view;
}

/** Accepts complete Vim key tokens including Escape. */
function keys(view: EditorView, ...tokens: string[]) {
    const cm = getCM(view);

    if (cm === null) throw new Error("Missing Vim adapter");

    for (const token of tokens)
        cm.operation(() => Vim.handleKey(cm, token, "user"));
}

afterEach(() => {
    applyVimConfig("");

    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
});

test("parses comments, Unicode and mode-specific mappings and reports invalid lines", () => {
    const parsed = parseVimConfig(`" comment

inoremap jj <esc>
map ö ^
vmap ä $
set number
nmap missing
map <silent> x
map :w :quit`);

    // Invalid lines stay local: valid mappings before them remain usable.
    expect(parsed.mappings).toEqual([
        { lhs: "jj", rhs: "<Esc>", contexts: ["insert"], recursive: false },
        {
            lhs: "ö",
            rhs: "^",
            contexts: ["normal", "visual", "operatorPending"],
            recursive: true,
        },
        { lhs: "ä", rhs: "$", contexts: ["visual"], recursive: true },
    ]);
    expect(parsed.errors.map((error) => error.line)).toEqual([6, 7, 8, 9]);
});

test("supports Unicode normal, visual and operator motions plus composed mappings", () => {
    applyVimConfig(`map ö ^
map ä $
map Ö 0
map Ä g_
vmap ö ^
vmap ä $
vmap Ö 0
map Y y$
map K kJ`);

    const view = editor(`  one two  
three`);

    keys(view, "ä", "ö");
    // ^ must skip indentation while 0 must preserve it.
    expect(view.state.selection.main.head).toBe(2);
    keys(view, "Ö");
    expect(view.state.selection.main.head).toBe(0);
    keys(view, "Ä");
    expect(view.state.selection.main.head).toBe(8);
    keys(view, "ö", "v", "ä");
    // Visual mode has its own adapter context and includes the line's last character.
    expect(
        view.state.sliceDoc(
            view.state.selection.main.from,
            view.state.selection.main.to,
        ),
    ).toBe("one two  ");
    keys(view, "<Esc>", "ö", "Y", "p");
    // Y is characterwise to the end of this line, rather than a whole-line yank.
    expect(view.state.doc.toString()).toBe(`  oone two  ne two  
three`);
    keys(view, "g", "g", "j", "K");
    // A composed motion and join must execute in sequence.
    expect(view.state.doc.lines).toBe(1);
});

test("keeps mapped motions usable after operators and with counts", () => {
    applyVimConfig(`map ä $
map Ä g_`);

    const view = editor(`  one  
second  `);

    keys(view, "2", "Ä");
    // g_ counts lines but excludes the target line's trailing whitespace.
    expect(view.state.selection.main.head).toBe(13);
    keys(view, "g", "g", "0", "d", "Ä");
    // Operator-pending mappings must resolve an inclusive motion, not an editor action.
    expect(view.state.doc.toString()).toBe(`  
second  `);
});

test("replaces overrides and restores built-in keys without replacing the document", () => {
    const view = editor("one two");
    applyVimConfig("nmap x l");
    keys(view, "x");
    // Override moves instead of deleting.
    expect(view.state.selection.main.head).toBe(1);
    expect(view.state.doc.toString()).toBe("one two");
    applyVimConfig("nmap x h");
    keys(view, "x");
    expect(view.state.selection.main.head).toBe(0);
    applyVimConfig("");
    keys(view, "x");
    // Removing the mapping reveals Vim's default delete behavior.
    expect(view.state.doc.toString()).toBe("ne two");
});

test("nonrecursive mappings can use the built-in last-nonblank motion", () => {
    applyVimConfig(`nnoremap X g_
vnoremap Ä g_`);
    const view = editor("  one two  ");

    keys(view, "X");
    // Nonrecursive expansion must find g_ in the adapter's built-in keymap.
    expect(view.state.selection.main.head).toBe(8);
    keys(view, "0", "v", "Ä");
    // The same built-in motion must remain inclusive in visual mode.
    expect(view.state.selection.main.to).toBe(9);
});

test("removing Unicode mappings restores the physical-key fallback", () => {
    const view = editor("one");
    const cm = getCM(view);

    if (cm === null) throw new Error("Missing Vim adapter");

    const event = new KeyboardEvent("keydown", { key: "ü", code: "KeyO" });
    const vimState = cm.state.vim;

    if (vimState === null || vimState === undefined)
        throw new Error("Missing Vim state");

    applyVimConfig("map ü ^");
    // A configured Unicode key must take precedence over its physical key code.
    expect(Vim.vimKeyFromEvent(event, vimState)).toBe("ü");
    applyVimConfig("");
    // Clearing must also release the adapter's key registration, not just its mapping.
    expect(Vim.vimKeyFromEvent(event, vimState)).toBe("o");
});

test("distinguishes recursive maps from noremap and scopes plain map away from insert", () => {
    applyVimConfig(`map x l
nmap q x
nnoremap z x`);
    const view = editor("one two");
    keys(view, "q");
    // Recursive q follows x's custom motion.
    expect(view.state.selection.main.head).toBe(1);
    keys(view, "z");
    // Nonrecursive z uses the default delete command.
    expect(view.state.doc.toString()).toBe("oe two");
    keys(view, "i");
    const cm = getCM(view);

    if (cm === null) throw new Error("Missing Vim adapter");
    // An unhandled key in insert mode is inserted by CodeMirror, not treated as a motion.
    expect(Vim.handleKey(cm, "x", "user")).toBeUndefined();
});
