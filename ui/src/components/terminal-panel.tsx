import * as React from "react";
import { useAtomValue } from "jotai";

import type { Agent } from "#ui/api-client";
import { ActionMenuButton } from "#ui/components/action-menu";
import { ContextMenu } from "#ui/components/context-menu";
import { TerminalTabActions } from "#ui/components/terminal-tabs";
import { TerminalToolbar } from "#ui/components/terminal-toolbar";
import { Toast } from "#ui/components/toast";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { resolvedThemeAtom } from "#ui/theme-state";
import type {
    TerminalSession,
    TerminalTabSnapshot,
} from "#ui/terminal/terminal-session";
import type {
    ActiveTerminalTarget,
    TerminalSessions,
} from "#ui/terminal/terminal-sessions";
import { useTerminals, useTerminalsSnapshot } from "#ui/use-terminals";
import {
    isEditorInputTarget,
    isPlainKey,
    isUnmodifiedAltKey,
} from "#ui/utils/keyboard";

/**
 * Registers the open-terminal shortcuts: `t` outside text entry, and Alt+t from the editor,
 * where `t` would be typed. The registry runs them in the capture phase, so Alt+t reaches
 * the terminal action before Vim consumes the key. The registrations are stable, because the
 * registry reads the target and picker state through the latest render.
 */
function useTerminalShortcuts(
    terminals: TerminalSessions,
    activeTarget: ActiveTerminalTarget | null,
    isPickerOpen: boolean,
) {
    /** Opens the routed shell, or asks for a device when the route has no terminal target. */
    const openTerminal = () => {
        if (activeTarget === null && isPickerOpen) {
            return false;
        }

        terminals.openOrFocus(activeTarget);
    };

    useShortcut({
        name: "open-terminal",
        phase: "capture",
        priority: shortcutPriority.app,
        skipTypingTargets: true,
        match: (event) => isPlainKey(event, "t"),
        run: openTerminal,
    });

    useShortcut({
        name: "open-terminal-from-editor",
        phase: "capture",
        priority: shortcutPriority.app,
        match: (event) =>
            isUnmodifiedAltKey(event, "t") && isEditorInputTarget(event.target),
        run: openTerminal,
    });
}

/** Owns the terminal chrome only; the shells and tabs belong to the application's owner. */
export function TerminalPanel(props: {
    agents: Agent[];
    activeTarget: ActiveTerminalTarget | null;
    isFullWindow: boolean;
    onFullWindowChange: (isFullWindow: boolean) => void;
}) {
    const terminals = useTerminals();
    const snapshot = useTerminalsSnapshot();
    const resolvedTheme = useAtomValue(resolvedThemeAtom);

    React.useEffect(() => {
        terminals.setTheme(resolvedTheme);
    }, [terminals, resolvedTheme]);

    useTerminalShortcuts(terminals, props.activeTarget, snapshot.isPickerOpen);

    return (
        <section
            aria-label="Terminal panel"
            className="flex h-full min-h-0 flex-col bg-surface"
        >
            <TerminalToolbar
                isFullWindow={props.isFullWindow}
                onFullWindowChange={props.onFullWindowChange}
            >
                <TerminalTabActions
                    agents={props.agents}
                    activeTarget={props.activeTarget}
                    isPickerOpen={snapshot.isPickerOpen}
                    tabs={snapshot.tabs}
                    activeTabId={snapshot.activeTabId}
                    onCreate={(target) => terminals.create(target)}
                    onPickerOpenChange={(isOpen) =>
                        terminals.setPickerOpen(isOpen)
                    }
                    onClose={(tabId) => terminals.close(tabId)}
                    onMove={(move) => terminals.move(move)}
                    onRestart={(tabId) => terminals.restart(tabId)}
                    onSelect={(tabId) => terminals.select(tabId)}
                />
            </TerminalToolbar>
            <div
                data-terminal-theme={resolvedTheme}
                className={`relative min-h-0 flex-1 overflow-hidden bg-canvas ${props.isFullWindow ? "mx-2 mb-2 rounded-md @xl:mx-4 @xl:mb-4" : "rounded-md"}`}
            >
                {snapshot.tabs.map((tab) => {
                    const session = terminals.sessionFor(tab.id);

                    return session === undefined ? null : (
                        <TerminalView
                            key={tab.id}
                            tab={tab}
                            session={session}
                            terminals={terminals}
                            isActive={tab.id === snapshot.activeTabId}
                            isPanelVisible={snapshot.isPanelVisible}
                            focusEpoch={snapshot.focusEpoch}
                        />
                    );
                })}
                {snapshot.tabs.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
                        Open a terminal for a connected device to start a shell.
                    </div>
                ) : null}
            </div>
        </section>
    );
}

/**
 * Hosts one shell's element in the page. The session owns the emulator and the socket, so
 * this view only attaches and detaches the element, retries focusing after renders, and
 * offers the clipboard menu.
 */
function TerminalView(props: {
    tab: TerminalTabSnapshot;
    session: TerminalSession;
    terminals: TerminalSessions;
    isActive: boolean;
    isPanelVisible: boolean;
    focusEpoch: number;
}) {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const session = props.session;

    const [contextMenu, setContextMenu] = React.useState<{
        x: number;
        y: number;
        canCopy: boolean;
    } | null>(null);

    const [clipboardError, setClipboardError] = React.useState<string | null>(
        null,
    );

    React.useLayoutEffect(() => {
        const container = containerRef.current;

        if (!container) {
            return;
        }

        session.attach(container);

        return () => session.detach(container);
    }, [session]);

    React.useEffect(() => {
        const host = session.element;

        /** Replaces the browser menu so terminal copy and paste stay available. */
        const handleContextMenu = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                canCopy: session.getSelection().length > 0,
            });
        };

        host.addEventListener("contextmenu", handleContextMenu, true);

        return () =>
            host.removeEventListener("contextmenu", handleContextMenu, true);
    }, [session]);

    // A shell that was just revealed is inert until this commit, so focusing has to wait for
    // the render that follows the owner's request.
    React.useEffect(() => {
        props.terminals.flushFocus(props.tab.id);
    }, [
        props.terminals,
        props.tab.id,
        props.focusEpoch,
        props.isActive,
        props.isPanelVisible,
        props.tab.state.type,
    ]);

    /** Returns keyboard focus to the shell after the overlay closes. */
    const closeContextMenu = () => {
        setContextMenu(null);

        if (props.isActive && props.isPanelVisible) {
            session.focus();
        }
    };

    /** Copies only selection rendered inside this terminal's DOM host. */
    const copySelection = async () => {
        const text = session.getSelection();

        if (!text) {
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
        } catch {
            setClipboardError("Could not copy from the terminal");
        }
    };

    /** Sends sanitized clipboard text with the shell's requested paste framing. */
    const pasteClipboard = async () => {
        if (!session.isInitialized) {
            return;
        }

        try {
            const text = await navigator.clipboard.readText();

            if (text) {
                session.paste(text);
            }
        } catch {
            setClipboardError("Could not paste into the terminal");
        }
    };

    return (
        <div
            id={`terminal-panel-${props.tab.id}`}
            role="tabpanel"
            aria-labelledby={`terminal-tab-${props.tab.id}`}
            aria-hidden={!props.isActive}
            inert={!props.isActive}
            className={`absolute inset-0 rounded-md border border-transparent p-1.5 focus-within:border-blue-500 ${props.isActive ? "visible" : "invisible"}`}
        >
            <div ref={containerRef} className="h-full w-full" />
            <ContextMenu
                isOpen={contextMenu !== null}
                title="Terminal actions"
                closeAriaLabel="Close terminal actions"
                position={contextMenu}
                onClose={closeContextMenu}
            >
                {(close) => (
                    <>
                        <ActionMenuButton
                            disabled={!contextMenu?.canCopy}
                            onClick={() => {
                                void copySelection().finally(close);
                            }}
                        >
                            Copy
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => {
                                void pasteClipboard().finally(close);
                            }}
                        >
                            Paste
                        </ActionMenuButton>
                    </>
                )}
            </ContextMenu>
            {clipboardError ? (
                <Toast
                    tone="error"
                    dismissAriaLabel="Dismiss clipboard error"
                    onDismiss={() => setClipboardError(null)}
                >
                    {clipboardError}
                </Toast>
            ) : null}
            {props.tab.state.type === "disconnected" ? (
                <div
                    role="alert"
                    className="absolute inset-x-0 bottom-0 rounded-md border border-red-500/20 bg-error-tint/95 px-3 py-2 text-sm text-red-300 shadow-lg"
                >
                    {props.tab.state.message}
                </div>
            ) : null}
        </div>
    );
}
