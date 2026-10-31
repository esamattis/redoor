import type { WTerm } from "@wterm/dom";
import type { GhosttyCore } from "@wterm/ghostty";
import { z } from "zod";

import type { Agent } from "#ui/api-client";
import type { TerminalClientMessage } from "#bindings/TerminalClientMessage";
import type { TerminalServerMessage } from "#bindings/TerminalServerMessage";
import type { OneShotTerminalCommand } from "#ui/terminal/one-shot-command";
import { applyTerminalTheme } from "#ui/terminal/theme";
import { createWTerm } from "#ui/terminal/wterm";

/** Separates shell setup progress from recoverable terminal disconnection. */
export type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

/** Identifies the exact canonical listing that should reflect command-created entries. */
export type BrowserListingRefreshTarget = {
    readonly agentId: string;
    readonly path: string;
};

/**
 * What the tab strip and the panel need to show one terminal. A new object is made only
 * when the state changes, so memoized views of unchanged tabs are not rerendered.
 */
export type TerminalTabSnapshot = {
    readonly id: number;
    readonly agent: Agent;
    readonly agentTerminalNumber: number;
    readonly title: string;
    readonly cwd: string;
    readonly state: TerminalState;
    /** Retains denied OSC 52 writes so a user gesture can retry browser clipboard access. */
    readonly pendingClipboardWrite: string | null;
};

/** Everything a session needs from its owner at creation. */
export type TerminalSessionOptions = {
    id: number;
    agent: Agent;
    agentTerminalNumber: number;
    title: string;
    cwd: string;
    theme: "dark" | "light";
    /** Typed once into the first shell, for features that open a terminal to run a command. */
    startupCommand: OneShotTerminalCommand | null;
    /** Tells the owner to republish, because the tab snapshot changed. */
    onChange: () => void;
};

/** Validates control frames at the socket boundary before they drive the state machine. */
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

/** Gives wterm's resize observer one rendered frame before PTY dimensions are captured. */
function waitForTerminalSizing(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Removes control escapes and adds shell paste guards only when the PTY requested them. */
function formatTerminalPaste(terminal: WTerm, text: string): string {
    const safeText = text.replaceAll("\x1b", "");

    return terminal.bridge?.bracketedPaste() === true
        ? `\x1b[200~${safeText}\x1b[201~`
        : safeText;
}

/**
 * One shell: the WebSocket to the agent's PTY, the emulator that renders it, and the state
 * machine between them. It lives outside React, so route changes, remounts and hidden tabs
 * never touch a running shell. React only attaches the session's host element to a
 * container and reads its snapshot.
 *
 * Every asynchronous step belongs to a generation. Restarting, failing or disposing bumps
 * the generation, so a late socket event or a finished emulator load from an earlier attempt
 * finds a newer number and drops itself instead of corrupting the current attempt.
 */
export class TerminalSession {
    /** The element wterm renders into; it keeps its emulator across React remounts. */
    readonly element: HTMLDivElement;

    private tabSnapshot: TerminalTabSnapshot;
    private generation = 0;
    private isReady = false;
    private isShown = false;
    private theme: "dark" | "light";
    private container: HTMLElement | null = null;
    private socket: WebSocket | null = null;
    private removeSocketListeners: (() => void) | null = null;
    private terminal: WTerm | null = null;
    private core: GhosttyCore | null = null;

    /** Builds the host element up front so the session is addressable before it is shown. */
    constructor(private readonly options: TerminalSessionOptions) {
        this.theme = options.theme;
        this.tabSnapshot = {
            id: options.id,
            agent: options.agent,
            agentTerminalNumber: options.agentTerminalNumber,
            title: options.title,
            cwd: options.cwd,
            state: { type: "not_started" },
            pendingClipboardWrite: null,
        };

        this.element = document.createElement("div");
        this.element.setAttribute("data-terminal-input", "");
        this.element.setAttribute("role", "textbox");
        this.element.setAttribute("aria-multiline", "true");

        this.element.setAttribute(
            "aria-label",
            `${options.title} for ${options.agent.name}`,
        );
        // wterm moves a host tabindex onto its input and makes the host itself focusable with
        // -1. Without that, a drag-selection blurs the input to <body>, which hides the focus
        // frame and lets the page's file-import paste handler claim the next paste.
        this.element.setAttribute("tabindex", "0");
        this.element.className =
            "terminal-host h-full w-full caret-transparent outline-none";
        applyTerminalTheme(this.element, this.theme);
        this.element.addEventListener("keydown", (event) =>
            this.handleHostKeyDown(event),
        );
        this.element.addEventListener("paste", (event) =>
            this.handleHostPaste(event),
        );
        // Shift-drag must start a document selection rather than extend the hidden textarea's
        // selection. Move focus before the browser's mousedown default action chooses its owner.
        this.element.addEventListener(
            "mousedown",
            (event) => {
                if (event.shiftKey && event.button === 0) {
                    this.element.focus({ preventScroll: true });
                    const document = this.element.ownerDocument;
                    const selection = document.getSelection();

                    if (!this.getSelection()) {
                        const caret = document.caretPositionFromPoint?.(
                            event.clientX,
                            event.clientY,
                        );

                        if (caret && this.element.contains(caret.offsetNode)) {
                            selection?.collapse(caret.offsetNode, caret.offset);
                        } else {
                            const range = document.caretRangeFromPoint?.(
                                event.clientX,
                                event.clientY,
                            );

                            if (
                                range &&
                                this.element.contains(range.startContainer)
                            ) {
                                selection?.collapse(
                                    range.startContainer,
                                    range.startOffset,
                                );
                            }
                        }
                    }
                }
            },
            true,
        );
    }

    /**
     * wterm releases its input after a mouse selection so native Copy works, leaving focus on
     * the host. Copy keys stay on the host to keep the selection; any other key returns focus
     * to the input before the browser delivers the text or paste that the key produces.
     */
    private handleHostKeyDown(event: KeyboardEvent): void {
        if (event.target !== this.element) {
            return;
        }

        const isModifierOnly = [
            "Shift",
            "Control",
            "Alt",
            "AltGraph",
            "Meta",
        ].includes(event.key);

        const isCopy =
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key.toLowerCase() === "c";

        if (isCopy && event.ctrlKey && event.shiftKey && this.getSelection()) {
            event.preventDefault();
            event.stopPropagation();
            this.element.ownerDocument.execCommand("copy");

            return;
        }

        if (!isModifierOnly && !isCopy) {
            this.focus();
        }
    }

    /**
     * Sends pastes that land on the host itself to the shell instead of the file importer,
     * then hands focus back to the input so the keys that follow reach the shell too.
     */
    private handleHostPaste(event: ClipboardEvent): void {
        if (event.target !== this.element) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const text = event.clipboardData?.getData("text/plain") ?? "";

        if (text) {
            this.paste(text);
        }

        this.focus();
    }

    /** The current tab data; its identity only changes with the state. */
    get tab(): TerminalTabSnapshot {
        return this.tabSnapshot;
    }

    /** Lets the clipboard menu know whether anything is rendered to paste into. */
    get isInitialized(): boolean {
        return this.terminal !== null;
    }

    /** Puts the host into the document, and starts the shell if it is already wanted. */
    attach(container: HTMLElement): void {
        this.container = container;
        container.appendChild(this.element);
        this.startIfWanted();
    }

    /** Takes the host out of the document without touching the shell behind it. */
    detach(container: HTMLElement): void {
        if (this.container !== container) {
            return;
        }

        this.container = null;
        this.element.remove();
    }

    /**
     * Tells the session whether it is the visible tab of an open panel. The shell starts
     * lazily on first display, so hidden tabs cost nothing, and the PTY is only resized while
     * shown because a hidden layout measures as 1x1.
     */
    setShown(isShown: boolean): void {
        this.isShown = isShown;

        if (!isShown) {
            return;
        }

        this.startIfWanted();
        this.syncSize();
    }

    /** Applies the app theme to the emulator's CSS variables without rebuilding anything. */
    setTheme(theme: "dark" | "light"): void {
        this.theme = theme;
        applyTerminalTheme(this.element, theme);
    }

    /** Throws the shell away and begins a fresh one in the same tab and directory. */
    restart(): void {
        this.generation += 1;
        this.disposeResources();
        this.setState({ type: "not_started" });
        this.startIfWanted();
    }

    /** Releases the shell and its host for good, when the tab is closed. */
    dispose(): void {
        this.generation += 1;
        this.disposeResources();
        this.container = null;
        this.element.remove();
    }

    /** Moves keyboard focus into the emulator. */
    focus(): void {
        this.terminal?.focus();
    }

    /** Uses terminal cell semantics so copying also includes virtualized history selections. */
    getSelection(): string {
        return this.terminal?.getSelectionText() ?? "";
    }

    /** Releases a pending application copy after the user copies or dismisses it. */
    clearClipboardRequest(): void {
        this.tabSnapshot = { ...this.tabSnapshot, pendingClipboardWrite: null };
        this.options.onChange();
    }

    /** Tries OSC 52 writes immediately, retaining denied writes for a user-initiated retry. */
    private async writeApplicationClipboard(
        text: string,
        generation: number,
    ): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            if (this.generation === generation) {
                this.tabSnapshot = {
                    ...this.tabSnapshot,
                    pendingClipboardWrite: text,
                };
                this.options.onChange();
            }
        }
    }

    /** Pastes with the shell's requested framing, through the same ready-gated input path. */
    paste(text: string): void {
        if (this.terminal !== null) {
            this.sendInput(formatTerminalPaste(this.terminal, text));
        }
    }

    /** Sends text as UTF-8, and only once the server has accepted the PTY session. */
    private sendInput(data: string): void {
        const socket = this.socket;

        if (!this.isReady || !socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        socket.send(new TextEncoder().encode(data));
    }

    /** Sends the emulator's current geometry while the session is on screen. */
    private syncSize(): void {
        if (this.tabSnapshot.state.type !== "connected") {
            return;
        }

        this.sendResize(this.terminal?.cols ?? 80, this.terminal?.rows ?? 24);
    }

    /** Sends geometry, but never from a hidden layout, which would resize the PTY to 1x1. */
    private sendResize(cols: number, rows: number): void {
        const socket = this.socket;

        if (
            !this.isReady ||
            !this.isShown ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        const message: TerminalClientMessage = {
            type: "resize",
            size: { rows, cols },
        };

        socket.send(JSON.stringify(message));
    }

    /** Publishes a new tab snapshot so the owner and its subscribers see the transition. */
    private setState(state: TerminalState): void {
        this.tabSnapshot = { ...this.tabSnapshot, state };
        this.options.onChange();
    }

    /** Starts only for a displayed, attached tab that has not begun yet. */
    private startIfWanted(): void {
        if (
            this.isShown &&
            this.container !== null &&
            this.tabSnapshot.state.type === "not_started"
        ) {
            void this.start();
        }
    }

    /** Leaves setup failures visible so this tab can be explicitly restarted. */
    private failSetup(generation: number, message: string): void {
        if (this.generation !== generation) {
            return;
        }

        this.generation += 1;
        this.disposeResources();
        this.setState({ type: "disconnected", message });
    }

    /** Creates the emulator, waits for its real size, then opens the shell socket. */
    private async start(): Promise<void> {
        const generation = this.generation + 1;
        this.generation = generation;
        this.setState({ type: "initializing" });

        try {
            applyTerminalTheme(this.element, this.theme);

            const session = await createWTerm({
                host: this.element,
                onData: (data) => this.sendInput(data),
                onResize: (cols, rows) => this.sendResize(cols, rows),
                onClipboardWrite: (text) => {
                    void this.writeApplicationClipboard(text, generation);
                },
            });

            if (this.generation !== generation) {
                session.terminal.destroy();
                session.core.dispose();

                return;
            }

            this.terminal = session.terminal;
            this.core = session.core;
            this.element.setAttribute("data-terminal-initialized", "true");
            await waitForTerminalSizing();

            if (this.generation !== generation) {
                return;
            }

            this.setState({ type: "connecting" });
            this.connect(generation, session.terminal);
        } catch {
            this.failSetup(generation, "Failed to initialize terminal");
        }
    }

    /** Opens the shell socket and routes its frames, closes and errors for this generation. */
    private connect(generation: number, terminal: WTerm): void {
        const socket = new WebSocket(
            this.options.agent.getTerminalWebSocketUrl(
                { rows: terminal.rows, cols: terminal.cols },
                this.options.cwd,
            ),
        );

        socket.binaryType = "arraybuffer";
        this.socket = socket;
        this.isReady = false;

        const handleMessage = (event: MessageEvent) =>
            this.handleMessage(socket, generation, event);

        const handleClose = () => this.handleClose(generation);

        /** Relies on close for one deterministic state transition. */
        const handleError = () => {
            if (this.generation === generation) {
                socket.close();
            }
        };

        socket.addEventListener("message", handleMessage);
        socket.addEventListener("close", handleClose);
        socket.addEventListener("error", handleError);
        this.removeSocketListeners = () => {
            socket.removeEventListener("message", handleMessage);
            socket.removeEventListener("close", handleClose);
            socket.removeEventListener("error", handleError);
        };
    }

    /** Applies typed binary output and lifecycle notifications. */
    private handleMessage(
        socket: WebSocket,
        generation: number,
        event: MessageEvent,
    ): void {
        if (this.generation !== generation) {
            return;
        }

        if (event.data instanceof ArrayBuffer) {
            this.terminal?.write(new Uint8Array(event.data));

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
            this.handleReady(socket, generation);

            return;
        }

        const disconnectMessage = getServerDisconnectMessage(message);

        if (!disconnectMessage) {
            socket.close(1002, "Invalid terminal control message");

            return;
        }

        this.showDisconnected(generation, disconnectMessage);
        socket.close();
    }

    /** Opens input, schedules the one-shot command and reports the real size once. */
    private handleReady(socket: WebSocket, generation: number): void {
        this.isReady = true;

        this.options.startupCommand?.reserve(
            socket,
            () => this.generation === generation && this.socket === socket,
        );

        this.setState({ type: "connected" });
        // Resizes sent before ready were dropped, so the PTY learns the settled size now.
        this.syncSize();
    }

    /** Distinguishes setup loss from an established shell disconnect. */
    private handleClose(generation: number): void {
        this.options.startupCommand?.cancelPending();

        if (
            this.generation !== generation ||
            this.tabSnapshot.state.type === "disconnected"
        ) {
            return;
        }

        this.showDisconnected(
            generation,
            this.isReady
                ? "Terminal connection closed"
                : "Terminal connection closed during setup",
        );
    }

    /** Marks the tab disconnected unless a newer attempt has replaced this one. */
    private showDisconnected(generation: number, message: string): void {
        if (this.generation === generation) {
            this.setState({ type: "disconnected", message });
        }
    }

    /** Releases the socket, emulator and rendered DOM, leaving the host element reusable. */
    private disposeResources(): void {
        this.options.startupCommand?.cancelPending();
        const socket = this.socket;
        this.socket = null;
        this.removeSocketListeners?.();
        this.removeSocketListeners = null;

        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
        }

        this.isReady = false;

        const terminal = this.terminal;
        const core = this.core;
        this.terminal = null;
        this.core = null;
        terminal?.destroy();
        core?.dispose();
        this.element.removeAttribute("data-terminal-initialized");
        this.element.replaceChildren();
    }
}
