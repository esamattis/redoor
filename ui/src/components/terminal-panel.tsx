import * as React from "react";
import { RotateCcw, SquareTerminal, X } from "lucide-react";
import type {
    FitAddon as GhosttyFitAddon,
    IDisposable,
    Terminal as GhosttyTerminal,
} from "ghostty-web";

import {
    type Agent,
    type TerminalClientMessage,
    type TerminalServerMessage,
} from "@/api-client";
import { initializeGhostty } from "@/terminal/ghostty";
import { CollapsibleBottomPanel } from "@/components/collapsible-bottom-panel";

type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

/** Validates untrusted socket text before it enters the typed lifecycle. */
function parseServerMessage(value: unknown): TerminalServerMessage | null {
    if (typeof value !== "object" || value === null || !("type" in value)) {
        return null;
    }
    if (value.type === "ready") {
        return { type: "ready" };
    }
    if (
        value.type === "error" &&
        "message" in value &&
        typeof value.message === "string"
    ) {
        return { type: "error", message: value.message };
    }
    if (
        value.type === "exit" &&
        "code" in value &&
        (typeof value.code === "number" || value.code === null) &&
        "signal" in value &&
        (typeof value.signal === "number" || value.signal === null)
    ) {
        return { type: "exit", code: value.code, signal: value.signal };
    }
    return null;
}

/** Converts a server lifecycle notification into a useful terminal status. */
function getServerDisconnectMessage(
    message: TerminalServerMessage,
): string | null {
    if (message.type === "error") {
        return message.message;
    }
    if (message.type === "exit") {
        if (message.code !== null) {
            return `Shell exited with code ${message.code}`;
        }
        if (message.signal !== null) {
            return `Shell exited from signal ${message.signal}`;
        }
        return "Shell exited";
    }
    return null;
}

/** Owns one ephemeral terminal and tears it down when its agent route unmounts. */
export function TerminalPanel(props: { agent: Agent }) {
    const [isCollapsed, setIsCollapsed] = React.useState(true);
    const [terminalState, setTerminalState] = React.useState<TerminalState>({
        type: "not_started",
    });
    const stateRef = React.useRef<TerminalState>({ type: "not_started" });
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<GhosttyTerminal | null>(null);
    const fitAddonRef = React.useRef<GhosttyFitAddon | null>(null);
    const socketRef = React.useRef<WebSocket | null>(null);
    const terminalDisposablesRef = React.useRef<IDisposable[]>([]);
    const removeSocketListenersRef = React.useRef<(() => void) | null>(null);
    const generationRef = React.useRef(0);

    /** Keeps event handlers synchronized with the rendered state. */
    const updateTerminalState = (nextState: TerminalState) => {
        stateRef.current = nextState;
        setTerminalState(nextState);
    };

    /** Releases every per-session browser resource; callers invalidate it first. */
    const disposeResources = () => {
        const socket = socketRef.current;
        socketRef.current = null;
        removeSocketListenersRef.current?.();
        removeSocketListenersRef.current = null;
        if (
            socket &&
            socket.readyState !== WebSocket.CLOSING &&
            socket.readyState !== WebSocket.CLOSED
        ) {
            socket.close();
        }

        terminalDisposablesRef.current.forEach((disposable) =>
            disposable.dispose(),
        );
        terminalDisposablesRef.current = [];

        const terminal = terminalRef.current;
        terminalRef.current = null;
        fitAddonRef.current = null;
        terminal?.dispose();
        hostRef.current?.replaceChildren();
    };

    /** Returns setup failures to the exact minimized, uninitialized launcher. */
    const resetAfterSetupFailure = (generation: number) => {
        if (generationRef.current !== generation) {
            return;
        }
        generationRef.current += 1;
        disposeResources();
        updateTerminalState({ type: "not_started" });
        setIsCollapsed(true);
    };

    /** Preserves the canvas while exposing an explicit recovery action. */
    const showDisconnected = (generation: number, message: string) => {
        if (generationRef.current !== generation) {
            return;
        }
        updateTerminalState({ type: "disconnected", message });
        setIsCollapsed(false);
    };

    /** Creates Ghostty and the dedicated socket only after a user expands. */
    const startTerminal = async () => {
        if (stateRef.current.type !== "not_started") {
            return;
        }

        const generation = generationRef.current + 1;
        generationRef.current = generation;
        updateTerminalState({ type: "initializing" });

        try {
            const ghostty = await initializeGhostty();
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
            );

            if (generationRef.current !== generation) {
                return;
            }

            const host = hostRef.current;
            if (!host) {
                resetAfterSetupFailure(generation);
                return;
            }

            const terminal = new ghostty.Terminal({
                cursorBlink: true,
                fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                fontSize: 13,
                scrollback: 5000,
                theme: {
                    background: "#0b0d12",
                    foreground: "#cbd5e1",
                    cursor: "#60a5fa",
                    selectionBackground: "#334155",
                },
            });
            terminalRef.current = terminal;
            const fitAddon = new ghostty.FitAddon();
            fitAddonRef.current = fitAddon;
            terminal.loadAddon(fitAddon);
            terminal.open(host);
            host.setAttribute("aria-label", `Terminal for ${props.agent.name}`);
            fitAddon.fit();
            fitAddon.observeResize();

            if (generationRef.current !== generation) {
                return;
            }

            updateTerminalState({ type: "connecting" });
            const socket = new WebSocket(
                props.agent.getTerminalWebSocketUrl({
                    rows: terminal.rows,
                    cols: terminal.cols,
                }),
            );
            socket.binaryType = "arraybuffer";
            socketRef.current = socket;
            const encoder = new TextEncoder();
            let isReady = false;

            terminalDisposablesRef.current = [
                terminal.onData((data) => {
                    if (isReady && socket.readyState === WebSocket.OPEN) {
                        socket.send(encoder.encode(data));
                    }
                }),
                terminal.onResize((size) => {
                    if (!isReady || socket.readyState !== WebSocket.OPEN) {
                        return;
                    }
                    const message: TerminalClientMessage = {
                        type: "resize",
                        size: { rows: size.rows, cols: size.cols },
                    };
                    socket.send(JSON.stringify(message));
                }),
            ];

            /** Applies typed binary output and lifecycle notifications. */
            const handleMessage = (event: MessageEvent) => {
                if (generationRef.current !== generation) {
                    return;
                }
                if (event.data instanceof ArrayBuffer) {
                    terminal.write(new Uint8Array(event.data));
                    return;
                }
                if (typeof event.data !== "string") {
                    socket.close(1002, "Unsupported terminal frame");
                    return;
                }

                let parsedMessage: unknown;
                try {
                    parsedMessage = JSON.parse(event.data);
                } catch {
                    socket.close(1002, "Invalid terminal control message");
                    return;
                }
                const message = parseServerMessage(parsedMessage);
                if (!message) {
                    socket.close(1002, "Invalid terminal control message");
                    return;
                }

                if (message.type === "ready") {
                    isReady = true;
                    updateTerminalState({ type: "connected" });
                    fitAddon.fit();
                    terminal.focus();
                    return;
                }

                const disconnectMessage = getServerDisconnectMessage(message);
                if (!disconnectMessage) {
                    socket.close(1002, "Invalid terminal control message");
                    return;
                }
                showDisconnected(generation, disconnectMessage);
                socket.close();
            };

            /** Distinguishes failed setup from loss of an established shell. */
            const handleClose = () => {
                if (generationRef.current !== generation) {
                    return;
                }
                if (stateRef.current.type === "disconnected") {
                    return;
                }
                if (!isReady) {
                    resetAfterSetupFailure(generation);
                    return;
                }
                showDisconnected(generation, "Terminal connection closed");
            };

            /** Relies on the close event for one deterministic state transition. */
            const handleError = () => {
                if (generationRef.current === generation) {
                    socket.close();
                }
            };

            socket.addEventListener("message", handleMessage);
            socket.addEventListener("close", handleClose);
            socket.addEventListener("error", handleError);
            removeSocketListenersRef.current = () => {
                socket.removeEventListener("message", handleMessage);
                socket.removeEventListener("close", handleClose);
                socket.removeEventListener("error", handleError);
            };
        } catch {
            resetAfterSetupFailure(generation);
        }
    };

    /** Implements minimize, first expansion, and live-session refitting. */
    const handleCollapsedChange = (nextCollapsed: boolean) => {
        setIsCollapsed(nextCollapsed);
        if (nextCollapsed) {
            return;
        }
        if (stateRef.current.type === "not_started") {
            void startTerminal();
            return;
        }
        if (stateRef.current.type === "connected") {
            const generation = generationRef.current;
            requestAnimationFrame(() => {
                if (generationRef.current !== generation) {
                    return;
                }
                fitAddonRef.current?.fit();
                terminalRef.current?.focus();
            });
        }
    };

    /** Explicit close destroys the session and restores the initial launcher. */
    const closeTerminal = () => {
        generationRef.current += 1;
        disposeResources();
        updateTerminalState({ type: "not_started" });
        setIsCollapsed(true);
    };

    /** Restart always tears down old client resources before creating a shell. */
    const restartTerminal = () => {
        generationRef.current += 1;
        disposeResources();
        updateTerminalState({ type: "not_started" });
        setIsCollapsed(false);
        void startTerminal();
    };

    React.useEffect(() => {
        return () => {
            generationRef.current += 1;
            disposeResources();
        };
    }, []);

    const statusLabel =
        terminalState.type === "not_started"
            ? "Not started"
            : terminalState.type === "connected"
              ? "Connected"
              : terminalState.type === "disconnected"
                ? "Disconnected"
                : "Connecting";
    const statusColor =
        terminalState.type === "connected"
            ? "bg-emerald-500/10 text-emerald-400"
            : terminalState.type === "disconnected"
              ? "bg-red-500/10 text-red-400"
              : "bg-slate-800 text-slate-400";

    return (
        <CollapsibleBottomPanel
            title="Terminal"
            description={`Shell on ${props.agent.name}`}
            icon={<SquareTerminal className="h-4 w-4" />}
            badge={
                <span
                    role="status"
                    className={`rounded-md px-2 py-0.5 text-xs font-medium ${statusColor}`}
                >
                    {statusLabel}
                </span>
            }
            actions={
                <div className="flex items-center gap-1">
                    {terminalState.type === "disconnected" ? (
                        <button
                            type="button"
                            onClick={restartTerminal}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Restart
                        </button>
                    ) : null}
                    {terminalState.type !== "not_started" ? (
                        <button
                            type="button"
                            aria-label="Close terminal"
                            title="Close terminal"
                            onClick={closeTerminal}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    ) : null}
                </div>
            }
            isCollapsed={isCollapsed}
            onCollapsedChange={handleCollapsedChange}
            keepChildrenMounted
            defaultExpandedHeight={400}
        >
            <div className="relative h-full overflow-hidden rounded-md bg-[#0b0d12] p-2">
                <div
                    ref={hostRef}
                    aria-label={`Terminal for ${props.agent.name}`}
                    className="h-full w-full overflow-hidden caret-transparent"
                />
                {terminalState.type === "disconnected" ? (
                    <div
                        role="alert"
                        className="absolute inset-x-2 bottom-2 rounded-md border border-red-500/20 bg-[#161018]/95 px-3 py-2 text-sm text-red-300 shadow-lg"
                    >
                        {terminalState.message}
                    </div>
                ) : null}
            </div>
        </CollapsibleBottomPanel>
    );
}
