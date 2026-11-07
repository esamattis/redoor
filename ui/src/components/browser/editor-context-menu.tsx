import React from "react";
import { toggleComment } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { useMutation } from "@tanstack/react-query";
import {
    ClipboardCopy,
    ClipboardPaste,
    Copy,
    MessageSquareCode,
    Scissors,
    Search,
    TextSearch,
} from "lucide-react";
import {
    ContextMenu,
    ContextMenuItem,
    ContextMenuSeparator,
} from "#ui/components/context-menu";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { toggleCommentChord } from "#ui/editor/editor-extensions";
import { getErrorMessage } from "#ui/utils/error";
import { formatKeyChord, type KeyChord } from "#ui/utils/keyboard";

/**
 * Searches the selection in the file's directory. Shift+S because plain Mod+S saves, and the
 * code editor's shortcut binding matches this chord so the menu hint stays truthful.
 */
export const directorySearchChord: KeyChord = {
    mod: true,
    shift: true,
    key: "s",
};

/** The clipboard work behind each menu action, so one mutation reports all their failures. */
type EditorClipboardAction = "copy" | "cut" | "paste" | "copy-reference";

/** Names each failed action in its error toast, since the clipboard API gives no reason. */
const failureMessages = {
    copy: "Could not copy the selection",
    cut: "Could not cut the selection",
    paste: "Could not paste into the editor",
    "copy-reference": "Could not copy the file reference",
} satisfies Record<EditorClipboardAction, string>;

/**
 * Wraps the editor's CodeMirror view with the operations the context menu offers. Reading
 * the view at call time rather than at render time keeps the actions on the live selection,
 * which the user may have changed while the menu was open via the keyboard.
 */
class EditorMenuActions {
    constructor(
        private readonly view: EditorView,
        private readonly filePath: string,
    ) {}

    /** Whether any selection range has text, which copy and cut need. */
    hasSelection(): boolean {
        return this.view.state.selection.ranges.some((range) => !range.empty);
    }

    /** Joins every selection range, the way CodeMirror's own copy handles multiple cursors. */
    private selectedText(): string {
        const state = this.view.state;

        return state.selection.ranges
            .filter((range) => !range.empty)
            .map((range) => state.sliceDoc(range.from, range.to))
            .join(state.lineBreak);
    }

    /** Copies before deleting, so a refused clipboard never loses the user's text. */
    async run(action: EditorClipboardAction): Promise<void> {
        switch (action) {
            case "copy":
                await navigator.clipboard.writeText(this.selectedText());

                return;
            case "cut":
                await navigator.clipboard.writeText(this.selectedText());
                this.view.dispatch({
                    ...this.view.state.replaceSelection(""),
                    userEvent: "delete.cut",
                    scrollIntoView: true,
                });

                return;
            case "paste": {
                const text = await navigator.clipboard.readText();

                if (text) {
                    this.view.dispatch({
                        ...this.view.state.replaceSelection(text),
                        userEvent: "input.paste",
                        scrollIntoView: true,
                    });
                }

                return;
            }

            case "copy-reference":
                await navigator.clipboard.writeText(this.fileReference());

                return;
        }
    }

    /**
     * Formats the main selection as a fenced block headed by `path#Lline`, which AI agents
     * resolve back to the file and line the snippet came from.
     */
    private fileReference(): string {
        const state = this.view.state;
        const selection = state.selection.main;

        if (selection.empty) {
            throw new Error("Select text in the editor before copying");
        }

        const startLine = state.doc.lineAt(selection.from).number;
        const text = state.sliceDoc(selection.from, selection.to);

        return `\`\`\`${this.filePath}#L${startLine}
${text}
\`\`\``;
    }

    /** Comments or uncomments the selected lines with the file language's comment syntax. */
    toggleComment(): void {
        toggleComment(this.view);
    }

    /** Hands the keyboard back so typing continues where the user right-clicked. */
    focus(): void {
        this.view.focus();
    }
}

/**
 * Replaces the browser's context menu in the code editor with clipboard, search, comment and
 * AI reference actions. The browser menu cannot cut or paste through CodeMirror's own
 * transactions, and the selection actions belong next to the selection they act on.
 */
export function EditorContextMenu(props: {
    view: EditorView;
    filePath: string;
    editable: boolean;
    position: { x: number; y: number } | null;
    onClose: () => void;
    /** Opens the editor's own find panel, which picks up a one-line selection as its query. */
    onFindInFile: () => void;
    /** Null when the file must not be searched on the agent, such as an encrypted one. */
    onSearchDirectory: (() => boolean) | null;
}) {
    const actions = new EditorMenuActions(props.view, props.filePath);
    const hasSelection = props.position !== null && actions.hasSelection();

    const clipboardMutation = useMutation({
        mutationFn: (action: EditorClipboardAction) => actions.run(action),
    });

    /** Closes the menu first, so focus returns to the editor while the clipboard settles. */
    const runClipboardAction = (action: EditorClipboardAction) => {
        props.onClose();
        actions.focus();
        clipboardMutation.mutate(action);
    };

    const failedAction = clipboardMutation.isError
        ? clipboardMutation.variables
        : undefined;

    return (
        <>
            <ContextMenu
                isOpen={props.position !== null}
                title="Editor context menu"
                closeAriaLabel="Close editor context menu"
                position={props.position}
                onClose={() => {
                    props.onClose();
                    actions.focus();
                }}
            >
                {() => (
                    <>
                        <ContextMenuItem
                            icon={<Scissors className="h-4 w-4" />}
                            shortcut={formatKeyChord({ mod: true, key: "x" })}
                            disabled={!props.editable || !hasSelection}
                            onClick={() => runClipboardAction("cut")}
                        >
                            Cut
                        </ContextMenuItem>
                        <ContextMenuItem
                            icon={<Copy className="h-4 w-4" />}
                            shortcut={formatKeyChord({ mod: true, key: "c" })}
                            disabled={!hasSelection}
                            onClick={() => runClipboardAction("copy")}
                        >
                            Copy
                        </ContextMenuItem>
                        <ContextMenuItem
                            icon={<ClipboardPaste className="h-4 w-4" />}
                            shortcut={formatKeyChord({ mod: true, key: "v" })}
                            disabled={!props.editable}
                            onClick={() => runClipboardAction("paste")}
                        >
                            Paste
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            icon={<TextSearch className="h-4 w-4" />}
                            shortcut={formatKeyChord({ mod: true, key: "f" })}
                            onClick={() => {
                                props.onClose();
                                props.onFindInFile();
                            }}
                        >
                            Find in file
                        </ContextMenuItem>
                        <Tooltip content="Search the selected text in file contents">
                            <ContextMenuItem
                                icon={<Search className="h-4 w-4" />}
                                shortcut={formatKeyChord(directorySearchChord)}
                                disabled={
                                    !hasSelection ||
                                    props.onSearchDirectory === null
                                }
                                onClick={() => {
                                    props.onClose();
                                    props.onSearchDirectory?.();
                                }}
                            >
                                Search in file&apos;s directory
                            </ContextMenuItem>
                        </Tooltip>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            icon={<MessageSquareCode className="h-4 w-4" />}
                            shortcut={formatKeyChord(toggleCommentChord)}
                            disabled={!props.editable}
                            onClick={() => {
                                props.onClose();
                                actions.toggleComment();
                                actions.focus();
                            }}
                        >
                            Toggle comment
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <Tooltip content="Copy as a path#Lline code block for AI prompts">
                            <ContextMenuItem
                                icon={<ClipboardCopy className="h-4 w-4" />}
                                disabled={!hasSelection}
                                onClick={() =>
                                    runClipboardAction("copy-reference")
                                }
                            >
                                Copy with file reference
                            </ContextMenuItem>
                        </Tooltip>
                    </>
                )}
            </ContextMenu>
            {failedAction !== undefined ? (
                <Toast
                    tone="error"
                    dismissAriaLabel="Dismiss editor clipboard message"
                    onDismiss={() => clipboardMutation.reset()}
                >
                    {getErrorMessage(
                        clipboardMutation.error,
                        failureMessages[failedAction],
                    )}
                </Toast>
            ) : null}
            {clipboardMutation.isSuccess &&
            clipboardMutation.variables === "copy-reference" ? (
                <Toast
                    tone="success"
                    icon={<ClipboardCopy className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss copy reference message"
                    onDismiss={() => clipboardMutation.reset()}
                >
                    Copied selection with file reference
                </Toast>
            ) : null}
        </>
    );
}
