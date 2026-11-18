import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProcessManager, VITEST_SERVER_PORT, waitForPort } from "./test-utils";

const processManager = new ProcessManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

beforeAll(async () => {
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processManager.spawnServer({});
    await waitForPort(VITEST_SERVER_PORT);
});

afterAll(() => processManager.killAll());

/** Reads the first Vite content-hashed asset that `index.html` references. */
async function firstHashedAssetPath(): Promise<string> {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const match = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html);

    if (!match?.[1]) {
        throw new Error("index.html does not reference any /assets/ file");
    }

    return match[1];
}

describe("embedded UI serving", () => {
    it("answers client-side router deep links with index.html", async () => {
        const response = await fetch(`${baseUrl}/agents/foo/bar`);

        // TanStack Router can only resolve deep links if the server returns the SPA shell.
        expect(response.status).toBe(200);
        // The shell must be served as HTML so the browser renders it.
        expect(response.headers.get("content-type")).toBe("text/html");
        // index.html is not content-hashed, so a new UI build must be revalidated.
        expect(response.headers.get("cache-control")).toBe("no-cache");
        // The body must be the actual SPA shell, not an error page.
        expect(await response.text()).toContain('<div id="app">');
    });

    it("caches content-hashed assets forever", async () => {
        const assetPath = await firstHashedAssetPath();
        const response = await fetch(`${baseUrl}${assetPath}`);

        // Hashed assets must be served as real files, not the SPA fallback.
        expect(response.status).toBe(200);
        // The browser refuses to run module scripts and styles with the wrong MIME type.
        expect(response.headers.get("content-type")).toMatch(
            /^(text\/javascript|application\/javascript|text\/css)$/,
        );
        // The file name changes with its content, so browsers never need to revalidate it.
        expect(response.headers.get("cache-control")).toBe(
            "public, max-age=31536000, immutable",
        );
    });

    it("answers a matching If-None-Match with 304", async () => {
        const first = await fetch(`${baseUrl}/`);
        const etag = first.headers.get("etag");

        // Revalidating no-cache files depends on the server sending an ETag.
        expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

        const revalidated = await fetch(`${baseUrl}/agents/foo/bar`, {
            headers: { "If-None-Match": etag ?? "" },
        });

        // Deep links serve the same index.html, so the browser's cached copy is still valid.
        expect(revalidated.status).toBe(304);
        // A 304 must not resend the body.
        expect(await revalidated.text()).toBe("");
    });

    it("rejects writes to UI paths", async () => {
        const response = await fetch(`${baseUrl}/agents/foo/bar`, {
            method: "POST",
        });

        // Static UI files are read-only, so a write is a client error, not the SPA shell.
        expect(response.status).toBe(405);
    });
});
