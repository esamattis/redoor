import React from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { bbedit } from "@uiw/codemirror-theme-bbedit";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { search } from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim, Vim } from "@replit/codemirror-vim";
import {
    EditorSearch,
    type EditorSearchHandle,
} from "#ui/components/browser/editor-search";
import { vimYankHighlightExtension } from "./vim-yank-highlight";
import { languageFromFileName } from "#ui/utils/editor-language";
import { isTerminalInputTarget, isUnmodifiedAltKey } from "#ui/utils/keyboard";
import { useResolvedTheme } from "#ui/utils/use-resolved-theme";

/** Carries only the editor selection details needed by actions outside CodeMirror. */
export type EditorSelection = {
    text: string;
    startLine: number;
};

/** Lets :w call the current save handler without re-registering the global ex command. */
const vimWriteRef = { current: () => {} };

Vim.defineEx("write", "w", () => {
    vimWriteRef.current();
});

/** Reclaims editor focus from an active shell when the global Alt-e shortcut is used. */
function useFocusEditorShortcut(view: EditorView | null) {
    React.useEffect(() => {
        if (view === null) {
            return;
        }
        let focusCorrectionTimer: number | undefined;

        /** Returns from a focused shell without typing e into the session. */
        const handleFocusEditorShortcut = (event: KeyboardEvent) => {
            if (
                !isUnmodifiedAltKey(event, "e") ||
                !isTerminalInputTarget(event.target)
            ) {
                return;
            }
            event.preventDefault();
            view.focus();
            window.clearTimeout(focusCorrectionTimer);
            focusCorrectionTimer = window.setTimeout(() => {
                // Ghostty retries focus asynchronously, so reclaim it only if that retry won.
                if (isTerminalInputTarget(document.activeElement)) {
                    view.focus();
                }
            }, 0);
        };

        window.addEventListener("keydown", handleFocusEditorShortcut, true);
        return () => {
            window.clearTimeout(focusCorrectionTimer);
            window.removeEventListener(
                "keydown",
                handleFocusEditorShortcut,
                true,
            );
        };
    }, [view]);
}

/**
 * Presentational CodeMirror surface so FileEditView can keep query/draft ownership.
 * A bounded height lets CodeMirror virtualize the viewport instead of growing the page.
 * Extensions are memoized on the file name and keymap because recreating them remounts the editor.
 */
export function CodeEditor(props: {
    value: string;
    fileName: string;
    editable: boolean;
    vimMode: boolean;
    wrapLines: boolean;
    onChange: (value: string) => void;
    onFocus: () => void;
    onSave: () => void;
    onSelectionChange: (selection: EditorSelection | null) => void;
    searchHandleRef: React.RefObject<EditorSearchHandle | null>;
}) {
    const resolvedTheme = useResolvedTheme();
    const onSaveRef = React.useRef(props.onSave);
    onSaveRef.current = props.onSave;
    /** Saves without leaving CodeMirror so Mod-s and :w cannot dump the user into chrome. */
    const saveFromEditor = () => {
        onSaveRef.current();
        editorRef.current?.view?.focus();
    };
    vimWriteRef.current = saveFromEditor;
    const editorRef = React.useRef<ReactCodeMirrorRef>(null);
    const onFocusRef = React.useRef(props.onFocus);
    onFocusRef.current = props.onFocus;
    const hasReceivedFocusRef = React.useRef(false);
    const [view, setView] = React.useState<EditorView | null>(null);
    const [documentRevision, setDocumentRevision] = React.useState(0);
    const firstLineEnd = props.value.indexOf("\n");
    const firstLine = props.value.slice(
        0,
        firstLineEnd === -1 ? props.value.length : firstLineEnd,
    );
    const baseName = props.fileName.split("/").pop() ?? props.fileName;
    const languageContent =
        baseName.lastIndexOf(".") <= 0 && firstLine.startsWith("#!")
            ? firstLine
            : "";

    const extensions = React.useMemo(() => {
        const language = languageFromFileName(props.fileName, languageContent);
        return [
            // Vim must precede both its observer and other keymaps so its adapter exists and normal-mode keys win.
            ...(props.vimMode
                ? [vim({ status: true }), vimYankHighlightExtension]
                : []),
            ...(props.wrapLines ? [EditorView.lineWrapping] : []),
            search(),
            EditorView.contentAttributes.of({
                "aria-label": "File editor",
                "data-file-editor": "",
                "data-vim-mode": props.vimMode ? "true" : "false",
                "data-wrap-lines": props.wrapLines ? "true" : "false",
            }),
            EditorView.domEventHandlers({
                focus: () => {
                    // The initial load is already fresh, so only later focus entries refetch.
                    if (hasReceivedFocusRef.current) {
                        onFocusRef.current();
                    } else {
                        hasReceivedFocusRef.current = true;
                    }
                },
            }),
            EditorView.theme({
                "&": {
                    height: "100%",
                },
                "&.cm-focused": {
                    outline: "none",
                },
                ".cm-scroller": {
                    overflow: "auto",
                },
            }),
            Prec.highest(
                keymap.of([
                    {
                        key: "Mod-s",
                        run: () => {
                            onSaveRef.current();
                            editorRef.current?.view?.focus();
                            return true;
                        },
                    },
                    {
                        key: "Mod-f",
                        run: () => {
                            props.searchHandleRef.current?.open();
                            return true;
                        },
                    },
                    {
                        key: "Mod-g",
                        run: () =>
                            props.searchHandleRef.current?.findNext() ?? false,
                    },
                    {
                        key: "Shift-Mod-g",
                        run: () =>
                            props.searchHandleRef.current?.findPrevious() ??
                            false,
                    },
                    {
                        key: "F3",
                        run: () =>
                            props.searchHandleRef.current?.findNext() ?? false,
                    },
                    {
                        key: "Shift-F3",
                        run: () =>
                            props.searchHandleRef.current?.findPrevious() ??
                            false,
                    },
                    {
                        key: "Escape",
                        run: () =>
                            props.searchHandleRef.current?.close() ?? false,
                    },
                ]),
            ),
            ...(language === undefined ? [] : [language]),
        ];
    }, [
        languageContent,
        props.fileName,
        props.searchHandleRef,
        props.vimMode,
        props.wrapLines,
    ]);

    useFocusEditorShortcut(view);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EditorSearch
                view={view}
                editable={props.editable}
                documentRevision={documentRevision}
                handleRef={props.searchHandleRef}
            />
            <div
                data-file-editor=""
                data-vim-mode={props.vimMode ? "true" : "false"}
                data-wrap-lines={props.wrapLines ? "true" : "false"}
                role="region"
                aria-label="Editor viewport"
                className="min-h-0 flex-1 overflow-hidden rounded-md border border-transparent p-1.5 focus-within:border-blue-500"
            >
                <CodeMirror
                    ref={editorRef}
                    value={props.value}
                    height="100%"
                    width="100%"
                    theme={resolvedTheme === "light" ? bbedit : tokyoNight}
                    editable={props.editable}
                    basicSetup={{ searchKeymap: false }}
                    extensions={extensions}
                    onCreateEditor={setView}
                    onChange={props.onChange}
                    onUpdate={(update) => {
                        if (update.docChanged || update.selectionSet) {
                            setDocumentRevision((revision) => revision + 1);
                            const selection = update.state.selection.main;
                            props.onSelectionChange(
                                selection.empty
                                    ? null
                                    : {
                                          text: update.state.sliceDoc(
                                              selection.from,
                                              selection.to,
                                          ),
                                          startLine: update.state.doc.lineAt(
                                              selection.from,
                                          ).number,
                                      },
                            );
                        }
                    }}
                    className="h-full min-h-0"
                />
            </div>
        </div>
    );
}
