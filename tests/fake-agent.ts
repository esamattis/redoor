import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import WebSocket from "ws";
import { z } from "zod";

import type { BinaryIdentity } from "#bindings/BinaryIdentity";
import {
    generateDeviceId,
    TEST_AGENT_TOKEN,
    webSocketDataToString,
} from "./test-utils";

/** Subprotocol of the agent websocket that this helper speaks. */
export const AGENT_PROTOCOL = "redoor.v5";

/** Path of the single agent websocket endpoint. */
export const AGENT_WS_PATH = "/api/v1/agent/ws";

/** Fixed header length of one binary stream frame: stream id (8) and flags (1). */
const STREAM_HEADER_SIZE = 9;

/** Flag bit marking the final frame of a successful stream; failures are reported by the result. */
const FLAG_FIN = 0x01;

/**
 * One HMAC of the mutual token proof, in the encoding of `redoor_protocol::wire::agent_auth`:
 * the step label and then each nonce on its own line, keyed with the agent token.
 */
export function tokenProof(
    token: string,
    label: "redoor agent upgrade" | "redoor server" | "redoor agent hello",
    nonces: string[],
): string {
    return createHmac("sha256", token)
        .update([label, ...nonces].join("\n"))
        .digest("hex");
}

/** Reads one single-valued header of the server's upgrade answer; empty when absent. */
function responseHeader(response: IncomingMessage, name: string): string {
    return z.string().catch("").parse(response.headers[name]);
}

/**
 * Checks the server's proof of the token in its upgrade answer, like the real agent does, and
 * returns the proof the `hello` must carry.
 */
function helloProofForAnswer(
    response: IncomingMessage,
    token: string,
    agentNonce: string,
): string {
    const serverNonce = responseHeader(response, "x-redoor-server-nonce");

    const expected = Buffer.from(
        tokenProof(token, "redoor server", [agentNonce, serverNonce]),
    );

    const presented = Buffer.from(
        responseHeader(response, "x-redoor-server-proof"),
    );

    if (
        expected.length !== presented.length ||
        !timingSafeEqual(expected, presented)
    ) {
        throw new Error("the server did not prove it knows the agent token");
    }

    return tokenProof(token, "redoor agent hello", [agentNonce, serverNonce]);
}

/** Every control frame is a JSON object tagged by `type`. */
const controlFrameSchema = z.object({ type: z.string() }).catchall(z.unknown());

/** Any JSON document, the shape of a response payload the fake agent sends. */
export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/** One parsed control frame received from the server. */
export type ControlFrame = z.infer<typeof controlFrameSchema>;

/** A `command` frame: the server asks the agent to run one request. */
const commandFrameSchema = z.object({
    type: z.literal("command"),
    id: z.number(),
    /** Initial credit of the command's output stream, in frames. */
    credit: z.number(),
    command: z.object({ type: z.string() }).catchall(z.unknown()),
});

/** One command the fake agent received. */
export type FakeCommand = z.infer<typeof commandFrameSchema>;

/** The server's answer to `hello` when it accepted the agent. */
const welcomeSchema = z.object({
    type: z.literal("welcome"),
    connection_id: z.string(),
});

/** The server's answer to `hello` when it refused the agent. */
const rejectedSchema = z.object({
    type: z.literal("rejected"),
    reason: z.string(),
    message: z.string(),
});

/** Upgrade request settings; every field defaults to what a correct agent sends. */
export type UpgradeOptions = {
    serverPort: number;
    /** Agent token the upgrade proves; `null` sends no proof headers at all. */
    token?: string | null;
    /** Offered subprotocols; an empty list sends no `Sec-WebSocket-Protocol` header. */
    protocols?: string[];
    /** Value of the agent version header used in rejection diagnostics. */
    version?: string;
    /** Whether `ws` answers pings itself; stale-detection tests turn this off. */
    autoPong?: boolean;
};

/** What the server answered to an upgrade attempt. */
export type UpgradeOutcome =
    | {
          kind: "open";
          socket: WebSocket;
          /** Proof of the token over both nonces, which the `hello` must carry. */
          helloProof: string;
      }
    | { kind: "refused"; status: number; body: string };

/**
 * Attempts one agent websocket upgrade and reports either the open socket or the HTTP answer
 * that refused it, so tests can assert on `401` and `426` without a socket ever existing.
 * An accepted upgrade must prove the token back, as the real agent requires.
 */
export async function upgradeAgentSocket(
    options: UpgradeOptions,
): Promise<UpgradeOutcome> {
    const url = `ws://127.0.0.1:${options.serverPort}${AGENT_WS_PATH}`;

    const token =
        options.token === undefined ? TEST_AGENT_TOKEN : options.token;

    const versionHeader = {
        "X-Redoor-Agent-Version": options.version ?? "0.0.0-fake-agent",
    };

    const agentNonce = randomBytes(32).toString("hex");

    const headers =
        token === null
            ? versionHeader
            : {
                  ...versionHeader,
                  "X-Redoor-Agent-Nonce": agentNonce,
                  "X-Redoor-Agent-Proof": tokenProof(
                      token,
                      "redoor agent upgrade",
                      [agentNonce],
                  ),
              };

    const socket = new WebSocket(url, options.protocols ?? [AGENT_PROTOCOL], {
        headers,
        autoPong: options.autoPong ?? true,
    });

    return new Promise<UpgradeOutcome>((resolve, reject) => {
        let helloProof = "";

        socket.once("upgrade", (response) => {
            try {
                helloProof = helloProofForAnswer(
                    response,
                    token ?? "",
                    agentNonce,
                );
            } catch (error) {
                socket.terminate();
                reject(error);
            }
        });
        socket.once("open", () =>
            resolve({ kind: "open", socket, helloProof }),
        );
        socket.once("unexpected-response", (_request, response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
                resolve({
                    kind: "refused",
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString(),
                }),
            );
        });
        socket.once("error", reject);
    });
}

/** Identity and capabilities a fake agent announces in its `hello`. */
export type HelloOptions = {
    /** Display name; the router requires it to be unique and not in the id format. */
    agentName: string;
    /**
     * Device id sent in `hello`; a fresh valid id when omitted. Tests pass one to reconnect as
     * the same device or to send a malformed id on purpose.
     */
    agentId?: string;
    os?: string;
    arch?: string;
    hostname?: string;
    username?: string;
    cwd?: string;
    binary?: Partial<BinaryIdentity>;
    supportsNativeOpen?: boolean;
    supportsTrash?: boolean;
    supportsMoveToTrash?: boolean;
};

/** The flat `hello` frame a real agent sends first on every connection. */
export type HelloFrame = {
    type: "hello";
    agent_id: string;
    agent_name: string;
    token_proof: string;
    os: string;
    arch: string;
    hostname: string;
    username: string;
    cwd: string;
    binary: BinaryIdentity;
    uid: number;
    is_root: boolean;
    supports_native_open: boolean;
    supports_trash: boolean;
    supports_move_to_trash: boolean;
};

/**
 * Builds the `hello` frame for one fake agent identity, finishing the token proof with the
 * `helloProof` of its upgrade.
 */
export function helloFrame(
    options: HelloOptions,
    helloProof: string,
): HelloFrame {
    return {
        type: "hello",
        agent_id: options.agentId ?? generateDeviceId(),
        agent_name: options.agentName,
        token_proof: helloProof,
        os: options.os ?? "linux",
        arch: options.arch ?? "x86_64",
        hostname: options.hostname ?? "fake-host",
        username: options.username ?? "fake-user",
        cwd: options.cwd ?? "/tmp",
        binary: {
            version: "0.0.0",
            git_rev: "fake",
            git_dirty: false,
            version_dirty: false,
            build_mode: "debug",
            build_date: "unknown",
            ...options.binary,
        } satisfies BinaryIdentity,
        uid: 1000,
        is_root: false,
        supports_native_open: options.supportsNativeOpen ?? false,
        supports_trash: options.supportsTrash ?? false,
        supports_move_to_trash: options.supportsMoveToTrash ?? false,
    };
}

/** Thrown when the server answers `hello` with `rejected`. */
export class FakeAgentRejectedError extends Error {
    constructor(
        readonly reason: string,
        message: string,
    ) {
        super(message);
    }
}

/** Settings for a fully connected fake agent. */
export type FakeAgentOptions = HelloOptions &
    Omit<UpgradeOptions, "path" | "protocols">;

/** One queued control frame consumer. */
type FrameWaiter = {
    accepts: (frame: ControlFrame) => boolean;
    resolve: (frame: ControlFrame) => void;
};

/**
 * A scripted agent speaking the real wire protocol over real sockets.
 *
 * Received control frames are queued so tests can wait for them in any order without racing
 * the socket; command handlers see every command, including ones that arrived earlier.
 */
export class FakeAgent {
    private readonly queued: ControlFrame[] = [];
    private readonly waiters: FrameWaiter[] = [];
    private readonly commandHandlers: ((command: FakeCommand) => void)[] = [];
    private readonly receivedCommands: FakeCommand[] = [];
    private readonly streamHandlers: ((frame: StreamFrame) => void)[] = [];
    /** Connection id from the server's `welcome`. */
    connectionId = "";

    private constructor(
        /** Device id the agent announced, which the REST API also accepts in paths. */
        readonly agentId: string,
        /** Display name the agent announced. */
        readonly agentName: string,
        readonly control: WebSocket,
    ) {
        control.on("message", (data, isBinary) => {
            if (isBinary) {
                const frame = decodeStreamFrame(rawDataToBuffer(data));

                for (const handler of this.streamHandlers) {
                    handler(frame);
                }

                return;
            }

            this.receive(
                controlFrameSchema.parse(
                    JSON.parse(webSocketDataToString(data)),
                ),
            );
        });
    }

    /**
     * Upgrades, says hello and waits for the welcome. Throws [`FakeAgentRejectedError`] when
     * the server refuses the hello.
     */
    static async connect(options: FakeAgentOptions): Promise<FakeAgent> {
        const outcome = await upgradeAgentSocket(options);

        if (outcome.kind === "refused") {
            throw new Error(
                `agent upgrade refused with ${outcome.status}: ${outcome.body}`,
            );
        }

        const agentId = options.agentId ?? generateDeviceId();

        const agent = new FakeAgent(agentId, options.agentName, outcome.socket);

        agent.send(helloFrame({ ...options, agentId }, outcome.helloProof));

        const answer = await agent.waitForFrame(
            (frame) => frame.type === "welcome" || frame.type === "rejected",
        );

        const rejected = rejectedSchema.safeParse(answer);

        if (rejected.success) {
            agent.close();
            throw new FakeAgentRejectedError(
                rejected.data.reason,
                rejected.data.message,
            );
        }

        agent.connectionId = welcomeSchema.parse(answer).connection_id;

        return agent;
    }

    /** Hands a received frame to the oldest waiter that wants it, or queues it. */
    private receive(frame: ControlFrame): void {
        const command = commandFrameSchema.safeParse(frame);

        if (command.success) {
            this.receivedCommands.push(command.data);

            for (const handler of this.commandHandlers) {
                handler(command.data);
            }
        }

        const waiter = this.waiters.findIndex((entry) => entry.accepts(frame));

        if (waiter >= 0) {
            const [entry] = this.waiters.splice(waiter, 1);
            entry?.resolve(frame);

            return;
        }

        this.queued.push(frame);
    }

    /** Resolves with the first queued or future control frame `accepts` matches. */
    waitForFrame(
        accepts: (frame: ControlFrame) => boolean,
        timeoutMs = 10000,
    ): Promise<ControlFrame> {
        const index = this.queued.findIndex(accepts);

        if (index >= 0) {
            const [frame] = this.queued.splice(index, 1);

            if (frame !== undefined) {
                return Promise.resolve(frame);
            }
        }

        return new Promise((resolve, reject) => {
            const waiter: FrameWaiter = {
                accepts,
                resolve: (frame) => {
                    clearTimeout(timeout);
                    resolve(frame);
                },
            };

            const timeout = setTimeout(() => {
                const position = this.waiters.indexOf(waiter);

                if (position >= 0) {
                    this.waiters.splice(position, 1);
                }

                reject(new Error("Timed out waiting for a control frame"));
            }, timeoutMs);

            this.waiters.push(waiter);
        });
    }

    /** Waits for the next command of one type. */
    async nextCommand(type: string, timeoutMs = 10000): Promise<FakeCommand> {
        return commandFrameSchema.parse(
            await this.waitForFrame((frame) => {
                const command = commandFrameSchema.safeParse(frame);

                return command.success && command.data.command.type === type;
            }, timeoutMs),
        );
    }

    /** Calls `handler` for every command, starting with those already received. */
    onCommand(handler: (command: FakeCommand) => void): void {
        this.commandHandlers.push(handler);

        for (const command of this.receivedCommands) {
            handler(command);
        }
    }

    /** Commands received so far, in arrival order. */
    get commands(): FakeCommand[] {
        return [...this.receivedCommands];
    }

    /** Sends one control frame, tagged by `type` like every frame on the wire. */
    send<Frame extends { type: string }>(frame: Frame): void {
        this.control.send(JSON.stringify(frame));
    }

    /** Answers request `id` successfully with its typed response (`null` for none). */
    respond(id: number, response: JsonValue): void {
        this.send({ type: "result", id, ok: response });
    }

    /** Answers request `id` with a failure of `kind` (a snake_case `CommandErrorKind`). */
    fail(id: number, kind: string, message: string): void {
        this.send({ type: "result", id, error: { kind, message } });
    }

    /** Sends one binary frame of stream `stream` on the connection. */
    sendStreamFrame(
        stream: number,
        data: Buffer,
        flags: { last?: boolean } = {},
    ): void {
        this.control.send(encodeStreamFrame(stream, data, flags));
    }

    /** Grants the server `frames` more frames of stream `stream`; the first grant of an
     * upload tells the server the worker is ready. */
    grantCredit(stream: number, frames: number): void {
        this.send({ type: "credit", stream, frames });
    }

    /** Calls `handler` for every binary stream frame the server sends from now on. */
    onStreamFrame(handler: (frame: StreamFrame) => void): void {
        this.streamHandlers.push(handler);
    }

    /** Closes the connection. */
    close(): void {
        this.control.close();
    }
}

/** One binary frame of one stream. */
export type StreamFrame = {
    stream: number;
    last: boolean;
    data: Buffer;
};

/** Encodes one binary stream frame the way the agent's stream writer does. */
export function encodeStreamFrame(
    stream: number,
    data: Buffer,
    flags: { last?: boolean } = {},
): Buffer {
    const header = Buffer.alloc(STREAM_HEADER_SIZE);

    header.writeBigUInt64LE(BigInt(stream), 0);
    header.writeUInt8(flags.last === true ? FLAG_FIN : 0, 8);

    return Buffer.concat([header, data]);
}

/** Decodes one binary stream frame the server sent. */
export function decodeStreamFrame(bytes: Buffer): StreamFrame {
    const flags = bytes.readUInt8(8);

    return {
        stream: Number(bytes.readBigUInt64LE(0)),
        last: (flags & FLAG_FIN) !== 0,
        data: bytes.subarray(STREAM_HEADER_SIZE),
    };
}

/** Normalizes every binary payload representation `ws` may hand to a listener. */
function rawDataToBuffer(data: WebSocket.RawData): Buffer {
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }

    return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}
