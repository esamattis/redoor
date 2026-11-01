/** Preserve Node's original transport when Vitest reruns setup for another file. */
const pooledFetch = globalThis.fetch;

/**
 * Prevents idle HTTP connections from outliving a force-killed fixture server. Workers
 * reuse their server port between files, and a readiness response on one connection
 * cannot establish that every other connection in Node's pool belongs to the new server.
 * Closing only fixture requests also leaves toxiproxy and unrelated HTTP clients alone.
 */
export function installFixtureHttpTransport(serverPort: number): void {
    globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : undefined;
        const url = new URL(input instanceof Request ? input.url : input);

        if (
            url.protocol !== "http:" ||
            !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
            url.port !== serverPort.toString()
        ) {
            return pooledFetch(input, init);
        }

        // Explicit init headers replace Request headers according to fetch semantics;
        // otherwise retain the Request's authentication, content type and custom headers.
        const headers = new Headers(init?.headers ?? request?.headers);
        headers.set("Connection", "close");

        return pooledFetch(input, { ...init, headers });
    };
}
