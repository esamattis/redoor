import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";
import type { Agent, TerminalServerMessage } from "@/api-client";

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
const agentCwd = tempFiles.tempDirectory({ suffix: "-terminal-agent" });
let testAgent: Agent;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: "terminal-agent",
        agentCwd,
    });
    testAgent = started.testAgent;
}, 30_000);

afterAll(() => {
    tempFiles.cleanup();
    processManager.killAll();
});

/** Opens a dedicated terminal and waits for its typed ready notification. */
async function openTerminal(rows = 24, cols = 80): Promise<WebSocket> {
    const socket = new WebSocket(
        testAgent.getTerminalWebSocketUrl({ rows, cols }),
    );
    socket.binaryType = "arraybuffer";
    onTestFinished(() => socket.close());
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("terminal did not become ready")),
            10_000,
        );
        socket.addEventListener(
            "error",
            () => {
                clearTimeout(timeout);
                reject(new Error("terminal websocket failed"));
            },
            { once: true },
        );
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }
            const message: TerminalServerMessage = JSON.parse(event.data);
            if (message.type === "error") {
                clearTimeout(timeout);
                reject(new Error(message.message));
            } else if (message.type === "ready") {
                clearTimeout(timeout);
                resolve();
            }
        });
    });
    return socket;
}

/** Reads only a bounded rolling window until a deterministic marker appears. */
function waitForMarker(socket: WebSocket, marker: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const decoder = new TextDecoder();
        let output = "";
        const timeout = setTimeout(
            () => reject(new Error(`terminal marker not received: ${marker}`)),
            10_000,
        );
        const onMessage = (event: MessageEvent) => {
            if (!(event.data instanceof ArrayBuffer)) {
                return;
            }
            output =
                `${output}${decoder.decode(new Uint8Array(event.data), { stream: true })}`.slice(
                    -65_536,
                );
            if (output.includes(marker)) {
                clearTimeout(timeout);
                socket.removeEventListener("message", onMessage);
                resolve(output);
            }
        };
        socket.addEventListener("message", onMessage);
    });
}

describe("dedicated terminal tunnel", () => {
    it("streams PTY bytes, resizes, and destroys the shell on disconnect", async () => {
        const socket = await openTerminal();
        const marker = "__REDOOR_TERMINAL_MARKER__";
        const outputPromise = waitForMarker(socket, marker);
        socket.send(
            new TextEncoder().encode(
                "printf '__REDOOR_%s__%s__\\n' TERMINAL_MARKER $$\n",
            ),
        );
        const output = await outputPromise;
        const pidMatch = output.match(/__REDOOR_TERMINAL_MARKER__(\d+)__/);
        // Receiving the shell PID proves bytes crossed browser, relay, dedicated agent socket, and PTY in both directions.
        expect(pidMatch?.[1]).toBeDefined();
        const shellPid = Number(pidMatch?.[1]);

        socket.send(
            JSON.stringify({ type: "resize", size: { rows: 31, cols: 97 } }),
        );
        const resizeMarker = "__REDOOR_SIZE__";
        const resizeOutputPromise = waitForMarker(socket, resizeMarker);
        socket.send(
            new TextEncoder().encode(
                "stty size; printf '__REDOOR_%s__' SIZE\n",
            ),
        );
        const resizeOutput = await resizeOutputPromise;
        // The observed dimensions prove validated resize controls reached the PTY ioctl.
        expect(resizeOutput).toContain("31 97");

        socket.close();
        await waitForValue({
            predicate: async () => {
                try {
                    process.kill(shellPid, 0);
                    return undefined;
                } catch {
                    return true;
                }
            },
            timeoutMs: 5_000,
            intervalMs: 50,
            description: "terminal shell process to exit",
        });
        // Process disappearance proves browser disconnect tears down and reaps the PTY shell.
        expect(() => process.kill(shellPid, 0)).toThrow();
    });
});
