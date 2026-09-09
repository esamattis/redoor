import type * as React from "react";
import type { WTerm } from "@wterm/dom";
import type { GhosttyCore } from "@wterm/ghostty";

import type { TerminalClientMessage } from "#ui/api-client";
import type { OneShotTerminalCommand } from "#ui/terminal/one-shot-command";

/** Groups mutable browser resources so teardown can release them consistently. */
export type TerminalResources = {
    terminalRef: React.RefObject<WTerm | null>;
    coreRef: React.RefObject<GhosttyCore | null>;
    socketRef: React.RefObject<WebSocket | null>;
    removeSocketListenersRef: React.RefObject<(() => void) | null>;
    startupCommand: OneShotTerminalCommand | null;
};

/** Sends terminal text as UTF-8 only after the server has accepted the PTY session. */
export function sendTerminalInput(props: {
    resources: TerminalResources;
    isReady: () => boolean;
    data: string;
}): void {
    const socket = props.resources.socketRef.current;
    if (!props.isReady() || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    socket.send(new TextEncoder().encode(props.data));
}

/** Sends current terminal geometry without allowing hidden layouts to resize the PTY to 1x1. */
export function sendTerminalResize(props: {
    resources: TerminalResources;
    isReady: () => boolean;
    canResize: () => boolean;
    cols: number;
    rows: number;
}): void {
    const socket = props.resources.socketRef.current;
    if (
        !props.isReady() ||
        !props.canResize() ||
        !socket ||
        socket.readyState !== WebSocket.OPEN
    ) {
        return;
    }
    const message: TerminalClientMessage = {
        type: "resize",
        size: { rows: props.rows, cols: props.cols },
    };
    socket.send(JSON.stringify(message));
}

/** Releases every resource associated with only this terminal tab. */
export function disposeTerminalResources(props: {
    resources: TerminalResources;
    hostRef: React.RefObject<HTMLDivElement | null>;
    isReadyRef: React.RefObject<boolean>;
}): void {
    props.resources.startupCommand?.cancelPending();
    const socket = props.resources.socketRef.current;
    props.resources.socketRef.current = null;
    props.resources.removeSocketListenersRef.current?.();
    props.resources.removeSocketListenersRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
    }
    props.isReadyRef.current = false;

    const terminal = props.resources.terminalRef.current;
    const core = props.resources.coreRef.current;
    props.resources.terminalRef.current = null;
    props.resources.coreRef.current = null;
    terminal?.destroy();
    core?.dispose();
    props.hostRef.current?.removeAttribute("data-terminal-initialized");
    props.hostRef.current?.replaceChildren();
}
