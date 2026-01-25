import type { LsDirectoryResponse } from "../../bindings/LsDirectoryResponse";
import type { LsFileResponse } from "../../bindings/LsFileResponse";
import type { ErrorResponse } from "../../bindings/ErrorResponse";
import type { AgentListResponse } from "../../bindings/AgentListResponse";
import type { AgentDetailsResponse } from "../../bindings/AgentDetailsResponse";
import type { EchoRequest } from "../../bindings/EchoRequest";
import type { EchoResponse } from "../../bindings/EchoResponse";
import type { AgentInfoResponse } from "../../bindings/AgentInfoResponse";

export type { LsDirectoryResponse, LsFileResponse };

export type LsResponse = LsDirectoryResponse | LsFileResponse;

export function isLsDirectoryResponse(response: LsResponse): response is LsDirectoryResponse {
    return "files" in response;
}

export function isLsFileResponse(response: LsResponse): response is LsFileResponse {
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

    async echo(message: string, random_sleep: boolean = false): Promise<EchoResponse> {
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
        const url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/raw/${encodeURIComponent(path)}`;
        const response = await fetch(url);

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

        return response.arrayBuffer();
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

    async listAgents(): Promise<Agent[]> {
        const response = await apiRequest<AgentListResponse>(
            this.baseUrl,
            "/api/v1/agents",
        );
        return response.agents.map((info) => new Agent(this.baseUrl, info));
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
