import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

import {
    type Agent,
    ApiClient,
    SESSION_ENDED_CLOSE_CODE,
} from "#ui/api-client";
import type { LoginRequest } from "#bindings/LoginRequest";
import type { SessionLength } from "#bindings/SessionLength";
import {
    ProcessManager,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    TempFileManager,
    createAccessToken,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "session-lifetimes-agent";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

let baseUrl = "";

let apiClient: ApiClient;

let testAgent: Agent;

let agentCwd = "";

beforeAll(async () => {
    agentCwd = tempFiles.tempDirectory({ suffix: "-session-agent" });

    const setup = await startServerAndAgent({
        processManager,
        agentName: AGENT_NAME,
        agentCwd,
    });

    baseUrl = `http://127.0.0.1:${setup.serverPort}`;
    apiClient = setup.apiClient;
    testAgent = setup.testAgent;
}, 30000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** A signed-in browser: its cookie, the `Set-Cookie` it got and its session file. */
type BrowserSession = { cookie: string; setCookie: string; file: string };

/**
 * Signs in like the login page does, with an optional session length, and logs out when
 * the test ends. `undefined` leaves the field out, as an older client would.
 */
async function signIn(
    sessionLength: SessionLength | undefined,
): Promise<BrowserSession> {
    // Partial, because leaving the length out is what an older client does.
    const request: Partial<LoginRequest> = {
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
    };

    if (sessionLength) {
        request.session_length = sessionLength;
    }

    const response = await fetch(`${baseUrl}/api/v1/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";", 1)[0] ?? "";
    // The stable session id names the file; the secret after the dot rotates.
    const sessionId = cookie.split("=", 2)[1]?.split(".", 1)[0] ?? "";
    onTestFinished(async () => {
        await fetch(`${baseUrl}/api/v1/logout`, {
            method: "POST",
            headers: { Cookie: cookie },
        });
    });

    return {
        cookie,
        setCookie,
        file: join(
            TEST_SERVER_HOME,
            ".local/share",
            TEST_APP_NAME,
            "sessions",
            `session_${sessionId}.json`,
        ),
    };
}

/** The stored session, as the server reads it on every request. */
function readSession(session: BrowserSession): {
    expires_at: number;
    length: string;
} {
    return JSON.parse(readFileSync(session.file, "utf8"));
}

/** Ages the stored expiry, standing in for time passing without real waiting. */
function setExpiresIn(session: BrowserSession, seconds: number): number {
    const stored = JSON.parse(readFileSync(session.file, "utf8"));
    stored.expires_at = Math.floor(Date.now() / 1000) + seconds;
    writeFileSync(session.file, JSON.stringify(stored));

    return stored.expires_at;
}

/** Makes the session's secret a minute old, so the next activity report rotates it. */
function makeRotationDue(session: BrowserSession): void {
    const stored = JSON.parse(readFileSync(session.file, "utf8"));
    stored.current.issued_at -= 60;
    writeFileSync(session.file, JSON.stringify(stored));
}

/** Reports user activity with the browser's cookie. */
function reportActivity(session: BrowserSession): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/session/activity`, {
        method: "POST",
        headers: { Cookie: session.cookie },
    });
}

describe("Session lifetimes", () => {
    it("gives each chosen length its own lifetime behind one cookie Max-Age", async () => {
        const expected: [SessionLength | undefined, number][] = [
            // A client that does not choose gets the shortest session.
            [undefined, 3600],
            ["hour", 3600],
            ["day", 86400],
            ["week", 604800],
            ["month", 2592000],
            ["year", 31536000],
        ];

        for (const [length, seconds] of expected) {
            const session = await signIn(length);
            // Every cookie outlasts the longest session, so a transfer that holds a session
            // open past its length never loses the cookie; the server enforces the length.
            expect(session.setCookie).toMatch(/; Max-Age=31536000$/);
            const stored = readSession(session);
            // The choice is stored with the session, so renewals use the same length.
            expect(stored.length).toBe(length ?? "hour");
            const remaining = stored.expires_at - Date.now() / 1000;
            // The stored expiry is that far away.
            expect(remaining).toBeGreaterThan(seconds - 30);
            expect(remaining).toBeLessThanOrEqual(seconds + 1);
        }
    });

    it("renews only on reported activity", async () => {
        const session = await signIn("hour");
        const aged = setExpiresIn(session, 120);

        const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
            headers: { Cookie: session.cookie },
        });

        expect(me.status).toBe(200);
        const user = await me.json();
        // The UI learns when the session ends, to schedule its warning.
        expect(user.session.expires_in_seconds).toBeLessThanOrEqual(120);
        expect(user.session.expires_in_seconds).toBeGreaterThan(60);
        // Ordinary requests leave the expiry alone, so polling does not keep a page alive.
        expect(readSession(session).expires_at).toBe(aged);

        makeRotationDue(session);
        const activity = await reportActivity(session);

        expect(activity.status).toBe(200);
        const expiry = await activity.json();
        // Activity moves the expiry a full hour ahead and reports it.
        expect(expiry.expires_in_seconds).toBeGreaterThan(3500);
        expect(readSession(session).expires_at).toBeGreaterThan(aged + 3000);
        const sessionId = session.cookie.split("=", 2)[1]?.split(".", 1)[0];
        // Activity rotates the secret once it is a minute old, so the cookie it sends is a
        // different one for the same session, with the fixed Max-Age, so a session kept
        // active for over a year does not lose its cookie.
        const renewedCookie = activity.headers.get("set-cookie") ?? "";
        expect(renewedCookie).toMatch(
            new RegExp(
                `^redoor_session=${sessionId}\\.[^;]+; .*; Max-Age=31536000$`,
            ),
        );
        expect(renewedCookie.split(";", 1)[0]).not.toBe(session.cookie);
    });

    it("does not let activity revive an expired session", async () => {
        const session = await signIn("hour");
        setExpiresIn(session, -1);
        const activity = await reportActivity(session);
        // The activity endpoint sits behind the normal access check.
        expect(activity.status).toBe(401);

        const agents = await fetch(`${baseUrl}/api/v1/agents`, {
            headers: { Cookie: session.cookie },
        });

        // The expired session stays signed out.
        expect(agents.status).toBe(401);
    });

    it("refuses activity reports from access tokens", async () => {
        const { token } = await createAccessToken(apiClient, {
            permissions: ["files:read"],
        });

        const response = await fetch(`${baseUrl}/api/v1/session/activity`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        });

        // Tokens do not idle out, so the route is for browser sessions only.
        expect(response.status).toBe(403);
    });

    it("renews the session when a download finishes", async () => {
        writeFileSync(join(agentCwd, "download.txt"), "session keepalive");
        const session = await signIn("hour");
        const aged = setExpiresIn(session, 120);

        const listing = await fetch(
            `${baseUrl}/api/v1/agents/${encodeURIComponent(testAgent.id)}/ls${agentCwd}`,
            { headers: { Cookie: session.cookie } },
        );

        expect(listing.status).toBe(200);
        // A listing is no transfer, so it does not count as activity.
        expect(readSession(session).expires_at).toBe(aged);

        const download = await fetch(
            testAgent.getRawUrl(join(agentCwd, "download.txt")),
            { headers: { Cookie: session.cookie } },
        );

        // The download itself works as usual.
        expect(await download.text()).toBe("session keepalive");
        // Once its body is through, the transfer renews the session in the background.
        await waitForValue({
            predicate: async () =>
                readSession(session).expires_at > aged + 3000 || undefined,
            description: "the session renewed after the download",
        });
    });

    it("closes browser websockets with 4401 once the session ends", async () => {
        const session = await signIn("hour");

        const socket = new WebSocket(apiClient.getUiWebSocketUrl(), {
            headers: { Cookie: session.cookie },
        });

        onTestFinished(() => socket.close());
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });

        const closed = new Promise<number>((resolve) =>
            socket.once("close", (code) => resolve(code)),
        );

        const logout = await fetch(`${baseUrl}/api/v1/logout`, {
            method: "POST",
            headers: { Cookie: session.cookie },
        });

        expect(logout.status).toBe(200);
        // The socket checks its session every 30 seconds and then closes with the code the
        // UI turns into a trip to the login page instead of a reconnect.
        expect(await closed).toBe(SESSION_ENDED_CLOSE_CODE);
    }, 60000);
});
