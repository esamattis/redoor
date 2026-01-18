import type { LsResponse } from "../../bindings/LsResponse";
import type { ErrorResponse } from "../../bindings/ErrorResponse";
import type { AgentListResponse } from "../../bindings/AgentListResponse";
import type { AgentDetailsResponse } from "../../bindings/AgentDetailsResponse";
import type { EchoResponse } from "../../bindings/EchoResponse";

export class ApiClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async listAgents(): Promise<AgentListResponse> {
        const url = `${this.baseUrl}/api/v1/agents`;
        const response = await fetch(url);

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to list agents: ${response.status} ${response.statusText} - ${text}`,
            );
        }

        return response.json();
    }

    async getAgentDetails(agent: string): Promise<AgentDetailsResponse> {
        const url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agent)}`;
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

        return response.json();
    }

    async ls(agent: string, path: string): Promise<LsResponse> {
        const url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agent)}/ls/${encodeURIComponent(path)}`;
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

        return response.json();
    }

    async echo(agent: string, message: string): Promise<EchoResponse> {
        const url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agent)}/echo`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message }),
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

    async waitForAgentNames(
        names: string[],
        timeoutMs: number = 5000,
    ): Promise<void> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const agents = await this.listAgents();
            const currentNames = agents.agents.map((a) => a.name);
            if (names.every((name) => currentNames.includes(name))) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timeout waiting for agents: ${names.join(", ")}`);
    }
}

export const api = new ApiClient(
    `${window.location.protocol}//${window.location.hostname}:3000`,
);
