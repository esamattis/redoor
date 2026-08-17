import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
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

    const extensions = React.useMemo(() => {
        const language = languageFromFileName(props.fileName);
        return [
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
                ]),
            ),
            ...(language === undefined ? [] : [language]),
        ];
    }, [props.fileName]);

    return (
        <div
            data-file-editor=""
            role="region"
            aria-label="Editor viewport"
            className="min-h-0 flex-1 overflow-hidden"
        >
            <CodeMirror
                value={props.value}
                height="100%"
                width="100%"
                theme={copilot}
                editable={props.editable}
                extensions={extensions}
                onChange={props.onChange}
                className="h-full min-h-0"
            />
        </div>
    );
}
