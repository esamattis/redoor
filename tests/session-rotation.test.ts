import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Agent, ApiClient } from "#ui/api-client";
import type { BrowserSessionListResponse } from "#bindings/BrowserSessionListResponse";
import type { SessionRotationResponse } from "#bindings/SessionRotationResponse";
import {
    ProcessManager,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    TempFileManager,
    createAccessToken,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "session-rotation-agent";

/** Seconds the previous secret keeps working after a rotation (`ROTATION_GRACE`). */
const ROTATION_GRACE_SECONDS = 30;

/** Seconds between two rotations of a session (`ROTATION_INTERVAL`). */
const ROTATION_INTERVAL_SECONDS = 60;

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

let baseUrl = "";

let apiClient: ApiClient;

let serverPid = 0;

let testAgent: Agent;

let agentCwd = "";

beforeAll(async () => {
    agentCwd = tempFiles.tempDirectory({ suffix: "-rotation-agent" });

    const setup = await startServerAndAgent({
        processManager,
        agentName: AGENT_NAME,
        agentCwd,
    });

    baseUrl = `http://127.0.0.1:${setup.serverPort}`;
    apiClient = setup.apiClient;
    serverPid = setup.serverPid;
    testAgent = setup.testAgent;
}, 30000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** A signed-in browser: the cookie it got at sign-in and its session file. */
type BrowserSession = { id: string; cookie: string; file: string };

/** The stored parts of a session these tests read or age. */
type StoredSession = {
    expires_at: number;
    current: { hash: string; issued_at: number; unconfirmed: string | null };
    previous: { hash: string; retired_at: number } | null;
};

/** Signs in like the login page does. */
async function signIn(): Promise<BrowserSession> {
    const response = await fetch(`${baseUrl}/api/v1/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: TEST_USERNAME,
            password: TEST_PASSWORD,
            session_length: "hour",
        }),
    });

    expect(response.status).toBe(200);
    const cookie = requireSessionCookie(response);
    const id = sessionId(cookie);

    return {
        id,
        cookie,
        file: join(
            TEST_SERVER_HOME,
            ".local/share",
            TEST_APP_NAME,
            "sessions",
            `session_${id}.json`,
        ),
    };
}

/** The `redoor_session=<id>.<secret>` pair a response set, or `null` when it set none. */
function sessionCookie(response: Response): string | null {
    const pairs = response.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0] ?? "")
        .filter((pair) => pair.startsWith("redoor_session="));

    // A response never sets the session cookie twice; a second one would race the first.
    expect(pairs.length).toBeLessThanOrEqual(1);

    return pairs[0] ?? null;
}

/** The stable session id of a cookie pair. */
function sessionId(cookie: string): string {
    return cookie.split("=", 2)[1]?.split(".", 1)[0] ?? "";
}

/** Sends a request with a browser's cookie. */
function send(cookie: string, path: string, method = "GET"): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method, headers: { Cookie: cookie } });
}

/** The stored session, as the server reads it on every request. */
function readSession(session: BrowserSession): StoredSession {
    return JSON.parse(readFileSync(session.file, "utf8"));
}

/** Rewrites the stored session, standing in for time passing without real waiting. */
function editSession(
    session: BrowserSession,
    edit: (stored: StoredSession) => void,
): void {
    const stored = readSession(session);
    edit(stored);
    writeFileSync(session.file, JSON.stringify(stored));
}

/** Makes the current secret old enough for the next activity report or rotation to replace. */
function makeRotationDue(session: BrowserSession): void {
    editSession(session, (stored) => {
        stored.current.issued_at -= ROTATION_INTERVAL_SECONDS;
    });
}

/** Moves the last rotation past the grace period of the secret it replaced. */
function endGracePeriod(session: BrowserSession): void {
    editSession(session, (stored) => {
        if (stored.previous) {
            stored.previous.retired_at -= ROTATION_GRACE_SECONDS;
        }
    });
}

/** Ages the stored expiry to `seconds` from now and returns it. */
function setExpiresIn(session: BrowserSession, seconds: number): number {
    const expiresAt = Math.floor(Date.now() / 1000) + seconds;
    editSession(session, (stored) => {
        stored.expires_at = expiresAt;
    });

    return expiresAt;
}

/** Reports activity with a due secret and returns the rotated cookie. */
async function rotateWithActivity(session: BrowserSession): Promise<string> {
    makeRotationDue(session);

    const activity = await send(
        session.cookie,
        "/api/v1/session/activity",
        "POST",
    );

    expect(activity.status).toBe(200);

    return requireSessionCookie(activity);
}

/** The session cookie a response must have set. */
function requireSessionCookie(response: Response): string {
    const cookie = sessionCookie(response);

    if (cookie === null) {
        throw new Error("The response set no session cookie");
    }

    return cookie;
}

/** Expects a request with `cookie` to be refused as signed out. */
async function expectSignedOut(cookie: string): Promise<void> {
    const response = await send(cookie, "/api/v1/auth/me");

    expect(response.status).toBe(401);
}

/** Starts waiting for the server's reuse warning naming `timing`, before the request that triggers it. */
function reuseWarning(timing: RegExp): Promise<void> {
    const server = processManager.getProcess(serverPid);

    if (!server) {
        throw new Error("The server process is not running");
    }

    return waitForLogMessage(
        server,
        new RegExp(
            `Possible security breach: .* was used from two browsers.* The stale secret came from .+ and was ${timing.source}\\.`,
        ),
    );
}

describe("Session rotation", () => {
    it("rotates the secret on activity and accepts the old one only briefly", async () => {
        const session = await signIn();
        const rotated = await rotateWithActivity(session);

        // The new cookie names the same session with a new secret.
        expect(sessionId(rotated)).toBe(session.id);
        expect(rotated).not.toBe(session.cookie);
        const withNew = await send(rotated, "/api/v1/auth/me");
        // The new cookie works.
        expect(withNew.status).toBe(200);

        const withOld = await send(session.cookie, "/api/v1/auth/me");
        // Requests sent before the rotation response arrived still work ...
        expect(withOld.status).toBe(200);
        // ... and do not get a cookie that could overwrite the new one.
        expect(sessionCookie(withOld)).toBeNull();
    });

    it("re-sends a rotation the browser never received", async () => {
        const session = await signIn();
        const lost = await rotateWithActivity(session);
        endGracePeriod(session);

        const recovered = await send(session.cookie, "/api/v1/auth/me");

        // The browser with the old secret is still let in ...
        expect(recovered.status).toBe(200);
        // ... and gets the same secret the lost response carried.
        expect(sessionCookie(recovered)).toBe(lost);
        // The lost response arriving late installs a cookie that works too.
        expect((await send(lost, "/api/v1/auth/me")).status).toBe(200);
    });

    it("signs out both browsers when an old secret comes back", async () => {
        const session = await signIn();
        const rotated = await rotateWithActivity(session);
        // The UI confirms the new secret right after rotating.
        expect((await send(rotated, "/api/v1/auth/me")).status).toBe(200);
        endGracePeriod(session);

        const warned = reuseWarning(/rotated away \d+ s earlier/);
        // A copy of the old cookie, used after the grace period, proves two browsers.
        await expectSignedOut(session.cookie);
        // The server log is the only place the reuse is reported, with the timing that tells
        // a slow network from a stolen cookie.
        await warned;
        // The browser with the current secret is signed out as well ...
        await expectSignedOut(rotated);
        // ... because nothing of the session is kept.
        expect(existsSync(session.file)).toBe(false);
    });

    it("signs the session out for a made-up secret", async () => {
        const session = await signIn();
        const forged = `redoor_session=${session.id}.bWFkZS11cA`;

        const warned = reuseWarning(/never issued for this session/);
        // Only someone who once had a real cookie knows the id, so a wrong secret is reuse.
        await expectSignedOut(forged);
        await warned;
        // The real browser is signed out too.
        await expectSignedOut(session.cookie);
    });

    it("hands out one recovery cookie when two stale requests race", async () => {
        const session = await signIn();
        const rotated = await rotateWithActivity(session);
        // The new secret is older than the rotation interval and was never presented.
        editSession(session, (stored) => {
            stored.current.issued_at -= 2 * ROTATION_INTERVAL_SECONDS;

            if (stored.previous) {
                stored.previous.retired_at -= 2 * ROTATION_INTERVAL_SECONDS;
            }
        });

        const first = await send(session.cookie, "/api/v1/auth/me");
        // The first stale request repairs the browser's cookie.
        expect(sessionCookie(first)).toBe(rotated);
        const second = await send(session.cookie, "/api/v1/auth/me");
        // The recovery restarted the grace period, so the second one is simply accepted.
        expect(second.status).toBe(200);
        expect(sessionCookie(second)).toBeNull();

        const activity = await send(
            rotated,
            "/api/v1/session/activity",
            "POST",
        );

        expect(activity.status).toBe(200);
        // The recovery also restarted the rotation throttle, so no newer cookie can race the
        // second recovery response and be overwritten by it.
        expect(sessionCookie(activity)).toBeNull();
    });

    it("rotates on activity right after a finished transfer", async () => {
        writeFileSync(join(agentCwd, "download.txt"), "rotation");
        const session = await signIn();
        const aged = setExpiresIn(session, 120);
        makeRotationDue(session);

        const download = await fetch(
            testAgent.getRawUrl(join(agentCwd, "download.txt")),
            { headers: { Cookie: session.cookie } },
        );

        expect(await download.text()).toBe("rotation");
        // The finished transfer renews the session in the background.
        await waitForValue({
            predicate: async () =>
                readSession(session).expires_at > aged + 3000 || undefined,
            description: "the session renewed after the download",
        });

        const activity = await send(
            session.cookie,
            "/api/v1/session/activity",
            "POST",
        );

        expect(activity.status).toBe(200);
        // The renewal by the transfer does not hold back the rotation, so an attacker
        // finishing downloads cannot keep the victim's secret from changing.
        expect(sessionCookie(activity)).not.toBeNull();
    });

    it("rotates an idle tab's secret without extending the session", async () => {
        const session = await signIn();
        const aged = setExpiresIn(session, 600);
        makeRotationDue(session);

        const rotation = await send(
            session.cookie,
            "/api/v1/session/rotate",
            "POST",
        );

        expect(rotation.status).toBe(200);
        const body: SessionRotationResponse = await rotation.json();
        // The response says it rotated and carries the new cookie.
        expect(body.rotated).toBe(true);
        const rotated = requireSessionCookie(rotation);
        // Rotating is not activity: the session ends when it would have anyway.
        expect(readSession(session).expires_at).toBe(aged);

        // The UI confirms the new cookie right away, which never renews either.
        expect((await send(rotated, "/api/v1/auth/me")).status).toBe(200);
        const again = await send(rotated, "/api/v1/session/rotate", "POST");
        const againBody: SessionRotationResponse = await again.json();

        // A secret issued less than a minute ago is kept.
        expect(againBody.rotated).toBe(false);
        expect(sessionCookie(again)).toBeNull();

        // No step on the way moved the expiry.
        expect(readSession(session).expires_at).toBe(aged);

        endGracePeriod(session);
        // A copy of the cookie from before the idle rotation signs out both browsers.
        await expectSignedOut(session.cookie);
        await expectSignedOut(rotated);
    });

    it("refuses to rotate an expired session or an access token", async () => {
        const session = await signIn();
        setExpiresIn(session, -1);

        const expired = await send(
            session.cookie,
            "/api/v1/session/rotate",
            "POST",
        );

        // Rotation sits behind the normal access check and cannot revive a session.
        expect(expired.status).toBe(401);

        const { token } = await createAccessToken(apiClient, {
            permissions: ["files:read"],
        });

        const withToken = await fetch(`${baseUrl}/api/v1/session/rotate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        });

        // Tokens have no cookie to rotate.
        expect(withToken.status).toBe(403);
    });

    it("keeps a session's listed id across rotations", async () => {
        const session = await signIn();

        /** The id the session list gives the caller's own session. */
        const ownId = async (cookie: string) => {
            const response = await send(cookie, "/api/v1/sessions");
            const list: BrowserSessionListResponse = await response.json();

            return list.sessions.find((listed) => listed.current)?.id;
        };

        const before = await ownId(session.cookie);
        const rotated = await rotateWithActivity(session);

        // The session list's id names the session, not its current secret, so signing it
        // out from another browser keeps working after it rotated.
        expect(before).toBeDefined();
        expect(await ownId(rotated)).toBe(before);
    });

    // Last, because it changes the password every other test signs in with.
    it("keeps a browser that missed a rotation signed in through a password change", async () => {
        const session = await signIn();
        await rotateWithActivity(session);
        endGracePeriod(session);

        const change = await fetch(`${baseUrl}/api/v1/auth/password`, {
            method: "PUT",
            headers: {
                Cookie: session.cookie,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                current_password: TEST_PASSWORD,
                new_password: "rotation-new-password",
            }),
        });

        expect(change.status).toBe(200);
        // The only session cookie is the new session's: a recovery cookie for the old one,
        // set after it, would replace it and sign the browser out.
        const changed = requireSessionCookie(change);
        expect(sessionId(changed)).not.toBe(session.id);
        onTestFinished(async () => {
            await fetch(`${baseUrl}/api/v1/auth/password`, {
                method: "PUT",
                headers: {
                    Cookie: changed,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    current_password: "rotation-new-password",
                    new_password: TEST_PASSWORD,
                }),
            });
        });
        // The browser stays signed in with the new session.
        expect((await send(changed, "/api/v1/auth/me")).status).toBe(200);
    });
});
