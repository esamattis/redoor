import * as React from "react";
import {
    CircleCheck,
    CircleX,
    LoaderCircle,
    Plus,
    RotateCcw,
    SquareTerminal,
    X,
} from "lucide-react";
import type {
    FitAddon as GhosttyFitAddon,
    IDisposable,
    Terminal as GhosttyTerminal,
} from "ghostty-web";

import {
    type Agent,
    type TerminalClientMessage,
    type TerminalServerMessage,
} from "#ui/api-client";
import { initializeGhostty } from "#ui/terminal/ghostty";
import { CollapsibleBottomPanel } from "#ui/components/collapsible-bottom-panel";

type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

/** Keeps each tab's creation directory and lifecycle independent. */
type TerminalTab = {
    id: number;
    title: string;
    cwd: string;
    state: TerminalState;
    restartGeneration: number;
};

/** Gives each terminal tab its own concise lifecycle label and color. */
function getTerminalStatus(state: TerminalState) {
    if (state.type === "connected") {
        return {
            label: "Connected",
            color: "text-emerald-400",
        };
    }
    if (state.type === "disconnected") {
        return {
            label: "Disconnected",
            color: "text-red-400",
        };
    }
    return {
        label: "Connecting",
        color: "text-slate-400",
    };
}

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

/** Owns all ephemeral terminal tabs for the currently routed agent. */
export function TerminalPanel(props: { agent: Agent; cwd: string }) {
    const [isCollapsed, setIsCollapsed] = React.useState(true);
    const [tabs, setTabs] = React.useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = React.useState<number | null>(null);
    const nextTabIdRef = React.useRef(1);

    /** Captures the visible browser directory without changing older tabs. */
    const createTerminal = () => {
        const id = nextTabIdRef.current;
        nextTabIdRef.current += 1;
        setTabs((currentTabs) => [
            ...currentTabs,
            {
                id,
                title: `Terminal ${id}`,
                cwd: props.cwd,
                state: { type: "not_started" },
                restartGeneration: 0,
            },
        ]);
        setActiveTabId(id);
        setIsCollapsed(false);
    };

    /** Updates only the session that emitted a lifecycle transition. */
    const updateTabState = (tabId: number, state: TerminalState) => {
        setTabs((currentTabs) =>
            currentTabs.map((tab) =>
                tab.id === tabId ? { ...tab, state } : tab,
            ),
        );
    };

    /** Removes one session and chooses its nearest surviving neighbor. */
    const closeTerminal = (tabId: number) => {
        const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1) {
            return;
        }

        const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
        setTabs(remainingTabs);
        if (activeTabId === tabId) {
            const replacement =
                remainingTabs[tabIndex] ?? remainingTabs[tabIndex - 1] ?? null;
            setActiveTabId(replacement?.id ?? null);
        }
        if (remainingTabs.length === 0) {
            setIsCollapsed(true);
        }
    };

    /** Requests a fresh shell while preserving the tab's identity and cwd. */
    const restartTerminal = (tabId: number) => {
        setTabs((currentTabs) =>
            currentTabs.map((tab) =>
                tab.id === tabId
                    ? {
                          ...tab,
                          state: { type: "not_started" },
                          restartGeneration: tab.restartGeneration + 1,
                      }
                    : tab,
            ),
        );
        setActiveTabId(tabId);
        setIsCollapsed(false);
    };

    /** Gives arrow keys browser-style selection across terminal tabs. */
    const handleTabKeyDown = (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
        }
        const offset = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (tabIndex + offset + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex];
        if (!nextTab) {
            return;
        }
        setActiveTabId(nextTab.id);
        document.getElementById(`terminal-tab-${nextTab.id}`)?.focus();
        event.preventDefault();
    };

    return (
        <CollapsibleBottomPanel
            title="Terminal"
            description={`Shells on ${props.agent.name}`}
            icon={<SquareTerminal className="h-4 w-4" />}
            badge={
                <span
                    role="status"
                    aria-label="Terminal count"
                    className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-400"
                >
                    {tabs.length === 0
                        ? "No terminals"
                        : `${tabs.length} terminal${tabs.length === 1 ? "" : "s"}`}
                </span>
            }
            actions={
                <TerminalTabActions
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onCreate={createTerminal}
                    onClose={closeTerminal}
                    onRestart={restartTerminal}
                    onSelect={setActiveTabId}
                    onTabKeyDown={handleTabKeyDown}
                />
            }
            actionsAlignment="start"
            isCollapsed={isCollapsed}
            onCollapsedChange={setIsCollapsed}
            keepChildrenMounted
            defaultExpandedHeight={400}
        >
            <div className="relative h-full overflow-hidden rounded-md bg-[#0b0d12] p-2">
                {tabs.map((tab) => (
                    <TerminalSession
                        key={tab.id}
                        agent={props.agent}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        isPanelCollapsed={isCollapsed}
                        onStateChange={updateTabState}
                    />
                ))}
            </div>
        </CollapsibleBottomPanel>
    );
}

/** Renders terminal-tab controls while keeping panel lifecycle state local to the parent. */
function TerminalTabActions(props: {
    tabs: TerminalTab[];
    activeTabId: number | null;
    onCreate: () => void;
    onClose: (tabId: number) => void;
    onRestart: (tabId: number) => void;
    onSelect: (tabId: number) => void;
    onTabKeyDown: (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => void;
}) {
    return (
        <div className="flex min-w-0 max-w-full items-center gap-1">
            <div
                role="tablist"
                aria-label="Terminal tabs"
                className="flex min-h-8 min-w-px flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
            >
                {props.tabs.map((tab, tabIndex) => {
                    const status = getTerminalStatus(tab.state);
                    const isActive = tab.id === props.activeTabId;
                    return (
                        <div
                            key={tab.id}
                            className={`flex shrink-0 items-center overflow-hidden rounded-md border transition-colors ${
                                isActive
                                    ? "border-blue-500/50 bg-slate-700 shadow-[0_0_0_1px_rgba(59,130,246,0.12)]"
                                    : "border-slate-700 bg-slate-900"
                            }`}
                            title={`${tab.title}: ${tab.cwd}`}
                        >
                            <button
                                type="button"
                                id={`terminal-tab-${tab.id}`}
                                role="tab"
                                aria-label={tab.title}
                                aria-selected={isActive}
                                aria-controls={`terminal-panel-${tab.id}`}
                                tabIndex={isActive ? 0 : -1}
                                onClick={() => props.onSelect(tab.id)}
                                onKeyDown={(event) =>
                                    props.onTabKeyDown(event, tabIndex)
                                }
                                className={`flex h-8 items-center gap-2 px-2.5 text-xs font-medium transition-colors ${
                                    isActive
                                        ? "text-slate-100"
                                        : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                                }`}
                            >
                                <span className="whitespace-nowrap">
                                    {tab.title}
                                </span>
                                <span
                                    role="status"
                                    aria-label={`${tab.title}: ${status.label}`}
                                    title={status.label}
                                    className={status.color}
                                >
                                    {tab.state.type === "connected" ? (
                                        <CircleCheck className="h-3.5 w-3.5" />
                                    ) : tab.state.type === "disconnected" ? (
                                        <CircleX className="h-3.5 w-3.5" />
                                    ) : (
                                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                    )}
                                </span>
                            </button>
                            {tab.state.type === "disconnected" ? (
                                <button
                                    type="button"
                                    aria-label={`Restart ${tab.title}`}
                                    title={`Restart ${tab.title}`}
                                    onClick={() => props.onRestart(tab.id)}
                                    className="inline-flex h-8 w-7 items-center justify-center border-l border-red-500/20 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                            ) : null}
                            <button
                                type="button"
                                aria-label={`Close ${tab.title}`}
                                title={`Close ${tab.title}`}
                                onClick={() => props.onClose(tab.id)}
                                className="inline-flex h-8 w-7 items-center justify-center border-l border-slate-700 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <button
                type="button"
                aria-label="New terminal"
                title="New terminal"
                onClick={props.onCreate}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
            >
                <Plus className="h-4 w-4" />
            </button>
        </div>
    );
}

/** Describes the parent-managed state and callbacks required by one terminal session. */
type TerminalSessionProps = {
    agent: Agent;
    tab: TerminalTab;
    isActive: boolean;
    isPanelCollapsed: boolean;
    onStateChange: (tabId: number, state: TerminalState) => void;
};

/** Groups mutable browser resources so teardown can release them consistently. */
type TerminalResources = {
    terminalRef: React.RefObject<GhosttyTerminal | null>;
    fitAddonRef: React.RefObject<GhosttyFitAddon | null>;
    socketRef: React.RefObject<WebSocket | null>;
    terminalDisposablesRef: React.RefObject<IDisposable[]>;
    removeSocketListenersRef: React.RefObject<(() => void) | null>;
};

/** Connects one initialized terminal to its shell while keeping socket protocol handling isolated. */
function connectTerminal(props: {
    agent: Agent;
    cwd: string;
    generation: number;
    resources: TerminalResources;
    terminal: GhosttyTerminal;
    updateTerminalState: (state: TerminalState) => void;
    showDisconnected: (generation: number, message: string) => void;
    generationRef: React.RefObject<number>;
    stateRef: React.RefObject<TerminalState>;
    isActiveRef: React.RefObject<boolean>;
    isPanelCollapsedRef: React.RefObject<boolean>;
}) {
    const socket = new WebSocket(
        props.agent.getTerminalWebSocketUrl(
            { rows: props.terminal.rows, cols: props.terminal.cols },
            props.cwd,
        ),
    );
    socket.binaryType = "arraybuffer";
    props.resources.socketRef.current = socket;
    const encoder = new TextEncoder();
    let isReady = false;

    props.resources.terminalDisposablesRef.current = [
        props.terminal.onData((data) => {
            if (isReady && socket.readyState === WebSocket.OPEN) {
                socket.send(encoder.encode(data));
            }
        }),
        props.terminal.onResize((size) => {
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
        if (props.generationRef.current !== props.generation) {
            return;
        }
        if (event.data instanceof ArrayBuffer) {
            props.terminal.write(new Uint8Array(event.data));
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
            props.updateTerminalState({ type: "connected" });
            if (
                props.isActiveRef.current &&
                !props.isPanelCollapsedRef.current
            ) {
                props.resources.fitAddonRef.current?.fit();
                props.terminal.focus();
            }
            return;
        }

        const disconnectMessage = getServerDisconnectMessage(message);
        if (!disconnectMessage) {
            socket.close(1002, "Invalid terminal control message");
            return;
        }
        props.showDisconnected(props.generation, disconnectMessage);
        socket.close();
    };

    /** Distinguishes setup loss from an established shell disconnect. */
    const handleClose = () => {
        if (
            props.generationRef.current !== props.generation ||
            props.stateRef.current.type === "disconnected"
        ) {
            return;
        }
        props.showDisconnected(
            props.generation,
            isReady
                ? "Terminal connection closed"
                : "Terminal connection closed during setup",
        );
    };

    /** Relies on close for one deterministic state transition. */
    const handleError = () => {
        if (props.generationRef.current === props.generation) {
            socket.close();
        }
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    props.resources.removeSocketListenersRef.current = () => {
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("close", handleClose);
        socket.removeEventListener("error", handleError);
    };
}

/** Manages one terminal's browser resources independently from its tab presentation. */
function useTerminalLifecycle(props: TerminalSessionProps) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const stateRef = React.useRef<TerminalState>(props.tab.state);
    const resources: TerminalResources = {
        terminalRef: React.useRef<GhosttyTerminal | null>(null),
        fitAddonRef: React.useRef<GhosttyFitAddon | null>(null),
        socketRef: React.useRef<WebSocket | null>(null),
        terminalDisposablesRef: React.useRef<IDisposable[]>([]),
        removeSocketListenersRef: React.useRef<(() => void) | null>(null),
    };
    const generationRef = React.useRef(0);
    const restartGenerationRef = React.useRef(props.tab.restartGeneration);
    const isActiveRef = React.useRef(props.isActive);
    const isPanelCollapsedRef = React.useRef(props.isPanelCollapsed);
    isActiveRef.current = props.isActive;
    isPanelCollapsedRef.current = props.isPanelCollapsed;

    /** Keeps socket handlers and the parent tab badge on the same lifecycle. */
    const updateTerminalState = (nextState: TerminalState) => {
        stateRef.current = nextState;
        props.onStateChange(props.tab.id, nextState);
    };

    /** Releases every resource associated with only this terminal tab. */
    const disposeResources = () => {
        const socket = resources.socketRef.current;
        resources.socketRef.current = null;
        resources.removeSocketListenersRef.current?.();
        resources.removeSocketListenersRef.current = null;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
        }
        resources.terminalDisposablesRef.current.forEach((disposable) =>
            disposable.dispose(),
        );
        resources.terminalDisposablesRef.current = [];
        const terminal = resources.terminalRef.current;
        resources.terminalRef.current = null;
        resources.fitAddonRef.current = null;
        terminal?.dispose();
        hostRef.current?.replaceChildren();
    };

    /** Leaves setup failures visible so this tab can be explicitly restarted. */
    const failSetup = (generation: number, message: string) => {
        if (generationRef.current !== generation) {
            return;
        }
        generationRef.current += 1;
        disposeResources();
        updateTerminalState({ type: "disconnected", message });
    };

    /** Creates Ghostty and a shell only for a selected, expanded tab. */
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
                failSetup(generation, "Terminal host is unavailable");
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
            resources.terminalRef.current = terminal;
            const fitAddon = new ghostty.FitAddon();
            resources.fitAddonRef.current = fitAddon;
            terminal.loadAddon(fitAddon);
            terminal.open(host);
            host.setAttribute(
                "aria-label",
                `${props.tab.title} for ${props.agent.name}`,
            );
            fitAddon.fit();
            fitAddon.observeResize();
            if (generationRef.current !== generation) {
                return;
            }
            updateTerminalState({ type: "connecting" });
            connectTerminal({
                agent: props.agent,
                cwd: props.tab.cwd,
                generation,
                resources,
                terminal,
                updateTerminalState,
                showDisconnected: (currentGeneration, message) => {
                    if (generationRef.current === currentGeneration) {
                        updateTerminalState({ type: "disconnected", message });
                    }
                },
                generationRef,
                stateRef,
                isActiveRef,
                isPanelCollapsedRef,
            });
        } catch {
            failSetup(generation, "Failed to initialize terminal");
        }
    };

    React.useEffect(() => {
        if (restartGenerationRef.current !== props.tab.restartGeneration) {
            restartGenerationRef.current = props.tab.restartGeneration;
            generationRef.current += 1;
            disposeResources();
            stateRef.current = { type: "not_started" };
        }
        if (props.isActive && !props.isPanelCollapsed) {
            if (stateRef.current.type === "not_started") {
                void startTerminal();
                return;
            }
            if (stateRef.current.type === "connected") {
                const generation = generationRef.current;
                requestAnimationFrame(() => {
                    if (
                        generationRef.current === generation &&
                        isActiveRef.current &&
                        !isPanelCollapsedRef.current
                    ) {
                        resources.fitAddonRef.current?.fit();
                        resources.terminalRef.current?.focus();
                    }
                });
            }
        }
    }, [
        props.isActive,
        props.isPanelCollapsed,
        props.tab.restartGeneration,
        props.tab.state.type,
    ]);

    React.useEffect(() => {
        return () => {
            generationRef.current += 1;
            disposeResources();
            // Strict Mode probes cleanup before mounting effects again.
            stateRef.current = { type: "not_started" };
        };
    }, []);

    return hostRef;
}

/** Owns one tab's browser resources so sibling sessions cannot affect it. */
function TerminalSession(props: TerminalSessionProps) {
    const hostRef = useTerminalLifecycle(props);

    return (
        <div
            id={`terminal-panel-${props.tab.id}`}
            role="tabpanel"
            aria-labelledby={`terminal-tab-${props.tab.id}`}
            aria-hidden={!props.isActive}
            hidden={!props.isActive}
            className="relative h-full"
        >
            <div
                ref={hostRef}
                aria-label={`${props.tab.title} for ${props.agent.name}`}
                className="h-full w-full overflow-hidden caret-transparent"
            />
            {props.tab.state.type === "disconnected" ? (
                <div
                    role="alert"
                    className="absolute inset-x-0 bottom-0 rounded-md border border-red-500/20 bg-[#161018]/95 px-3 py-2 text-sm text-red-300 shadow-lg"
                >
                    {props.tab.state.message}
                </div>
            ) : null}
        </div>
    );
}
