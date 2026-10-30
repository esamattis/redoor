import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
} from "@codemirror/autocomplete";
import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
} from "@codemirror/commands";
import {
    bracketMatching,
    defaultHighlightStyle,
    foldGutter,
    foldKeymap,
    indentOnInput,
    syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search } from "@codemirror/search";
import {
    Compartment,
    EditorState,
    Facet,
    Prec,
    type Extension,
    type StateEffect,
} from "@codemirror/state";
import {
    Decoration,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
    type ViewUpdate,
} from "@codemirror/view";
import { tagHighlighter, tags } from "@lezer/highlight";
import { vim, Vim } from "@replit/codemirror-vim";
import { bbedit } from "@uiw/codemirror-theme-bbedit";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { vimYankHighlightExtension } from "../components/browser/vim-yank-highlight";
import {
    gitGutter,
    gitGutterField,
    gitGutterSourceEffects,
    type GitGutterSource,
} from "./git-gutter";
import { languageFromFileName } from "#ui/utils/editor-language";
import { getBaseName } from "#ui/utils/path";

/**
 * The user-wide editor preferences. They live in compartments rather than in each file's
 * fixed configuration, because a buffer restored from memory or storage was created under
 * whatever the preferences were back then and must be brought up to date without losing its
 * history.
 */
export type EditorSettings = {
    vimMode: boolean;
    wrapLines: boolean;
    theme: "light" | "dark";
    editable: boolean;
};

/**
 * Carries the save handler in the CodeMirror state. Vim's `:w` is registered once for the
 * whole page, so it finds the handler of the editor that ran it through that editor's state.
 */
const vimWriteHandler = Facet.define<() => void, (() => void) | null>({
    combine: (handlers) => handlers[0] ?? null,
});

Vim.defineEx("write", "w", (cm) => {
    cm.cm6.state.facet(vimWriteHandler)?.();
});

/**
 * How many undo events each buffer keeps at least (CodeMirror prunes beyond roughly this
 * depth). It bounds the memory and storage an open file's history can take.
 */
export const HISTORY_DEPTH = 100;

/**
 * Marks the selected text itself, because the selection is drawn as a layer behind the
 * text and CSS cannot otherwise tell which characters lie on it. Native `::selection`
 * covers only the main range and is gone while the editor is unfocused.
 */
const selectedTextMarks = EditorView.decorations.compute(
    ["selection"],
    (state) =>
        Decoration.set(
            state.selection.ranges
                .filter((range) => !range.empty)
                .map((range) =>
                    Decoration.mark({ class: "cm-selectedText" }).range(
                        range.from,
                        range.to,
                    ),
                ),
            true,
        ),
);

/** The editor callbacks that must reach whichever file is shown, not the one first opened. */
export type EditorCallbacks = {
    onUpdate: (update: ViewUpdate) => void;
    onFocus: () => void;
    onSave: () => void;
};

/**
 * Builds the extension set every buffer shares, with the user preferences in compartments.
 * Compartment contents are created once here, so a stale buffer is detected by identity.
 */
export class EditorConfiguration {
    private readonly vimCompartment = new Compartment();
    private readonly wrapCompartment = new Compartment();
    private readonly themeCompartment = new Compartment();
    private readonly editableCompartment = new Compartment();
    /** Holds the Git gutter only for files in a repository, so other files keep the width. */
    private readonly gitGutterCompartment = new Compartment();
    private readonly noGitGutter: Extension = [];
    private readonly vimOn: Extension;
    private readonly vimOff: Extension;

    private readonly wrapOn: Extension = [
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "data-wrap-lines": "true" }),
    ];

    private readonly wrapOff: Extension = EditorView.contentAttributes.of({
        "data-wrap-lines": "false",
    });

    /**
     * Tokyo Night paints selection matches darker than its own background, so search hits
     * all but vanish, and its grey selection barely stands out either. The matches use the
     * amber tones of the light theme, which readers already spot easily, and the selection
     * the theme's own blue, each at a strength that keeps the light text legible. Its
     * comments are as dark as that selection, so selected comments get a lighter colour. High
     * precedence makes the overrides win over Tokyo Night's equally specific rules.
     */
    private readonly darkTheme: Extension = [
        Prec.high(
            EditorView.theme(
                {
                    // Tokyo Night marks its faint selection important, so this must be too.
                    "&.cm-focused .cm-selectionBackground, & .cm-selectionLayer .cm-selectionBackground":
                        {
                            background: "rgb(122 162 247 / 0.35) !important",
                        },
                    // The marks nest either way round depending on their precedence.
                    ".cm-selectedText .cm-comment, .cm-comment .cm-selectedText":
                        {
                            color: "#9aa5ce",
                        },
                    ".cm-selectionMatch": {
                        backgroundColor: "rgb(250 204 21 / 0.3)",
                    },
                    ".cm-searchMatch": {
                        backgroundColor: "rgb(250 204 21 / 0.4)",
                    },
                    ".cm-searchMatch-selected": {
                        backgroundColor: "rgb(249 115 22 / 0.6)",
                    },
                },
                { dark: true },
            ),
        ),
        selectedTextMarks,
        syntaxHighlighting(
            tagHighlighter([{ tag: tags.comment, class: "cm-comment" }]),
        ),
        tokyoNight,
    ];

    private readonly notEditable: Extension = EditorView.editable.of(false);
    private readonly editable: Extension = [];
    private readonly shared: Extension;

    /** Resolves callbacks at call time so one configuration serves every file. */
    constructor(callbacks: EditorCallbacks) {
        this.vimOn = [
            // Vim must precede its observer so its adapter exists when the observer runs.
            vim({ status: true }),
            vimYankHighlightExtension,
            vimWriteHandler.of(() => callbacks.onSave()),
            EditorView.contentAttributes.of({ "data-vim-mode": "true" }),
        ];

        this.vimOff = EditorView.contentAttributes.of({
            "data-vim-mode": "false",
        });

        this.shared = [
            gitGutterField,
            EditorView.updateListener.of((update) =>
                callbacks.onUpdate(update),
            ),
            EditorView.theme({ "&": { height: "100%", width: "100%" } }),
            ...basicSetup(),
            keymap.of([indentWithTab]),
            search(),
            EditorView.contentAttributes.of({
                "aria-label": "File editor",
                "data-file-editor": "",
            }),
            EditorView.domEventHandlers({
                focus: () => {
                    callbacks.onFocus();
                },
            }),
            EditorView.theme({
                "&": { height: "100%" },
                "&.cm-focused": { outline: "none" },
                ".cm-scroller": { overflow: "auto" },
                ".cm-content": { padding: "0" },
                ".cm-line": { padding: "0" },
            }),
        ];
    }

    /**
     * Creates a file's extensions. The language comes from the name, or from a shebang when
     * the name has no extension, and stays fixed for the buffer's lifetime.
     */
    forFile(
        fileName: string,
        doc: string,
        settings: EditorSettings,
    ): Extension {
        const firstLineEnd = doc.indexOf("\n");

        const firstLine = doc.slice(
            0,
            firstLineEnd === -1 ? doc.length : firstLineEnd,
        );

        const languageContent =
            getBaseName(fileName).lastIndexOf(".") <= 0 &&
            firstLine.startsWith("#!")
                ? firstLine
                : "";

        const language = languageFromFileName(fileName, languageContent);

        return [
            // First, so the Git gutter is the leftmost one, before the line numbers.
            this.gitGutterCompartment.of(this.noGitGutter),
            this.vimCompartment.of(this.vimContent(settings)),
            this.wrapCompartment.of(this.wrapContent(settings)),
            this.themeCompartment.of(this.themeContent(settings)),
            this.editableCompartment.of(this.editableContent(settings)),
            this.shared,
            ...(language === undefined ? [] : [language]),
        ];
    }

    /** Lists the reconfigurations a state needs to match the current preferences. */
    settingsEffects(
        state: EditorState,
        settings: EditorSettings,
    ): StateEffect<unknown>[] {
        const wanted = [
            [this.vimCompartment, this.vimContent(settings)],
            [this.wrapCompartment, this.wrapContent(settings)],
            [this.themeCompartment, this.themeContent(settings)],
            [this.editableCompartment, this.editableContent(settings)],
        ] as const;

        return wanted.flatMap(([compartment, content]) =>
            compartment.get(state) === content
                ? []
                : [compartment.reconfigure(content)],
        );
    }

    /**
     * Lists the effects that show, hide or fill a state's Git gutter. The gutter is a
     * per-file fact rather than a preference, so it is applied beside the settings.
     */
    gitGutterEffects(
        state: EditorState,
        source: GitGutterSource,
    ): StateEffect<unknown>[] {
        const content = source.kind === "hidden" ? this.noGitGutter : gitGutter;

        return [
            ...(this.gitGutterCompartment.get(state) === content
                ? []
                : [this.gitGutterCompartment.reconfigure(content)]),
            ...gitGutterSourceEffects(state, source),
        ];
    }

    /** Picks the shared Vim extension for the preference. */
    private vimContent(settings: EditorSettings) {
        return settings.vimMode ? this.vimOn : this.vimOff;
    }

    /** Picks the shared wrapping extension for the preference. */
    private wrapContent(settings: EditorSettings) {
        return settings.wrapLines ? this.wrapOn : this.wrapOff;
    }

    /** Matches the editor colours to the resolved application theme. */
    private themeContent(settings: EditorSettings) {
        return settings.theme === "light" ? bbedit : this.darkTheme;
    }

    /** Keeps read-only revisions and unloaded files from accepting input. */
    private editableContent(settings: EditorSettings) {
        return settings.editable ? this.editable : this.notEditable;
    }
}

/**
 * CodeMirror's usual editing features, matching what the former React wrapper set up, but
 * without the search keymap: the find keys belong to the application's own search panel.
 */
function basicSetup(): Extension[] {
    return [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history({ minDepth: HISTORY_DEPTH }),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
        ]),
    ];
}
