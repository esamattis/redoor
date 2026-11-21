import { historyField } from "@codemirror/commands";
import {
    EditorSelection,
    EditorState,
    Text,
    Transaction,
} from "@codemirror/state";
import type {
    ChangeSpec,
    StateEffect,
    TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { EditorConfiguration } from "./editor-extensions";
import type { EditorCallbacks, EditorSettings } from "./editor-extensions";
import { storedBufferDataSchema } from "./stored-buffer";
import type { StoredBufferData, StoredScroll } from "./stored-buffer";

/**
 * The CodeMirror half of the editor workspace. The workspace lives for the whole page, but
 * CodeMirror, Vim and the grammars are a large part of the application's code, so they sit in
 * a chunk of their own that is only loaded once a file is shown in the editor. Everything the
 * workspace builds with CodeMirror goes through here; the states and the view it gets back are
 * then used through their own methods.
 */
export class EditorEngine {
    /** The extension set every buffer shares, with the preferences in compartments. */
    readonly configuration: EditorConfiguration;

    /** Wires the shared extensions to the workspace's callbacks. */
    constructor(callbacks: EditorCallbacks) {
        this.configuration = new EditorConfiguration(callbacks);
    }

    /** Creates the page's one view, over an empty state until a file is shown in it. */
    createView(settings: EditorSettings): EditorView {
        return new EditorView({
            state: this.createState(
                { fileName: "", content: "", head: 0 },
                settings,
            ),
        });
    }

    /**
     * Builds a fresh state for a file with the shared extensions, with the caret at `head`
     * (clamped to the text), so a discard can keep the caret near where it was.
     */
    createState(
        file: { fileName: string; content: string; head: number },
        settings: EditorSettings,
    ): EditorState {
        return EditorState.create({
            doc: file.content,
            selection: EditorSelection.cursor(
                Math.min(file.head, file.content.length),
            ),
            extensions: this.configuration.forFile(
                file.fileName,
                file.content,
                settings,
            ),
        });
    }

    /** Restores CodeMirror JSON, or null if it does not fit the current editor. */
    stateFromStored(
        data: StoredBufferData,
        fileName: string,
        settings: EditorSettings,
    ): EditorState | null {
        try {
            return EditorState.fromJSON(
                data.state,
                {
                    extensions: this.configuration.forFile(
                        fileName,
                        "",
                        settings,
                    ),
                },
                { history: historyField },
            );
        } catch {
            return null;
        }
    }

    /**
     * Turns a state into CodeMirror JSON for the server copy. The undo history is optional,
     * because an oversized buffer is stored without it.
     */
    storedState(
        state: EditorState,
        withHistory: boolean,
    ): StoredBufferData["state"] {
        return storedBufferDataSchema.shape.state.parse(
            withHistory
                ? state.toJSON({ history: historyField })
                : state.toJSON(),
        );
    }

    /** Turns device text into a CodeMirror document once, so comparisons can stay structural. */
    text(content: string): Text {
        return Text.of(content.split(/\r\n?|\n/));
    }

    /**
     * Makes a change that undo skips, for device text reaching a clean buffer: undoing must
     * not bring back text the device no longer has.
     */
    outsideHistory(changes: ChangeSpec): TransactionSpec {
        return { changes, annotations: Transaction.addToHistory.of(false) };
    }

    /**
     * Scrolls a view back to a position stored on the server. Returns the effect so a later
     * stash can keep it if the view has not applied it yet.
     */
    scrollToStored(
        view: EditorView,
        scroll: StoredScroll,
    ): StateEffect<unknown> {
        const effect = EditorView.scrollIntoView(
            Math.min(scroll.anchor, view.state.doc.length),
            { y: "start", yMargin: scroll.yMargin },
        );

        view.dispatch({ effects: effect });

        return effect;
    }

    /**
     * Selects the inbound `?line=` target and centers it so the opened location is obvious in
     * a tall buffer. Returns the scroll effect so a later stash can keep it if it is not
     * applied.
     */
    moveCaretToLine(
        view: EditorView,
        line: number,
    ): StateEffect<unknown> | null {
        const lineCount = view.state.doc.lines;

        // Empty documents have no real line to reveal.
        if (view.state.doc.length === 0 || lineCount < 1) {
            return null;
        }

        const clamped = Math.min(Math.max(line, 1), lineCount);
        const docLine = view.state.doc.line(clamped);
        const effect = EditorView.scrollIntoView(docLine.from, { y: "center" });

        view.dispatch({
            selection: { anchor: docLine.from, head: docLine.to },
            effects: effect,
        });

        return effect;
    }

    /**
     * Reports a result in the editor the way Vim reports command results, for `:wall`. A view
     * without Vim has no place for the message, so it is dropped there.
     */
    showVimMessage(view: EditorView, message: string) {
        const cm = getCM(view);

        if (cm === null) {
            return;
        }

        const element = document.createElement("span");
        element.className = "cm-vim-message";
        element.textContent = message;
        cm.openNotification(element, { bottom: true, duration: 10_000 });
    }
}
