import { parseVimConfig } from "./vim-config";
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
    toggleComment,
} from "@codemirror/commands";
import {
    bracketMatching,
    defaultHighlightStyle,
    foldGutter,
    foldKeymap,
    indentOnInput,
    syntaxHighlighting,
} from "@codemirror/language";
import type { LanguageSupport } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { Compartment, EditorState, Facet, Prec } from "@codemirror/state";
import type { Extension, StateEffect } from "@codemirror/state";
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
} from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { tagHighlighter, tags } from "@lezer/highlight";
import { vim, Vim } from "@replit/codemirror-vim";
import { bbedit } from "@uiw/codemirror-theme-bbedit";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { vimYankHighlightExtension } from "../components/browser/vim-yank-highlight";
import {
    gitGutter,
    gitGutterField,
    gitGutterSourceEffects,
} from "./git-gutter";
import type { GitGutterSource } from "./git-line-marks";
import { loadSyntaxLanguage } from "#ui/utils/editor-language";
import { syntaxLanguageFromFileName } from "#ui/utils/syntax-language";
import type { SupportedSyntaxLanguage } from "#ui/utils/syntax-language";
import { isUnmodifiedAltKey } from "#ui/utils/keyboard";
import type { KeyChord } from "#ui/utils/keyboard";
import { getBaseName } from "#ui/utils/path";

/**
 * The user-wide editor preferences. They live in compartments rather than in each file's
 * fixed configuration, because a buffer restored from memory or storage was created under
 * whatever the preferences were back then and must be brought up to date without losing its
 * history.
 */
export type EditorSettings = {
    vimMode: boolean;
    vimConfig: string;
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

/** Reads a registered Vim command handler from the CodeMirror 6 view backing the Vim adapter. */
function vimFacetHandler(
    cm: { cm6: unknown },
    facet: Facet<() => void, (() => void) | null>,
): (() => void) | null {
    return cm.cm6 instanceof EditorView ? cm.cm6.state.facet(facet) : null;
}

Vim.defineEx("write", "w", (cm) => {
    vimFacetHandler(cm, vimWriteHandler)?.();
});

/** Carries the `:wall` handler the same way, since that command is page-wide too. */
const vimWriteAllHandler = Facet.define<() => void, (() => void) | null>({
    combine: (handlers) => handlers[0] ?? null,
});

Vim.defineEx("wall", "wa", (cm) => {
    vimFacetHandler(cm, vimWriteAllHandler)?.();
});

/** The Vim configuration the adapter holds, so an unchanged one is not rebuilt. */
let appliedSource: string | null = null;

/**
 * The adapter owns a page-wide keymap, just like our user-wide preference. Clear only its
 * user mappings before rebuilding, so deleted overrides reveal defaults and :w stays intact.
 * Valid lines still work while an incomplete line is being edited in settings.
 */
export function applyVimConfig(source: string): void {
    if (source === appliedSource) {
        return;
    }

    Vim.mapclear();

    for (const mapping of parseVimConfig(source).mappings) {
        for (const context of mapping.contexts) {
            if (mapping.recursive) {
                Vim.map(mapping.lhs, mapping.rhs, context);
            } else {
                Vim.noremap(mapping.lhs, mapping.rhs, context);
            }
        }
    }

    appliedSource = source;
}

/**
 * The language a state was created for. The grammar loads after the state exists, so the
 * state itself has to remember which grammar its language compartment is waiting for.
 */
const stateLanguage = Facet.define<
    SupportedSyntaxLanguage | null,
    SupportedSyntaxLanguage | null
>({
    combine: (languages) => languages[0] ?? null,
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
    /** `:wall`, which saves every open file with unsaved changes, not just the shown one. */
    onSaveAll: () => void;
    /** A grammar finished loading, so the shown state can put it in its language compartment. */
    onLanguageLoaded: () => void;
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
    /**
     * Holds the file's grammar, which is empty until the grammar's chunk has loaded, so a file
     * opens at once as plain text and gains its highlighting a moment later.
     */
    private readonly languageCompartment = new Compartment();
    private readonly noLanguage: Extension = [];
    /** Grammars that have loaded, by language, so later states get them at once. */
    private readonly loadedLanguages = new Map<
        SupportedSyntaxLanguage,
        LanguageSupport
    >();
    /** Grammars being loaded, so creating more states does not report the same load again. */
    private readonly loadingLanguages = new Set<SupportedSyntaxLanguage>();
    private readonly callbacks: EditorCallbacks;
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
        this.callbacks = callbacks;

        this.vimOn = [
            // Vim must precede its observer so its adapter exists when the observer runs.
            vim({ status: true }),
            vimYankHighlightExtension,
            vimWriteHandler.of(() => callbacks.onSave()),
            vimWriteAllHandler.of(() => callbacks.onSaveAll()),
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
                // The opaque gutter stacks above the 1px insert caret, so column 0 needs a gap
                // to keep the caret from hiding under the gutter edge.
                ".cm-line": { padding: "0 0 0 4px" },
            }),
        ];
    }

    /**
     * Creates a file's extensions. The language comes from the name, or from a shebang when
     * the name has no extension, and stays fixed for the buffer's lifetime. Its grammar starts
     * loading here and joins the state through `languageEffects` once it is ready.
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

        const language =
            syntaxLanguageFromFileName(fileName, languageContent) ?? null;

        this.loadLanguage(language);

        return [
            // First, so the Git gutter is the leftmost one, before the line numbers.
            this.gitGutterCompartment.of(this.noGitGutter),
            this.vimCompartment.of(this.vimContent(settings)),
            this.wrapCompartment.of(this.wrapContent(settings)),
            this.themeCompartment.of(this.themeContent(settings)),
            this.editableCompartment.of(this.editableContent(settings)),
            this.shared,
            stateLanguage.of(language),
            this.languageCompartment.of(this.languageContent(language)),
        ];
    }

    /**
     * Lists the effect that puts a state's grammar in place once it has loaded. States made
     * before the load keep plain text until they are shown, which is when this is asked.
     */
    languageEffects(state: EditorState): StateEffect<unknown>[] {
        const content = this.languageContent(state.facet(stateLanguage));

        return this.languageCompartment.get(state) === content
            ? []
            : [this.languageCompartment.reconfigure(content)];
    }

    /** Starts loading a grammar once; a failed load leaves the file plain rather than broken. */
    private loadLanguage(language: SupportedSyntaxLanguage | null) {
        if (
            language === null ||
            this.loadedLanguages.has(language) ||
            this.loadingLanguages.has(language)
        ) {
            return;
        }

        this.loadingLanguages.add(language);

        void loadSyntaxLanguage(language).then(
            (support) => {
                this.loadingLanguages.delete(language);
                this.loadedLanguages.set(language, support);
                this.callbacks.onLanguageLoaded();
            },
            () => {
                // Forgotten, so the next state of this language tries again.
                this.loadingLanguages.delete(language);
            },
        );
    }

    /** The grammar of a language if it has loaded, otherwise nothing. */
    private languageContent(language: SupportedSyntaxLanguage | null) {
        return language === null
            ? this.noLanguage
            : (this.loadedLanguages.get(language) ?? this.noLanguage);
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
        applyVimConfig(settings.vimMode ? settings.vimConfig : "");

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
 * Toggles line comments with Alt+C (⌥C on Apple keyboards). Ctrl+/ needs two hands on many
 * layouts, where the slash sits behind Shift. The context menu reads this chord for its hint.
 */
export const toggleCommentChord: KeyChord = { alt: true, key: "c" };

/**
 * Runs the comment toggle for `toggleCommentChord`. It matches the physical key rather than
 * using a keymap entry, because on macOS Option+C types "ç" and CodeMirror deliberately
 * skips its key-code fallback for Option chords there, so an `Alt-c` binding never fires.
 * Highest precedence keeps Vim's own keydown handling from consuming the chord first.
 */
const toggleCommentOnChord = Prec.highest(
    EditorView.domEventHandlers({
        keydown: (event, view) => {
            if (
                !isUnmodifiedAltKey(event, toggleCommentChord.key) ||
                !view.state.facet(EditorView.editable)
            ) {
                return false;
            }

            event.preventDefault();
            toggleComment(view);

            return true;
        },
    }),
);

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
        toggleCommentOnChord,
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
