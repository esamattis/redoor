import { onTestFinished } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import type { Agent, ApiClient } from "#ui/api-client";
import type { TerminalServerMessage } from "#bindings/TerminalServerMessage";
import type { TerminalSessionInfo } from "#bindings/TerminalSessionInfo";
import type { TerminalSize } from "#bindings/TerminalSize";
import { ApiError } from "#ui/api-transport";
import { webSocketDataToString } from "./test-utils";

/** Validates control frames so a test fails on a malformed message instead of hanging. */
export const terminalServerMessageSchema: z.ZodType<TerminalServerMessage> =
    z.discriminatedUnion("type", [
        z.object({ type: z.literal("ready") }),
        z.object({
            type: z.literal("exit"),
            code: z.number().nullable(),
            signal: z.number().nullable(),
        }),
        z.object({ type: z.literal("error"), message: z.string() }),
        z.object({ type: z.literal("taken_over") }),
        z.object({ type: z.literal("closed") }),
    ]);

/** Output kept per viewer; enough for any marker a test waits for. */
const MAX_RECORDED_OUTPUT = 256 * 1024;

/**
 * One attached browser socket that records every frame from the moment it opens, so a test
 * can wait for something that may already have arrived.
 */
export class TerminalViewer {
    readonly socket: WebSocket;
    output = "";
    readonly events: TerminalServerMessage[] = [];
    isClosed = false;
    private readonly decoder = new TextDecoder();
    private readonly listeners = new Set<() => void>();

    /** Opens the attach socket of `sessionId` and starts recording. */
    constructor(api: ApiClient, sessionId: string, size: TerminalSize) {
        this.socket = new WebSocket(
            api.getTerminalSessionWebSocketUrl(sessionId, size),
            { headers: api.getAuthHeaders() },
        );
        this.socket.binaryType = "arraybuffer";
        this.socket.on("message", (data, isBinary) => {
            if (isBinary && data instanceof ArrayBuffer) {
                this.output =
                    `${this.output}${this.decoder.decode(new Uint8Array(data), { stream: true })}`.slice(
                        -MAX_RECORDED_OUTPUT,
                    );
            } else {
                this.events.push(
                    terminalServerMessageSchema.parse(
                        JSON.parse(webSocketDataToString(data)),
                    ),
                );
            }

            this.notify();
        });
        this.socket.on("close", () => {
            this.isClosed = true;
            this.notify();
        });
        this.socket.on("error", () => {});
        onTestFinished(() => this.socket.close());
    }

    /** Wakes every pending wait so it re-checks its condition. */
    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    /** Resolves once `check` returns a value, re-checked on every frame and on close. */
    waitFor<T>(
        description: string,
        check: () => T | undefined,
        timeoutMs = 10_000,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const listener = () => {
                const value = check();

                if (value !== undefined) {
                    clearTimeout(timeout);
                    this.listeners.delete(listener);
                    resolve(value);
                }
            };

            const timeout = setTimeout(() => {
                this.listeners.delete(listener);
                reject(
                    new Error(
                        `${description} did not happen; events ${JSON.stringify(this.events)}, closed ${this.isClosed}, output ${JSON.stringify(this.output.slice(-500))}`,
                    ),
                );
            }, timeoutMs);

            this.listeners.add(listener);
            listener();
        });
    }

    /** Waits for the session to accept input, failing fast on an error event. */
    async waitForReady(): Promise<void> {
        await this.waitFor("terminal ready", () => {
            const error = this.events.find((event) => event.type === "error");

            if (error) {
                throw new Error(JSON.stringify(error));
            }

            return this.events.some((event) => event.type === "ready")
                ? true
                : undefined;
        });
    }

    /** Waits until the recorded output contains `marker` and returns that output. */
    waitForOutput(marker: string): Promise<string> {
        return this.waitFor(`output ${marker}`, () =>
            this.output.includes(marker) ? this.output : undefined,
        );
    }

    /** Waits until the recorded output matches `pattern` and returns that output. */
    waitForOutputMatching(pattern: RegExp): Promise<string> {
        return this.waitFor(`output ${String(pattern)}`, () =>
            pattern.test(this.output) ? this.output : undefined,
        );
    }

    /** Waits for one lifecycle event type and returns it. */
    waitForEvent<T extends TerminalServerMessage["type"]>(
        type: T,
    ): Promise<Extract<TerminalServerMessage, { type: T }>> {
        return this.waitFor(`event ${type}`, () =>
            this.events.find(
                (event): event is Extract<TerminalServerMessage, { type: T }> =>
                    event.type === type,
            ),
        );
    }

    /** Waits until the server closed the socket. */
    waitForClose(): Promise<true> {
        return this.waitFor("socket close", () =>
            this.isClosed ? true : undefined,
        );
    }

    /** Types text into the shell. */
    type(text: string): void {
        this.socket.send(new TextEncoder().encode(text));
    }

    /** Reports a new browser size. */
    resize(rows: number, cols: number): void {
        this.socket.send(
            JSON.stringify({ type: "resize", size: { rows, cols } }),
        );
    }
}

/** The size every test terminal is created and attached with. */
export const TEST_TERMINAL_SIZE: TerminalSize = { rows: 24, cols: 80 };

/** Creates a session and deletes it when the test ends, so no test leaks a shell or a slot. */
export async function createTerminalSession(
    api: ApiClient,
    agent: Agent,
    cwd: string,
): Promise<TerminalSessionInfo> {
    const { session } = await agent.createTerminalSession({
        cwd,
        title: `${agent.name} test`,
        number: 1,
        size: TEST_TERMINAL_SIZE,
    });

    onTestFinished(async () => {
        await deleteTerminalSessionIfPresent(api, session.id);
    });

    return session;
}

/** Deletes a session, ignoring one a test already deleted. */
export async function deleteTerminalSessionIfPresent(
    api: ApiClient,
    id: string,
): Promise<void> {
    try {
        await api.deleteTerminalSession(id);
    } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
            throw error;
        }
    }
}

/** Creates a session, attaches to it and waits until its shell is ready. */
export async function openTerminal(
    api: ApiClient,
    agent: Agent,
    cwd: string,
): Promise<{ session: TerminalSessionInfo; viewer: TerminalViewer }> {
    const session = await createTerminalSession(api, agent, cwd);
    const viewer = new TerminalViewer(api, session.id, TEST_TERMINAL_SIZE);
    await viewer.waitForReady();

    return { session, viewer };
}
