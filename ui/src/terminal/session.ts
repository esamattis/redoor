import type * as React from "react";
import type {
    FitAddon as GhosttyFitAddon,
    IDisposable,
    ITheme,
    Terminal as GhosttyTerminal,
} from "ghostty-web";

import type { TerminalClientMessage } from "#ui/api-client";
import { initializeGhostty } from "#ui/terminal/ghostty";
import { getTerminalTheme } from "#ui/terminal/theme";

/** Groups mutable browser resources so teardown can release them consistently. */
export type TerminalResources = {
    terminalRef: React.RefObject<GhosttyTerminal | null>;
    fitAddonRef: React.RefObject<GhosttyFitAddon | null>;
    socketRef: React.RefObject<WebSocket | null>;
    terminalDisposablesRef: React.RefObject<IDisposable[]>;
    removeSocketListenersRef: React.RefObject<(() => void) | null>;
};

type GhosttyModule = Awaited<ReturnType<typeof initializeGhostty>>;

/** Opens a Ghostty emulator so theme remounts can reuse the same host setup. */
function openGhosttyTerminal(props: {
    ghostty: GhosttyModule;
    host: HTMLDivElement;
    theme: ITheme;
    ariaLabel: string;
}) {
    const terminal = new props.ghostty.Terminal({
        cursorBlink: true,
        fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: props.theme,
    });
    const fitAddon = new props.ghostty.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(props.host);
    props.host.setAttribute("aria-label", props.ariaLabel);
    props.host.setAttribute("data-terminal-input", "");
    fitAddon.fit();
    fitAddon.observeResize();
    return { terminal, fitAddon };
}

/** Binds I/O after remount so a theme change does not need a new websocket. */
export function bindTerminalInput(props: {
    terminal: GhosttyTerminal;
    socket: WebSocket;
    isReady: () => boolean;
}): IDisposable[] {
    const encoder = new TextEncoder();
    return [
        props.terminal.onData((data) => {
            if (props.isReady() && props.socket.readyState === WebSocket.OPEN) {
                props.socket.send(encoder.encode(data));
            }
        }),
        props.terminal.onResize((size) => {
            if (
                !props.isReady() ||
                props.socket.readyState !== WebSocket.OPEN
            ) {
                return;
            }
            const message: TerminalClientMessage = {
                type: "resize",
                size: { rows: size.rows, cols: size.cols },
            };
            props.socket.send(JSON.stringify(message));
        }),
    ];
}

/** Drops only the emulator so a theme change can keep the live PTY. */
function disposeGhosttyTerminal(
    resources: TerminalResources,
    hostRef: React.RefObject<HTMLDivElement | null>,
) {
    resources.terminalDisposablesRef.current.forEach((disposable) =>
        disposable.dispose(),
    );
    resources.terminalDisposablesRef.current = [];
    const terminal = resources.terminalRef.current;
    resources.terminalRef.current = null;
    resources.fitAddonRef.current = null;
    terminal?.dispose();
    hostRef.current?.replaceChildren();
}

/** Releases every resource associated with only this terminal tab. */
export function disposeTerminalResources(props: {
    resources: TerminalResources;
    hostRef: React.RefObject<HTMLDivElement | null>;
    isReadyRef: React.RefObject<boolean>;
    appliedThemeRef: React.RefObject<"dark" | "light" | null>;
}) {
    const socket = props.resources.socketRef.current;
    props.resources.socketRef.current = null;
    props.resources.removeSocketListenersRef.current?.();
    props.resources.removeSocketListenersRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
    }
    props.isReadyRef.current = false;
    props.appliedThemeRef.current = null;
    disposeGhosttyTerminal(props.resources, props.hostRef);
}

/** Mounts Ghostty with the current theme and stores it on the session refs. */
export function mountGhostty(props: {
    ghostty: GhosttyModule;
    host: HTMLDivElement;
    themeMode: "dark" | "light";
    ariaLabel: string;
    resources: TerminalResources;
    appliedThemeRef: React.RefObject<"dark" | "light" | null>;
}) {
    const { terminal, fitAddon } = openGhosttyTerminal({
        ghostty: props.ghostty,
        host: props.host,
        theme: getTerminalTheme(props.themeMode),
        ariaLabel: props.ariaLabel,
    });
    props.resources.terminalRef.current = terminal;
    props.resources.fitAddonRef.current = fitAddon;
    props.appliedThemeRef.current = props.themeMode;
    return terminal;
}

/**
 * Ghostty bakes default colors into WASM at create time, so a live theme
 * change remounts the emulator while the shell socket stays open.
 */
export async function remountGhosttyForTheme(props: {
    themeMode: "dark" | "light";
    resources: TerminalResources;
    hostRef: React.RefObject<HTMLDivElement | null>;
    appliedThemeRef: React.RefObject<"dark" | "light" | null>;
    isReadyRef: React.RefObject<boolean>;
    ariaLabel: string;
    shouldFocus: () => boolean;
}) {
    const socket = props.resources.socketRef.current;
    const host = props.hostRef.current;
    if (!socket || !host || !props.resources.terminalRef.current) {
        return;
    }
    disposeGhosttyTerminal(props.resources, props.hostRef);
    props.appliedThemeRef.current = null;
    const ghostty = await initializeGhostty();
    if (
        props.resources.socketRef.current !== socket ||
        props.resources.terminalRef.current
    ) {
        return;
    }
    const terminal = mountGhostty({
        ghostty,
        host,
        themeMode: props.themeMode,
        ariaLabel: props.ariaLabel,
        resources: props.resources,
        appliedThemeRef: props.appliedThemeRef,
    });
    props.resources.terminalDisposablesRef.current = bindTerminalInput({
        terminal,
        socket,
        isReady: () => props.isReadyRef.current,
    });
    props.resources.fitAddonRef.current?.fit();
    if (props.shouldFocus()) {
        terminal.focus();
    }
}
