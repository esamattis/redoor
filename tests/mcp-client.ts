import { onTestFinished } from "vitest";
import { decodeJsonResponse } from "#ui/api-transport";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export type McpRequestMetadata = {
    "io.modelcontextprotocol/protocolVersion": string;
    "io.modelcontextprotocol/clientCapabilities": JsonObject;
    "io.modelcontextprotocol/clientInfo"?: {
        name: string;
        version: string;
    };
    [key: string]: JsonValue | undefined;
};

export type McpResponse<TResult = JsonObject> = {
    jsonrpc: "2.0";
    id: string | number;
    result: TResult;
};

export type McpTool = {
    name: string;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
};

type McpOperationContent = JsonObject & {
    operation_id: string;
    state: string;
};

/** Encodes mirrored name values using the 2026-07-28 HTTP sentinel rules. */
function encodeHeaderValue(value: string): string {
    const safe = /^[\x20-\x7e]+$/.test(value);

    const needsEncoding =
        !safe ||
        value.trim() !== value ||
        (value.startsWith("=?base64?") && value.endsWith("?="));

    return needsEncoding
        ? `=?base64?${Buffer.from(value).toString("base64")}?=`
        : value;
}

/** Thin revision-specific client is used because the current SDK targets initialization-era MCP. */
export class McpTestClient {
    private nextId = 1;
    private readonly requests = new Set<AbortController>();

    public constructor(
        private readonly endpoint: string,
        private readonly token: string,
        private readonly metadata: McpRequestMetadata,
    ) {}

    /** Discovers protocol identity and advertised capabilities without establishing a session. */
    public async discover(metadata?: Partial<McpRequestMetadata>) {
        return this.request<{
            resultType: string;
            supportedVersions: string[];
            capabilities: JsonObject;
        }>("server/discover", {}, { metadata });
    }

    /** Lists the caller-visible deterministic tool catalog. */
    public async listTools(metadata?: Partial<McpRequestMetadata>) {
        return this.request<{
            resultType: string;
            tools: McpTool[];
        }>("tools/list", {}, { metadata });
    }

    /** Calls one tool with all authorization and metadata repeated on this request. */
    public async callTool<TStructured extends JsonObject = JsonObject>(
        name: string,
        arguments_: JsonObject = {},
        metadata?: Partial<McpRequestMetadata>,
    ) {
        return this.request<{
            resultType: string;
            content: JsonObject[];
            structuredContent?: TStructured;
            isError?: boolean;
        }>(
            "tools/call",
            { name, arguments: arguments_ },
            {
                metadata,
                mirroredName: name,
            },
        );
    }

    /** Reads one principal-owned operation without relying on transport session state. */
    public async getOperation(operationId: string) {
        return this.callTool<McpOperationContent>("get_operation", {
            operation_id: operationId,
        });
    }

    /**
     * Polls until an operation reaches an explicit terminal or ambiguous state. The interval
     * backs off because every poll spends the token's per-minute MCP request budget, which
     * the whole suite shares; a fixed fast poll exhausted it on multi-second operations.
     */
    public async waitForOperation(
        operationId: string,
        timeoutMs: number = 30_000,
    ) {
        const deadline = Date.now() + timeoutMs;
        let intervalMs = 20;

        for (;;) {
            const response = await this.getOperation(operationId);
            const state = response.result.structuredContent?.state;

            if (
                state !== undefined &&
                [
                    "completed",
                    "failed",
                    "canceled",
                    "timed_out",
                    "interrupted",
                    "unknown",
                ].includes(state)
            ) {
                return response;
            }

            if (Date.now() >= deadline) {
                throw new Error(
                    `Timed out waiting for operation ${operationId}`,
                );
            }

            await new Promise<void>((resolve) => {
                setTimeout(resolve, intervalMs);
            });
            intervalMs = Math.min(intervalMs * 2, 250);
        }
    }

    /** Exposes method-level requests so section 2 can add polling without another transport. */
    public async request<TResult = JsonObject>(
        method: string,
        params: JsonObject,
        options: {
            metadata?: Partial<McpRequestMetadata>;
            mirroredName?: string;
        } = {},
    ): Promise<McpResponse<TResult>> {
        const id = this.nextId++;
        const controller = new AbortController();
        this.requests.add(controller);
        const requestMetadata = { ...this.metadata, ...options.metadata };

        const headers = new Headers({
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": String(
                requestMetadata["io.modelcontextprotocol/protocolVersion"],
            ),
            "Mcp-Method": method,
        });

        if (options.mirroredName !== undefined) {
            headers.set("Mcp-Name", encodeHeaderValue(options.mirroredName));
        }

        try {
            const response = await fetch(this.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    method,
                    params: { ...params, _meta: requestMetadata },
                }),
                signal: controller.signal,
            });

            const body = await decodeJsonResponse<
                McpResponse<TResult> & {
                    error?: { code: number; message: string };
                }
            >(response);

            if (!response.ok || body.error !== undefined) {
                throw new Error(
                    `MCP ${method} failed (${response.status}): ${JSON.stringify(body.error ?? body)}`,
                );
            }

            return body;
        } finally {
            this.requests.delete(controller);
        }
    }

    /** Aborts request-scoped streams and future polling owned by this client instance. */
    public close(): void {
        for (const request of this.requests) {
            request.abort();
        }

        this.requests.clear();
    }
}

/** Creates an independent client and binds cleanup to the currently running Vitest test. */
export function createMcpTestClient(options: {
    endpoint: string;
    token: string;
    metadata?: Partial<McpRequestMetadata>;
}): McpTestClient {
    const client = new McpTestClient(options.endpoint, options.token, {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
            name: "redoor-vitest",
            version: "1.0.0",
        },
        ...options.metadata,
    });

    onTestFinished(() => client.close());

    return client;
}
