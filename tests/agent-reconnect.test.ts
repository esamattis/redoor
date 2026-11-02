import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import {
    generateDeviceId,
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

/** A TCP port nothing listens on, so connection attempts to it are refused at once. */
async function closedPort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = tcpAddressSchema.parse(server.address());

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return port;
}

/** Relays TCP while allowing tests to discard server-to-agent bytes without closing sockets. */
async function createDownstreamBlackholeProxy(upstreamPort: number): Promise<{
    port: number;
    setBlocked: (blocked: boolean) => void;
    disconnectUpstreams: () => void;
    close: () => Promise<void>;
}> {
    let blocked = false;
    const sockets = new Set<Socket>();
    const upstreams = new Set<Socket>();

    const server = createServer((client) => {
        const upstream = connect(upstreamPort, "127.0.0.1");
        sockets.add(client);
        sockets.add(upstream);
        upstreams.add(upstream);
        client.on("data", (chunk) => {
            if (!upstream.destroyed) upstream.write(chunk);
        });
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
            upstreams.delete(upstream);

            // A blackhole drops remote closure as well as bytes; only the agent's own
            // liveness monitor may end its socket while downstream traffic is blocked.
            if (!blocked) client.destroy();
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
        // Force server-first teardown to exercise the liveness race under any CPU load.
        disconnectUpstreams: () => {
            for (const upstream of upstreams) {
                upstream.destroy();
            }
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
            wsAddress: `ws://127.0.0.1:${proxy.port}`,
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
        // A blackhole must hide a remote FIN just as it hides WebSocket frames.
        proxy.disconnectUpstreams();

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

    it("exits a supervised agent that cannot reach its server for the stale timeout", async () => {
        const port = await closedPort();

        // `--agent-id` marks an agent started by the watchdog or a relay.
        const agentPid = processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${port}/api/v1/agent/ws`,
            name: "supervised-unreachable-agent",
            agentId: generateDeviceId(),
            cwd: process.cwd(),
            home: process.cwd(),
        });

        const exitCode = await processManager.waitForExit(agentPid, 15_000);

        // The failure status is what the watchdog or relay reacts to with a fresh SSH session.
        expect(exitCode).not.toBe(0);
        // The agent says why it left, so a relay log explains the relaunch.
        expect(processManager.getStdout(agentPid)).toContain(
            "exiting so the supervisor can start a fresh agent",
        );
        // It retried inside its window before giving up, so short outages need no relaunch.
        expect(
            (
                processManager
                    .getStdout(agentPid)
                    .match(/Attempting to connect/g) ?? []
            ).length,
        ).toBeGreaterThan(1);
    });
});
