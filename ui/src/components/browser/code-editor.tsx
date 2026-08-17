import React from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { search } from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
    EditorSearch,
    type EditorSearchHandle,
} from "#ui/components/browser/editor-search";
import { languageFromFileName } from "#ui/utils/editor-language";

/**
 * Presentational CodeMirror surface so FileEditView can keep query/draft ownership.
 * A bounded height lets CodeMirror virtualize the viewport instead of growing the page.
 * Extensions are memoized on the file name because recreating them remounts the editor.
 */
export function CodeEditor(props: {
    value: string;
    fileName: string;
    editable: boolean;
    onChange: (value: string) => void;
    onSave: () => void;
}) {
    const onSaveRef = React.useRef(props.onSave);
    onSaveRef.current = props.onSave;
    const editorRef = React.useRef<ReactCodeMirrorRef>(null);
    const searchHandleRef = React.useRef<EditorSearchHandle | null>(null);
    const [view, setView] = React.useState<EditorView | null>(null);
    const [documentRevision, setDocumentRevision] = React.useState(0);

    const extensions = React.useMemo(() => {
        const language = languageFromFileName(props.fileName);
        return [
            search(),
            EditorView.contentAttributes.of({
                "aria-label": "File editor",
                "data-file-editor": "",
            }),
            EditorView.theme({
                "&": {
                    height: "100%",
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
                            return true;
                        },
                    },
                    {
                        key: "Mod-f",
                        run: () => {
                            searchHandleRef.current?.open();
                            return true;
                        },
                    },
                    {
                        key: "Mod-g",
                        run: () => searchHandleRef.current?.findNext() ?? false,
                    },
                    {
                        key: "Shift-Mod-g",
                        run: () =>
                            searchHandleRef.current?.findPrevious() ?? false,
                    },
                    {
                        key: "F3",
                        run: () => searchHandleRef.current?.findNext() ?? false,
                    },
                    {
                        key: "Shift-F3",
                        run: () =>
                            searchHandleRef.current?.findPrevious() ?? false,
                    },
                    {
                        key: "Escape",
                        run: () => searchHandleRef.current?.close() ?? false,
                    },
                ]),
            ),
            ...(language === undefined ? [] : [language]),
        ];
    }, [props.fileName]);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EditorSearch
                view={view}
                editable={props.editable}
                documentRevision={documentRevision}
                handleRef={searchHandleRef}
            />
            <div
                data-file-editor=""
                role="region"
                aria-label="Editor viewport"
                className="min-h-0 flex-1 overflow-hidden"
            >
                <CodeMirror
                    ref={editorRef}
                    value={props.value}
                    height="100%"
                    width="100%"
                    theme={copilot}
                    editable={props.editable}
                    basicSetup={{ searchKeymap: false }}
                    extensions={extensions}
                    onCreateEditor={setView}
                    onChange={props.onChange}
                    onUpdate={(update) => {
                        if (update.docChanged || update.selectionSet) {
                            setDocumentRevision((revision) => revision + 1);
                        }
                    }}
                    className="h-full min-h-0"
                />
            </div>
        </div>
    );
}
