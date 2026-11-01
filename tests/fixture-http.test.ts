import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { expect, it, onTestFinished } from "vitest";
import { VITEST_SERVER_PORT } from "./test-utils";

/** Replacement on the same port must never inherit idle sockets from the previous server. */
it("closes fixture HTTP connections before replacing the server on its worker port", async () => {
    const servers: Server[] = [];
    const activeSockets = new Set<Socket>();

    onTestFinished(async () => {
        for (const server of servers) {
            server.closeAllConnections();

            if (server.listening) {
                await new Promise<void>((resolve) =>
                    server.close(() => resolve()),
                );
            }
        }
    });

    for (let generation = 0; generation < 2; generation++) {
        const closed: Promise<unknown[]>[] = [];

        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];

            for await (const chunk of request) chunks.push(Buffer.from(chunk));

            response.setHeader("Content-Type", "application/json");
            response.end(
                JSON.stringify({
                    generation,
                    headers: request.headers,
                    method: request.method,
                    body: Buffer.concat(chunks).toString(),
                }),
            );
        });

        servers.push(server);
        server.on("connection", (socket) => {
            activeSockets.add(socket);
            closed.push(once(socket, "close"));
            socket.once("close", () => activeSockets.delete(socket));
        });
        const listening = once(server, "listening");
        server.listen(VITEST_SERVER_PORT, "127.0.0.1");
        await listening;

        const url = `http://127.0.0.1:${VITEST_SERVER_PORT}/fixture`;

        const responses = await Promise.all(
            Array.from({ length: 4 }, async () => {
                const response = await fetch(
                    new Request(url, {
                        method: "POST",
                        headers: {
                            Authorization: "Bearer fixture",
                            "X-Fixture": "request",
                        },
                        body: "request body",
                    }),
                );

                return response.json();
            }),
        );

        // Concurrent requests populate several sockets; every one must explicitly close,
        // while preserving the original Request's authentication, method and body.
        for (const response of responses) {
            expect(response).toMatchObject({
                generation,
                headers: {
                    connection: "close",
                    authorization: "Bearer fixture",
                    "x-fixture": "request",
                },
                method: "POST",
                body: "request body",
            });
        }

        const overridden = await fetch(
            new Request(url, {
                headers: { "X-Fixture": "discarded" },
            }),
            {
                method: "POST",
                headers: { "X-Override": "retained" },
                body: "override body",
            },
        );

        const result = await overridden.json();

        // RequestInit retains its normal precedence instead of merging discarded Request headers.
        expect(result).toMatchObject({
            headers: { connection: "close", "x-override": "retained" },
            method: "POST",
            body: "override body",
        });
        expect(result.headers).not.toHaveProperty("x-fixture");

        await Promise.all(closed);
        // Observe actual socket closure before replacing the listener, without sleeps or retries.
        expect(activeSockets.size).toBe(0);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
