import type { LsDirectoryResponse } from "../../bindings/LsDirectoryResponse";
import type { LsFileResponse } from "../../bindings/LsFileResponse";
import type { ErrorResponse } from "../../bindings/ErrorResponse";
import type { AgentListResponse } from "../../bindings/AgentListResponse";
import type { AgentDetailsResponse } from "../../bindings/AgentDetailsResponse";
import type { EchoRequest } from "../../bindings/EchoRequest";
import type { EchoResponse } from "../../bindings/EchoResponse";
import type { AgentInfoResponse } from "../../bindings/AgentInfoResponse";
import type { TransferDirection } from "../../bindings/TransferDirection";
import type { TransferProgressEntry } from "../../bindings/TransferProgressEntry";
import type { TransferProgressListResponse } from "../../bindings/TransferProgressListResponse";
import type { TransferProgressState } from "../../bindings/TransferProgressState";
import type { UiEvent } from "../../bindings/UiEvent";
import type { RawDeleteResponse } from "../../bindings/RawDeleteResponse";

export type { LsDirectoryResponse, LsFileResponse };
export type {
    RawDeleteResponse,
    TransferDirection,
    TransferProgressEntry,
    TransferProgressListResponse,
    TransferProgressState,
    UiEvent,
};

type TransferProgressEntryJson = Omit<
    TransferProgressEntry,
    "request_id" | "total_bytes" | "transferred_bytes"
> & {
    request_id: number | string | bigint;
    total_bytes: number | string | bigint;
    transferred_bytes: number | string | bigint;
};

type TransferProgressListResponseJson = {
    transfers: Array<TransferProgressEntryJson>;
};

export type LsResponse = LsDirectoryResponse | LsFileResponse;

export function isLsDirectoryResponse(
    response: LsResponse,
): response is LsDirectoryResponse {
    return "files" in response;
}

export function isLsFileResponse(
    response: LsResponse,
): response is LsFileResponse {
    return "size" in response;
}

export class Agent {
    private baseUrl: string;
    private info: AgentInfoResponse;

    constructor(baseUrl: string, info: AgentInfoResponse) {
        this.baseUrl = baseUrl;
        this.info = info;
    }

    get id(): string {
        return this.info.id;
    }

    get name(): string {
        return this.info.name;
    }

    async getDetails(): Promise<AgentDetailsResponse> {
        return apiRequest(
            this.baseUrl,
            `/api/v1/agents/${encodeURIComponent(this.info.id)}`,
        );
    }

    async ls(path: string): Promise<LsResponse> {
        return apiRequest<LsResponse>(
            this.baseUrl,
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/ls/${encodeURIComponent(path)}`,
        );
    }

    async echo(
        message: string,
        random_sleep: boolean = false,
    ): Promise<EchoResponse> {
        const request: EchoRequest = { message, random_sleep };
        return apiRequest(
            this.baseUrl,
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/echo`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
        );
    }

    async raw(path: string): Promise<ArrayBuffer> {
        const response = await this.download(path);
        return response.arrayBuffer();
    }

    getRawUrl(
        path: string,
        options?: { cwd?: string; download?: boolean },
    ): string {
        let relativePath = path;
        if (options?.cwd && path.startsWith(options.cwd)) {
            // Remove the cwd prefix and leading slash
            relativePath = path.slice(options.cwd.length).replace(/^\//, "");
        }
        const encodedPath = relativePath
            .split("/")
            .map(encodeURIComponent)
            .join("/");
        let url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/raw/${encodedPath}`;
        if (options?.download) {
            url += "?download=1";
        }
        return url;
    }

    async upload(path: string, file: File): Promise<Response> {
        const response = await fetch(this.getRawUrl(path), {
            method: "PUT",
            headers: {
                "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
        });

        if (!response.ok) {
            const text = await response.text();
            if (text) {
                const error: ErrorResponse = JSON.parse(text);
                throw new Error(error.error);
            }
            throw new Error(
                `Request failed: ${response.status} ${response.statusText}`,
            );
        }

        return response;
    }

    async deleteFile(path: string): Promise<RawDeleteResponse> {
        const response = await fetch(this.getRawUrl(path), {
            method: "DELETE",
        });

        if (!response.ok) {
            const text = await response.text();
            if (text) {
                const error: ErrorResponse = JSON.parse(text);
                throw new Error(error.error);
            }
            throw new Error(
                `Request failed: ${response.status} ${response.statusText}`,
            );
        }

        return response.json();
    }

    async download(
        path: string,
        options?: {
            range?: [number | null, number | null];
            method?: "GET" | "HEAD";
            download?: boolean;
        },
    ): Promise<Response> {
        const url = this.getRawUrl(path, {
            download: options?.download,
        });

        const fetchOptions: RequestInit = {};
        if (options?.method) {
            fetchOptions.method = options.method;
        }
        if (options?.range) {
            const [start, end] = options.range;
            if (start === null && end !== null) {
                // Suffix range: bytes=-N
                fetchOptions.headers = { Range: `bytes=-${end}` };
            } else if (end === null) {
                // Open-ended range: bytes=start-
                fetchOptions.headers = { Range: `bytes=${start}-` };
            } else if (end !== undefined) {
                // Full range: bytes=start-end
                fetchOptions.headers = { Range: `bytes=${start}-${end}` };
            }
        }

        const response = await fetch(url, fetchOptions);

        // 416 Range Not Satisfiable is a valid response for range requests
        if (!response.ok && response.status !== 416) {
            const text = await response.text();
            if (text) {
                const error: ErrorResponse = JSON.parse(text);
                throw new Error(error.error);
            }
            throw new Error(
                `Request failed: ${response.status} ${response.statusText}`,
            );
        }

        return response;
    }
}

async function apiRequest<T>(
    baseUrl: string,
    endpoint: string,
    options?: RequestInit,
): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    const response = await fetch(url, options);

    if (!response.ok) {
        const text = await response.text();
        if (text) {
            const error: ErrorResponse = JSON.parse(text);
            throw new Error(error.error);
        }
        throw new Error(
            `Request failed: ${response.status} ${response.statusText}`,
        );
    }

    return response.json();
}

export class ApiClient {
    baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    getUiWebSocketUrl(): string {
        const url = new URL("/api/v1/ui/ws", this.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    async listAgents(): Promise<Agent[]> {
        const response = await apiRequest<AgentListResponse>(
            this.baseUrl,
            "/api/v1/agents",
        );
        return response.agents.map((info) => new Agent(this.baseUrl, info));
    }

    async getTransferProgress(): Promise<TransferProgressListResponse> {
        const response = await apiRequest<TransferProgressListResponseJson>(
            this.baseUrl,
            "/api/v1/transfers/progress",
        );

        return {
            transfers: response.transfers.map((transfer) => ({
                ...transfer,
                request_id: BigInt(transfer.request_id),
                total_bytes: BigInt(transfer.total_bytes),
                transferred_bytes: BigInt(transfer.transferred_bytes),
            })),
        };
    }

    async waitForAgentNames(
        names: string[],
        timeoutMs: number = 5000,
    ): Promise<void> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const agents = await this.listAgents();
            const currentNames = agents.map((a) => a.name);
            if (names.every((name) => currentNames.includes(name))) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timeout waiting for agents: ${names.join(", ")}`);
    }
}
