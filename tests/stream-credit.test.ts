import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import type { ApiClient } from "#ui/api-client";
import { FakeAgent } from "./fake-agent";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

/** Frames the misbehaving stream sends, far beyond any credit window. */
const FLOOD_FRAMES = 64;

/** One frame-sized payload of the flood. */
const FLOOD_PAYLOAD = Buffer.alloc(64 * 1024, "f");

describe("per-stream credit on the multiplexed connection", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let serverPort: number;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: "stream-credit-agent",
            agentCwd: tempFiles.tempDirectory({ suffix: "-stream-credit" }),
        });

        api = setup.apiClient;
        serverPort = setup.serverPort;
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    /** Starts an execution through REST and returns the response without reading its body. */
    async function startExec(device: string, argv: string[]): Promise<Response> {
        return fetch(`${api.baseUrl}/api/v1/agents/${device}/exec`, {
            method: "POST",
            headers: {
                ...api.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ argv }),
        });
    }

    it("fails only the stream that exceeds its credit", async () => {
        const agentName = "stream-credit-fake";
        const fake = await FakeAgent.connect({ serverPort, agentName });

        onTestFinished(() => fake.close());
        await waitForValue({
            description: "fake agent connected",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.id === fake.agentId && agent.status === "connected",
                ),
        });

        const floodResponse = await startExec(agentName, ["flood"]);
        const flood = await fake.nextCommand("Exec");

        // The body is never read, so the server cannot drain the flood as fast as it arrives.
        for (let index = 0; index < FLOOD_FRAMES; index++) {
            fake.sendStreamFrame(flood.id, FLOOD_PAYLOAD);
        }

        const cancel = await fake.waitForFrame(
            (frame) => frame.type === "cancel" && frame.id === flood.id,
        );

        // The server stops the violating worker instead of buffering without bound.
        expect(cancel.id).toBe(flood.id);

        const honestResponse = await startExec(agentName, ["honest"]);
        const honest = await fake.nextCommand("Exec");

        const stdout = JSON.stringify({
            type: "stdout",
            data: Buffer.from("hi").toString("base64"),
        });

        const exit = { type: "exit", code: 0, signal: null };

        // Output streams start with the credit the command frame grants.
        expect(honest.credit).toBeGreaterThan(0);
        fake.sendStreamFrame(honest.id, Buffer.from(`${stdout}\n`));
        fake.sendStreamFrame(honest.id, Buffer.alloc(0), { last: true });
        fake.respond(honest.id, exit);

        // Another stream of the same connection still completes normally after the violation.
        expect(await honestResponse.text()).toBe(`${stdout}\n${JSON.stringify(exit)}\n`);
        // The violating stream's body aborts instead of ending like a short but complete output.
        // Reading it to the end also makes the abort deterministic: canceling the unread body
        // raced the server's connection abort and could reject with the same error.
        await expect(floodResponse.text()).rejects.toThrow("terminated");
    });
});
