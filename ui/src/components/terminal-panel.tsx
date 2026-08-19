import * as React from "react";
import {
    CircleCheck,
    CircleX,
    HardDrive,
    LoaderCircle,
    MoreHorizontal,
    RotateCcw,
    X,
} from "lucide-react";
import { useSetAtom } from "jotai";
import type {
    FitAddon as GhosttyFitAddon,
    IDisposable,
    Terminal as GhosttyTerminal,
} from "ghostty-web";
import { z } from "zod";

import {
    type Agent,
    type TerminalClientMessage,
    type TerminalServerMessage,
} from "#ui/api-client";
import { initializeGhostty } from "#ui/terminal/ghostty";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { AddButton } from "#ui/components/add-button";
import { ContextMenu } from "#ui/components/context-menu";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import {
    isEditorInputTarget,
    isUnmodifiedAltKey,
    shouldIgnoreKeyboardShortcut,
} from "#ui/utils/keyboard";
import { activateBottomDrawerTabAtom } from "#ui/bottom-drawer-state";

type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

const terminalServerMessageSchema: z.ZodType<TerminalServerMessage> =
    z.discriminatedUnion("type", [
        z.object({ type: z.literal("ready") }),
        z.object({
            type: z.literal("error"),
            message: z.string(),
        }),
        z.object({
            type: z.literal("exit"),
            code: z.number().nullable(),
            signal: z.number().nullable(),
        }),
    ]);

/** Keeps each tab's owning agent, creation directory, and lifecycle independent. */
type TerminalTab = {
    id: number;
    agent: Agent;
    agentTerminalNumber: number;
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
            color: "text-amber-400",
        };
    }
    return {
        label: "Connecting",
        color: "text-slate-400",
    };
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

/** Preserves keyboard navigation when terminal activation starts from its tablist. */
function isTerminalTabFocused(): boolean {
    return Boolean(
        document.activeElement?.closest(
            '[role="tablist"][aria-label="Terminal tabs"]',
        ),
    );
}

/** Identifies the routed agent and directory used by the direct new-terminal action. */
type ActiveTerminalTarget = {
    agent: Agent;
    cwd: string;
};

/** Reuses a live shell only when it was opened in the same directory as the current browse path. */
function findOpenTerminalForAgent(
    tabs: TerminalTab[],
    activeTabId: number | null,
    target: ActiveTerminalTarget,
): TerminalTab | undefined {
    const matchingTabs = tabs.filter(
        (tab) =>
            tab.agent.id === target.agent.id &&
            tab.cwd === target.cwd &&
            tab.state.type !== "disconnected",
    );
    if (matchingTabs.length === 0) {
        return undefined;
    }
    return (
        matchingTabs.find((tab) => tab.id === activeTabId) ??
        matchingTabs[matchingTabs.length - 1]
    );
}

/** Owns terminal tabs globally so route and agent navigation cannot destroy live shells. */
export function TerminalPanel(props: {
    agents: Agent[];
    activeTarget: ActiveTerminalTarget | null;
    isVisible: boolean;
}) {
    const activateBottomDrawerTab = useSetAtom(activateBottomDrawerTabAtom);
    const [isPickerOpen, setIsPickerOpen] = React.useState(false);
    const [tabs, setTabs] = React.useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = React.useState<number | null>(null);
    const [focusRequestId, setFocusRequestId] = React.useState(0);
    const nextTabIdRef = React.useRef(1);
    const nextAgentTerminalNumberRef = React.useRef(new Map<string, number>());

    /** Captures the selected agent and directory without changing older tabs. */
    const createTerminal = (target: ActiveTerminalTarget) => {
        const id = nextTabIdRef.current;
        nextTabIdRef.current += 1;
        const agentTerminalNumber =
            nextAgentTerminalNumberRef.current.get(target.agent.id) ?? 1;
        nextAgentTerminalNumberRef.current.set(
            target.agent.id,
            agentTerminalNumber + 1,
        );
        const title = `${target.agent.name} ${agentTerminalNumber}`;
        setTabs((currentTabs) => [
            ...currentTabs,
            {
                id,
                agent: target.agent,
                agentTerminalNumber,
                title,
                cwd: target.cwd,
                state: { type: "not_started" },
                restartGeneration: 0,
            },
        ]);
        setActiveTabId(id);
        activateBottomDrawerTab("terminal");
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
        activateBottomDrawerTab("terminal");
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

    React.useEffect(() => {
        /** Opens the routed shell or asks for an agent when the route has no terminal target. */
        const handleShortcut = (event: KeyboardEvent) => {
            const isEditorAltT =
                isUnmodifiedAltKey(event, "t") &&
                isEditorInputTarget(event.target);
            const isGlobalT =
                event.key === "t" &&
                !shouldIgnoreKeyboardShortcut(event, { shift: true });
            if (!isEditorAltT && !isGlobalT) {
                return;
            }

            if (!props.activeTarget) {
                if (!isPickerOpen) {
                    event.preventDefault();
                    activateBottomDrawerTab("terminal");
                    setIsPickerOpen(true);
                }
                return;
            }

            event.preventDefault();
            const existingTab = findOpenTerminalForAgent(
                tabs,
                activeTabId,
                props.activeTarget,
            );
            if (existingTab) {
                setActiveTabId(existingTab.id);
                activateBottomDrawerTab("terminal");
            } else {
                createTerminal(props.activeTarget);
            }
            setFocusRequestId((current) => current + 1);
        };

        // Capture so Alt+t reaches the terminal action before Vim consumes t.
        window.addEventListener("keydown", handleShortcut, true);
        return () =>
            window.removeEventListener("keydown", handleShortcut, true);
    }, [
        activeTabId,
        activateBottomDrawerTab,
        isPickerOpen,
        props.activeTarget,
        tabs,
    ]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 overflow-x-auto overscroll-x-contain pb-2">
                <TerminalTabActions
                    agents={props.agents}
                    activeTarget={props.activeTarget}
                    isPickerOpen={isPickerOpen}
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onCreate={createTerminal}
                    onPickerOpenChange={setIsPickerOpen}
                    onClose={closeTerminal}
                    onRestart={restartTerminal}
                    onSelect={setActiveTabId}
                    onTabKeyDown={handleTabKeyDown}
                />
            </div>
            <div className="terminal-surface relative min-h-0 flex-1 overflow-hidden rounded-md bg-[#0b0d12]">
                {tabs.map((tab) => (
                    <TerminalSession
                        key={tab.id}
                        agent={tab.agent}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        isPanelCollapsed={!props.isVisible}
                        focusRequestId={focusRequestId}
                        onStateChange={updateTabState}
                    />
                ))}
                {tabs.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
                        Open a terminal for a connected agent to start a shell.
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** Renders terminal-tab controls while keeping panel lifecycle state local to the parent. */
function TerminalTabActions(props: {
    agents: Agent[];
    activeTarget: ActiveTerminalTarget | null;
    isPickerOpen: boolean;
    tabs: TerminalTab[];
    activeTabId: number | null;
    onCreate: (target: ActiveTerminalTarget) => void;
    onPickerOpenChange: (isOpen: boolean) => void;
    onClose: (tabId: number) => void;
    onRestart: (tabId: number) => void;
    onSelect: (tabId: number) => void;
    onTabKeyDown: (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => void;
}) {
    const availableAgents = props.agents.filter(
        (agent) => agent.status === "connected" && agent.cwd !== null,
    );

    return (
        <div className="flex min-w-max max-w-none items-center gap-1">
            <div
                role="tablist"
                aria-label="Terminal tabs"
                className="flex min-h-8 min-w-px items-center gap-1"
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
                                <span className="max-w-36 truncate whitespace-nowrap">
                                    {tab.agent.name}
                                </span>
                                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-slate-950/70 px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-slate-300">
                                    {tab.agentTerminalNumber}
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
                                <IconButton
                                    type="button"
                                    label={`Restart ${tab.title}`}
                                    onClick={() => props.onRestart(tab.id)}
                                    className="inline-flex h-8 w-7 items-center justify-center border-l border-slate-700 text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                </IconButton>
                            ) : null}
                            <IconButton
                                type="button"
                                label={`Close ${tab.title}`}
                                onClick={() => props.onClose(tab.id)}
                                className="inline-flex h-8 w-7 items-center justify-center border-l border-slate-700 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200"
                            >
                                <X className="h-3.5 w-3.5" />
                            </IconButton>
                        </div>
                    );
                })}
            </div>
            {props.activeTarget ? (
                <AddButton
                    tooltip={`New terminal in ${props.activeTarget.agent.name} (t, Alt+t)`}
                >
                    <button
                        type="button"
                        aria-label="New terminal"
                        onClick={() => {
                            const activeTarget = props.activeTarget;
                            if (activeTarget) {
                                props.onCreate(activeTarget);
                            }
                        }}
                    />
                </AddButton>
            ) : null}
            <ActionMenu
                label="Choose agent for new terminal"
                title="New terminal"
                closeAriaLabel="Close agent picker"
                hideTitle={false}
                tooltip={
                    props.activeTarget
                        ? "New terminal in another agent"
                        : "Choose agent for new terminal (t)"
                }
                icon={<MoreHorizontal className="h-4 w-4" />}
                variant="icon"
                isOpen={props.isPickerOpen}
                onOpenChange={props.onPickerOpenChange}
            >
                {(close) => (
                    <>
                        {availableAgents.map((agent) => (
                            <ActionMenuButton
                                key={agent.id}
                                onClick={() => {
                                    if (agent.cwd === null) {
                                        return;
                                    }
                                    props.onCreate({ agent, cwd: agent.cwd });
                                    close();
                                }}
                            >
                                <HardDrive className="h-4 w-4 text-slate-500" />
                                <span className="truncate">{agent.name}</span>
                            </ActionMenuButton>
                        ))}
                        {availableAgents.length === 0 ? (
                            <p className="px-3 py-2 text-sm text-slate-500">
                                No connected agents
                            </p>
                        ) : null}
                    </>
                )}
            </ActionMenu>
        </div>
    );
}

/** Describes the parent-managed state and callbacks required by one terminal session. */
type TerminalSessionProps = {
    agent: Agent;
    tab: TerminalTab;
    isActive: boolean;
    isPanelCollapsed: boolean;
    focusRequestId: number;
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
        const textFrame = z.string().safeParse(event.data);
        if (!textFrame.success) {
            socket.close(1002, "Unsupported terminal frame");
            return;
        }

        let message: TerminalServerMessage;
        try {
            message = terminalServerMessageSchema.parse(
                JSON.parse(textFrame.data),
            );
        } catch {
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
                if (!isTerminalTabFocused()) {
                    props.terminal.focus();
                }
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
            host.setAttribute("data-terminal-input", "");
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
                resources.fitAddonRef.current?.fit();
                if (!isTerminalTabFocused()) {
                    resources.terminalRef.current?.focus();
                }
            }
        }
    }, [
        props.isActive,
        props.isPanelCollapsed,
        props.tab.restartGeneration,
        props.tab.state.type,
    ]);

    React.useEffect(() => {
        // Shortcut open/reuse must wait until the shell is connected; activation props may not change.
        if (
            props.focusRequestId === 0 ||
            !props.isActive ||
            props.isPanelCollapsed ||
            props.tab.state.type !== "connected"
        ) {
            return;
        }

        resources.terminalRef.current?.focus();
    }, [
        props.focusRequestId,
        props.isActive,
        props.isPanelCollapsed,
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

    return { hostRef, terminalRef: resources.terminalRef };
}

/** Owns one tab's browser resources so sibling sessions cannot affect it. */
function TerminalSession(props: TerminalSessionProps) {
    const { hostRef, terminalRef } = useTerminalLifecycle(props);
    const [contextMenu, setContextMenu] = React.useState<{
        x: number;
        y: number;
        canCopy: boolean;
    } | null>(null);
    const [clipboardError, setClipboardError] = React.useState<string | null>(
        null,
    );

    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }

        /** Stops Ghostty's canvas image menu so copy and paste stay available. */
        const handleContextMenu = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const terminal = terminalRef.current;
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                canCopy: Boolean(terminal?.hasSelection()),
            });
        };

        host.addEventListener("contextmenu", handleContextMenu, true);
        return () =>
            host.removeEventListener("contextmenu", handleContextMenu, true);
    }, [hostRef, terminalRef]);

    /** Returns keyboard focus to the shell after the overlay closes. */
    const closeContextMenu = () => {
        setContextMenu(null);
        if (props.isActive && !props.isPanelCollapsed) {
            terminalRef.current?.focus();
        }
    };

    /** Copies the Ghostty selection because the canvas has no native text. */
    const copySelection = async () => {
        const text = terminalRef.current?.getSelection() ?? "";
        if (!text) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            setClipboardError("Could not copy from the terminal");
        }
    };

    /** Injects clipboard text through Ghostty so bracketed paste still works. */
    const pasteClipboard = async () => {
        const terminal = terminalRef.current;
        if (!terminal) {
            return;
        }
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                terminal.paste(text);
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
            hidden={!props.isActive}
            className="relative h-full rounded-md border border-transparent p-1.5 focus-within:border-blue-500"
        >
            <div
                ref={hostRef}
                data-terminal-input
                aria-label={`${props.tab.title} for ${props.agent.name}`}
                className="h-full w-full overflow-hidden caret-transparent"
            />
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
                    className="absolute inset-x-0 bottom-0 rounded-md border border-red-500/20 bg-[#161018]/95 px-3 py-2 text-sm text-red-300 shadow-lg"
                >
                    {props.tab.state.message}
                </div>
            ) : null}
        </div>
    );
}
