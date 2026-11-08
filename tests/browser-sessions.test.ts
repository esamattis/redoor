import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiClient } from "#ui/api-client";
import type { BrowserSessionListResponse } from "#bindings/BrowserSessionListResponse";
import type { SignOutSessionsResponse } from "#bindings/SignOutSessionsResponse";
import {
    ProcessManager,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    createAccessToken,
    waitForPort,
} from "./test-utils";

const processManager = new ProcessManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

/** Per-file home, so the session list holds only the sessions this file signs in. */
const serverHome = join(
    tmpdir(),
    `redoor-vitest-browser-sessions-home-${VITEST_SERVER_PORT}`,
);

/** A session-signed client for creating access tokens. */
let apiClient: ApiClient;

beforeAll(async () => {
    processManager.spawnServer({ home: serverHome });
    await waitForPort(VITEST_SERVER_PORT);
    apiClient = new ApiClient(baseUrl);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
}, 30000);

afterAll(async () => {
    await processManager.killAll();
});

/** Signs in like a browser with the given `User-Agent`, optionally behind a proxy. */
async function signIn(
    userAgent: string,
    forwardedFor?: string,
): Promise<string> {
    const headers = new Headers({
        "Content-Type": "application/json",
        "User-Agent": userAgent,
    });

    if (forwardedFor !== undefined) {
        headers.set("X-Forwarded-For", forwardedFor);
    }

    const response = await fetch(`${baseUrl}/api/v1/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            username: TEST_USERNAME,
            password: TEST_PASSWORD,
        }),
    });

    expect(response.status).toBe(200);

    return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

/** Sends a request with a browser's session cookie. */
function withCookie(
    cookie: string,
    path: string,
    method = "GET",
): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method, headers: { Cookie: cookie } });
}

/** The session list as seen by the browser holding `cookie`. */
async function listSessions(
    cookie: string,
): Promise<BrowserSessionListResponse> {
    const response = await withCookie(cookie, "/api/v1/sessions");

    expect(response.status).toBe(200);

    const listed: BrowserSessionListResponse = await response.json();

    return listed;
}

describe("Browser sessions", () => {
    it("is not available to access tokens", async () => {
        const { token } = await createAccessToken(apiClient, {
            permissions: ["files:read", "files:write", "commands:execute"],
        });

        for (const [method, path] of [
            ["GET", "/api/v1/sessions"],
            ["DELETE", "/api/v1/sessions"],
            ["DELETE", "/api/v1/sessions/0123456789abcdef"],
        ]) {
            const response = await fetch(`${baseUrl}${path}`, {
                method,
                headers: { Authorization: `Bearer ${token}` },
            });

            // A token must never see where browsers signed in from or end them.
            expect(response.status, `${method} ${path}`).toBe(403);
        }
    });

    it("lists signed-in browsers with their user agent and addresses", async () => {
        const laptop = await signIn("Laptop browser/1.0");
        const phone = await signIn("Phone browser/2.0", "203.0.113.7");

        const { sessions } = await listSessions(laptop);

        const laptopSession = sessions.find(
            (session) => session.user_agent === "Laptop browser/1.0",
        );

        const phoneSession = sessions.find(
            (session) => session.user_agent === "Phone browser/2.0",
        );

        // The caller's own session is marked, so the UI can tell it apart.
        expect(laptopSession?.current).toBe(true);
        // Every other session is not the caller's.
        expect(phoneSession?.current).toBe(false);
        // The TCP peer and the proxy's claim are both recorded at sign-in.
        expect(phoneSession).toMatchObject({
            name: TEST_USERNAME,
            method: "password",
            ip: "127.0.0.1",
            forwarded_for: "203.0.113.7",
        });
        // Without a proxy header there is no forwarded client.
        expect(laptopSession?.forwarded_for).toBeNull();

        const cookieValues = [laptop, phone].map(
            (cookie) => cookie.split("=", 2)[1] ?? "",
        );

        // The list never exposes a cookie value, which is a bearer secret.
        for (const value of cookieValues) {
            expect(JSON.stringify(sessions)).not.toContain(value);
        }
    });

    it("signs out one session by its id", async () => {
        const own = await signIn("Own browser/1.0");
        const other = await signIn("Other browser/1.0");
        const { sessions } = await listSessions(own);

        const target = sessions.find(
            (session) => session.user_agent === "Other browser/1.0",
        );

        expect(target).toBeDefined();
        const path = `/api/v1/sessions/${target?.id ?? ""}`;
        const response = await withCookie(own, path, "DELETE");

        // One session was signed out.
        expect(response.status).toBe(200);
        const result: SignOutSessionsResponse = await response.json();

        expect(result.signed_out).toBe(1);
        // The signed-out browser is rejected from now on.
        expect((await withCookie(other, "/api/v1/auth/me")).status).toBe(401);
        // The browser that signed it out keeps working.
        expect((await withCookie(own, "/api/v1/auth/me")).status).toBe(200);
        // It is no longer listed.
        expect(
            (await listSessions(own)).sessions.map((session) => session.id),
        ).not.toContain(target?.id);
        // Signing it out again finds nothing.
        expect((await withCookie(own, path, "DELETE")).status).toBe(404);
    });

    it("signs out every other session but keeps the caller's", async () => {
        const own = await signIn("Keeper browser/1.0");

        const others = [
            await signIn("Second browser/1.0"),
            await signIn("Third browser/1.0"),
        ];

        const response = await withCookie(own, "/api/v1/sessions", "DELETE");

        // Every other session was signed out, including the shared client's from setup.
        expect(response.status).toBe(200);
        const result: SignOutSessionsResponse = await response.json();

        // Both browsers this test signed in are among them.
        expect(result.signed_out).toBeGreaterThanOrEqual(others.length);

        for (const cookie of others) {
            // Each other browser must sign in again.
            expect((await withCookie(cookie, "/api/v1/auth/me")).status).toBe(
                401,
            );
        }

        const { sessions } = await listSessions(own);

        // Only the caller's session is left.
        expect(sessions.map((session) => session.user_agent)).toEqual([
            "Keeper browser/1.0",
        ]);
    });
});
