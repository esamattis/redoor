import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
    waitForValue,
} from "./test-utils";

const processManager = new ProcessManager();
const tcpAddressSchema = z.object({ port: z.number().int().positive() });

afterAll(async () => {
    await processManager.killAll();
});

/** Relays TCP while allowing tests to discard server-to-agent bytes without closing sockets. */
async function createDownstreamBlackholeProxy(upstreamPort: number): Promise<{
    port: number;
    setBlocked: (blocked: boolean) => void;
    close: () => Promise<void>;
}> {
    let blocked = false;
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
        const upstream = connect(upstreamPort, "127.0.0.1");
        sockets.add(client);
        sockets.add(upstream);
        client.on("data", (chunk) => upstream.write(chunk));
        upstream.on("data", (chunk) => {
            if (!blocked) {
                client.write(chunk);
            }
        });
        client.on("close", () => {
            sockets.delete(client);
            upstream.destroy();
        });
        upstream.on("close", () => {
            sockets.delete(upstream);
            client.destroy();
        });
        client.on("error", () => client.destroy());
        upstream.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = tcpAddressSchema.parse(server.address());

    return {
        port: address.port,
        setBlocked: (nextBlocked) => {
            blocked = nextBlocked;
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        },
    };
}

describe("Agent connection recovery", () => {
    it("abandons a blackholed socket and reconnects after traffic resumes", async () => {
        process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
        processManager.spawnServer({});
        await waitForPort(VITEST_SERVER_PORT);

        const apiClient = new ApiClient(
            `http://127.0.0.1:${VITEST_SERVER_PORT}`,
        );
        await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

        const proxy = await createDownstreamBlackholeProxy(VITEST_SERVER_PORT);
        onTestFinished(async () => {
            await proxy.close();
        });

        const agentName = "blackhole-reconnect-agent";
        const agentPid = processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${proxy.port}/ws`,
            name: agentName,
            cwd: process.cwd(),
            home: process.cwd(),
        });
        const initialAgent = await waitForValue({
            description: "initial proxied agent connection",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === agentName &&
                        agent.status === "connected",
                ),
        });

        proxy.setBlocked(true);

        await waitForValue({
            description: "agent-side stale connection detection",
            predicate: async () =>
                /Server connection stale/.test(
                    processManager.getStdout(agentPid),
                )
                    ? true
                    : undefined,
        });
        // The stale log proves the agent diagnosed silence without receiving a TCP close.
        expect(processManager.getStdout(agentPid)).toMatch(
            /Server connection stale/,
        );

        await waitForValue({
            description: "bounded blackholed reconnect handshake",
            timeoutMs: 10_000,
            predicate: async () =>
                /WebSocket connection attempt timed out/.test(
                    processManager.getStdout(agentPid),
                )
                    ? true
                    : undefined,
        });
        // Timing out the handshake prevents a reconnect attempt from owning the actor forever.
        expect(processManager.getStdout(agentPid)).toMatch(
            /WebSocket connection attempt timed out/,
        );

        proxy.setBlocked(false);

        const reconnectedAgent = await waitForValue({
            description: "agent reconnection after blackhole removal",
            timeoutMs: 15_000,
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === agentName &&
                        agent.status === "connected" &&
                        agent.connectionId !== initialAgent.connectionId,
                ),
        });
        // A new connection identity proves recovery used a replacement WebSocket generation.
        expect(reconnectedAgent.connectionId).not.toBe(
            initialAgent.connectionId,
        );
    }, 30_000);
});
