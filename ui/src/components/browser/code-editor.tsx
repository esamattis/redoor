import React from "react";
import type { EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { getRouteApi, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import {
    EditorSearch,
    type EditorSearchHandle,
} from "#ui/components/browser/editor-search";
import type { EditorHandlers, LineTargets } from "#ui/editor/editor-workspace";
import type { StoredBuffer } from "#ui/editor/stored-buffer";
import { historyEntryKey } from "#ui/history-entry-state";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { resolvedThemeAtom } from "#ui/theme-state";
import { useTerminals } from "#ui/use-terminals";
import type { OpenFileReveal } from "#ui/user-state";
import { isTerminalInputTarget, isUnmodifiedAltKey } from "#ui/utils/keyboard";

const rootRouteApi = getRouteApi("__root__");

/** Carries only the editor selection details needed by actions outside CodeMirror. */
export type EditorSelection = {
    text: string;
    startLine: number;
};

/**
 * Reclaims editor focus from an active shell with Alt-e, and drops a pending delayed
 * correction when a newer terminal activation arrives, which must win.
 */
function useFocusEditorShortcut(view: EditorView | null) {
    const terminals = useTerminals();
    const focusCorrectionTimer = React.useRef<number | undefined>(undefined);

    React.useEffect(() => {
        return () => window.clearTimeout(focusCorrectionTimer.current);
    }, []);

    // A watcher in the observer tier, so it still sees `t` after the terminal shortcut claims it.
    useShortcut(
        {
            name: "editor-cancel-focus-correction",
            phase: "capture",
            priority: shortcutPriority.observer,
            match: (event) =>
                isUnmodifiedAltKey(event, "t") || event.key === "t",
            run: () => {
                window.clearTimeout(focusCorrectionTimer.current);

                return false;
            },
        },
        view !== null,
    );

    useShortcut(
        {
            name: "editor-reclaim-focus",
            phase: "capture",
            priority: shortcutPriority.editor,
            match: (event) => isUnmodifiedAltKey(event, "e"),
            run: (event) => {
                // Whatever the key's target, the user went back to the editor, so a terminal
                // that finishes connecting later must not take focus again.
                terminals.cancelPendingFocus();

                if (view === null || !isTerminalInputTarget(event.target)) {
                    return false;
                }

                view.focus();
                window.clearTimeout(focusCorrectionTimer.current);

                focusCorrectionTimer.current = window.setTimeout(() => {
                    // The terminal may settle focus asynchronously, so reclaim it only if that won.
                    if (isTerminalInputTarget(document.activeElement)) {
                        view.focus();
                    }
                }, 0);
            },
        },
        view !== null,
    );
}

/** Reads the current range so chrome and tests can follow the editor selection. */
function editorSelectionFromState(state: EditorState): EditorSelection | null {
    const selection = state.selection.main;

    if (selection.empty) {
        return null;
    }

    return {
        text: state.sliceDoc(selection.from, selection.to),
        startLine: state.doc.lineAt(selection.from).number,
    };
}

/** The props the shared view reads when a file is shown, kept in a ref between renders. */
type CodeEditorProps = {
    /** Identifies the file's buffer, the same key as its entry in the open files list. */
    bufferKey: string;
    fileName: string;
    /** The device text; a clean buffer follows it, a dirty one only reports a conflict. */
    deviceContent: string;
    /** The buffer stored on the server, which restores unsaved edits after a reload. */
    stored: StoredBuffer | null;
    editable: boolean;
    vimMode: boolean;
    wrapLines: boolean;
    scrollToLine?: number;
    /** The open files list's request to show a line, once, when the file was opened elsewhere. */
    reveal?: OpenFileReveal;
    onFocus: () => void;
    onSave: () => void;
    /** The first edit of a clean buffer, which opens the file. */
    onBecameDirty: () => void;
    /**
     * A double click anywhere in the editor, which opens the file without changing it. The
     * click still selects a word as usual, so reading is never interrupted.
     */
    onDoubleClick?: () => void;
    onSelectionChange: (selection: EditorSelection | null) => void;
    searchHandleRef: React.RefObject<EditorSearchHandle | null>;
    isSearchOpen: boolean;
    onSearchOpenChange: (open: boolean) => void;
    /** Leaves find keys to the browser while the editor is hidden behind a preview. */
    captureFindKeys: boolean;
};

/**
 * Shows one file in the page's single CodeMirror view. The view and the file's buffer belong
 * to the editor workspace, so this component only attaches the view while mounted and feeds
 * it the file's device text, server copy and preferences. A bounded height lets CodeMirror
 * virtualize the viewport instead of growing the page.
 */
export function CodeEditor(props: CodeEditorProps) {
    const { editor: workspace } = rootRouteApi.useRouteContext();
    const resolvedTheme = useAtomValue(resolvedThemeAtom);

    // The resolved entry, not the live one: a navigation away changes the live location while
    // this file is still mounted, which would re-apply its `?line=` target on the way out.
    const lineEntry = useRouterState({
        select: (state) =>
            historyEntryKey(state.resolvedLocation ?? state.location),
    });

    const containerRef = React.useRef<HTMLDivElement>(null);
    const propsRef = React.useRef(props);
    propsRef.current = props;
    const hasReceivedFocusRef = React.useRef(false);
    const [view, setView] = React.useState<EditorView | null>(null);
    const [documentRevision, setDocumentRevision] = React.useState(0);
    const [caretLine, setCaretLine] = React.useState<number | null>(null);
    const [selectedText, setSelectedText] = React.useState<string | null>(null);

    const settings = {
        vimMode: props.vimMode,
        wrapLines: props.wrapLines,
        theme: resolvedTheme,
        editable: props.editable,
    };

    const settingsRef = React.useRef(settings);
    settingsRef.current = settings;

    const revealLine = props.reveal?.line;
    const revealId = props.reveal?.id;

    const lineTargets: LineTargets = {
        link:
            props.scrollToLine === undefined
                ? null
                : { line: props.scrollToLine, entry: lineEntry },
        reveal:
            revealLine === undefined || revealId === undefined
                ? null
                : { line: revealLine, entry: revealId },
    };

    const lineTargetsRef = React.useRef(lineTargets);
    lineTargetsRef.current = lineTargets;

    /** Mirrors the editor's caret and selection into the chrome and the accessible spans. */
    const syncFromState = React.useCallback((state: EditorState) => {
        setDocumentRevision((revision) => revision + 1);
        setCaretLine(state.doc.lineAt(state.selection.main.head).number);
        const nextSelection = editorSelectionFromState(state);
        setSelectedText(nextSelection?.text ?? null);
        propsRef.current.onSelectionChange(nextSelection);
    }, []);

    // The workspace calls these for whichever file is shown, so they read the latest props.
    const handlersRef = React.useRef<EditorHandlers>({
        onUpdate: (update: ViewUpdate) => {
            if (update.docChanged || update.selectionSet) {
                syncFromState(update.state);
            }
        },
        onFocus: () => {
            // The initial load is already fresh, so only later focus entries refetch.
            if (hasReceivedFocusRef.current) {
                propsRef.current.onFocus();
            } else {
                hasReceivedFocusRef.current = true;
            }
        },
        onSave: () => propsRef.current.onSave(),
        onBecameDirty: () => propsRef.current.onBecameDirty(),
        onStateReplaced: (state: EditorState) => syncFromState(state),
    });

    // Swaps this file's buffer into the shared view; leaving stashes it with its scroll.
    React.useLayoutEffect(() => {
        const container = containerRef.current;

        if (container === null) {
            return;
        }

        const current = propsRef.current;

        const shown = workspace.activate({
            container,
            key: current.bufferKey,
            fileName: current.fileName,
            deviceContent: current.deviceContent,
            stored: current.stored,
            settings: settingsRef.current,
            lineTargets: lineTargetsRef.current,
            handlers: handlersRef,
        });

        setView(shown);
        syncFromState(shown.state);

        return () => workspace.deactivate(container);
    }, [props.bufferKey, syncFromState, workspace]);

    React.useLayoutEffect(() => {
        workspace.applyDeviceContent(props.bufferKey, props.deviceContent);
    }, [props.bufferKey, props.deviceContent, workspace]);

    React.useLayoutEffect(() => {
        workspace.receiveStored(props.bufferKey, props.stored);
    }, [props.bufferKey, props.stored, workspace]);

    React.useLayoutEffect(() => {
        workspace.applySettings({
            vimMode: props.vimMode,
            wrapLines: props.wrapLines,
            theme: resolvedTheme,
            editable: props.editable,
        });
    }, [
        props.editable,
        props.vimMode,
        props.wrapLines,
        resolvedTheme,
        workspace,
    ]);

    // The targets are rebuilt from these values each render, so the ref holds the current ones.
    React.useLayoutEffect(() => {
        workspace.goToLine(props.bufferKey, lineTargetsRef.current);
    }, [
        lineEntry,
        props.bufferKey,
        props.scrollToLine,
        revealId,
        revealLine,
        workspace,
    ]);

    useFocusEditorShortcut(view);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EditorSearch
                view={view}
                editable={props.editable}
                documentRevision={documentRevision}
                handleRef={props.searchHandleRef}
                open={props.isSearchOpen}
                onOpenChange={props.onSearchOpenChange}
                captureFindKeys={props.captureFindKeys}
            />
            <div
                data-file-editor=""
                data-vim-mode={props.vimMode ? "true" : "false"}
                data-wrap-lines={props.wrapLines ? "true" : "false"}
                role="region"
                aria-label="Editor viewport"
                onDoubleClick={props.onDoubleClick}
                className="relative min-h-0 flex-1 overflow-hidden after:pointer-events-none after:absolute after:inset-0 after:z-20 after:border after:border-transparent focus-within:after:border-blue-500"
            >
                {caretLine === null ? null : (
                    <span className="sr-only" aria-label="Editor caret line">
                        {String(caretLine)}
                    </span>
                )}
                {selectedText === null ? null : (
                    <span className="sr-only" aria-label="Editor selected text">
                        {selectedText}
                    </span>
                )}
                <div ref={containerRef} className="h-full min-h-0" />
            </div>
        </div>
    );
}
