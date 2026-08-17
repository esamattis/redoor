import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { languageFromFileName } from "#ui/utils/editor-language";

/**
 * Presentational CodeMirror surface so FileEditView can keep query/draft ownership.
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
        <div data-file-editor="" className="min-h-0 flex-1">
            <CodeMirror
                value={props.value}
                height="100%"
                width="100%"
                theme={copilot}
                editable={props.editable}
                extensions={extensions}
                onChange={props.onChange}
                className="h-full"
            />
        </div>
    );
}
