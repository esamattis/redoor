import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
const alternateCwd = join(agentCwd, "alternate");
mkdirSync(alternateCwd);
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
async function openTerminal(
    cwd = agentCwd,
    rows = 24,
    cols = 80,
): Promise<WebSocket> {
    const socket = new WebSocket(
        testAgent.getTerminalWebSocketUrl({ rows, cols }, cwd),
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

/** Waits for the transport to open so a test can exercise the pre-ready setup window. */
async function waitForSocketOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
            "error",
            () => reject(new Error("terminal websocket failed to open")),
            { once: true },
        );
    });
}

/** Waits for the typed ready lifecycle without assuming it is the first frame. */
async function waitForReady(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("terminal did not become ready")),
            10_000,
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
    it("starts concurrent shells in their requested working directories", async () => {
        const firstSocket = await openTerminal(agentCwd);
        const secondSocket = await openTerminal(alternateCwd);
        const firstMarker = `__REDOOR_CWD__${agentCwd}__`;
        const secondMarker = `__REDOOR_CWD__${alternateCwd}__`;
        const firstOutputPromise = waitForMarker(firstSocket, firstMarker);
        const secondOutputPromise = waitForMarker(secondSocket, secondMarker);

        firstSocket.send(
            new TextEncoder().encode(
                "printf '__REDOOR_CWD__%s__\\n' \"$PWD\"\n",
            ),
        );
        secondSocket.send(
            new TextEncoder().encode(
                "printf '__REDOOR_CWD__%s__\\n' \"$PWD\"\n",
            ),
        );

        const [firstOutput, secondOutput] = await Promise.all([
            firstOutputPromise,
            secondOutputPromise,
        ]);
        // The first marker proves its bootstrap cwd reached shell process creation.
        expect(firstOutput).toContain(firstMarker);
        // The distinct second marker proves concurrent terminals do not share mutable cwd state.
        expect(secondOutput).toContain(secondMarker);
    });

    it("streams PTY bytes, resizes, and destroys the shell on disconnect", async () => {
        const socket = await openTerminal();
        const marker = "__REDOOR_TERMINAL_MARKER__";
        const outputPromise = waitForMarker(socket, marker);
        socket.send(
            new TextEncoder().encode(
                "trap '' HUP; sleep 60 & child=$!; trap - HUP; printf '__REDOOR_%s__%s__%s__\\n' TERMINAL_MARKER $$ $child\n",
            ),
        );
        const output = await outputPromise;
        const pidMatch = output.match(
            /__REDOOR_TERMINAL_MARKER__(\d+)__(\d+)__/,
        );
        // Receiving both PIDs proves bytes crossed the tunnel and the shell launched a separate background job.
        expect(pidMatch?.[1]).toBeDefined();
        expect(pidMatch?.[2]).toBeDefined();
        const shellPid = Number(pidMatch?.[1]);
        const backgroundPid = Number(pidMatch?.[2]);

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
                } catch {
                    try {
                        process.kill(backgroundPid, 0);
                    } catch {
                        return true;
                    }
                }
                return undefined;
            },
            timeoutMs: 5_000,
            intervalMs: 50,
            description: "terminal shell and background process to exit",
        });
        // Both disappearances prove teardown reaches jobs outside the shell's process group.
        expect(() => process.kill(shellPid, 0)).toThrow();
        expect(() => process.kill(backgroundPid, 0)).toThrow();
    });

    it("preserves bounded terminal input sent before the agent is ready", async () => {
        const socket = new WebSocket(
            testAgent.getTerminalWebSocketUrl({ rows: 24, cols: 80 }, agentCwd),
        );
        socket.binaryType = "arraybuffer";
        onTestFinished(() => socket.close());
        const marker = "__REDOOR_EARLY_INPUT__";
        const outputPromise = waitForMarker(socket, marker);
        const readyPromise = waitForReady(socket);

        await waitForSocketOpen(socket);
        socket.send(new TextEncoder().encode(`printf '${marker}'\n`));
        await readyPromise;
        const output = await outputPromise;

        // Seeing the marker proves setup buffered valid input instead of treating it as cancellation.
        expect(output).toContain(marker);
    });
});
