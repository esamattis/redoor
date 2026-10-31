import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TEST_AGENT_TOKEN,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    TempFileManager,
    getAvailablePort,
    VITEST_SERVER_PORT,
    waitForLogMessage,
    waitForPort,
} from "./test-utils";

const CLIENT_ID = "redoor-test";

const CLIENT_SECRET = "oidc-test-secret";

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

const redirectUrl = `${baseUrl}/api/v1/auth/oidc/callback`;

const serverHome = `${TEST_SERVER_HOME}-oidc`;

/** Who the mock provider signs in on the next authorization request. */
type MockUser = { sub: string; preferred_username: string; groups: string[] };

/** One authorization request waiting for its code to be redeemed. */
type IssuedCode = {
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
    user: MockUser;
};

/**
 * Minimal OpenID provider: discovery, an authorization endpoint that signs the configured
 * user in immediately, and a token endpoint that enforces client authentication and PKCE
 * the way a real provider would.
 */
class MockProvider {
    readonly codes = new Map<string, IssuedCode>();
    user: MockUser = {
        sub: "subject-1",
        preferred_username: "alice",
        groups: ["admins"],
    };
    private server: Server | null = null;
    issuer = "";

    /** Starts listening on an ephemeral loopback port. */
    async start(): Promise<void> {
        const server = createServer((request, response) => {
            this.handle(request.method ?? "GET", request.url ?? "/", request)
                .then((reply) => {
                    response.writeHead(reply.status, reply.headers);
                    response.end(reply.body);
                })
                .catch(() => {
                    response.writeHead(500);
                    response.end();
                });
        });

        const port = await getAvailablePort();

        await new Promise<void>((resolve) =>
            server.listen(port, "127.0.0.1", resolve),
        );
        this.server = server;
        this.issuer = `http://127.0.0.1:${port}`;
    }

    /** Stops the provider so the test process can exit. */
    async stop(): Promise<void> {
        await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }

    /** Routes one request to the matching endpoint. */
    private async handle(
        method: string,
        rawUrl: string,
        body: IncomingMessage,
    ): Promise<MockReply> {
        const url = new URL(rawUrl, this.issuer);

        if (url.pathname === "/.well-known/openid-configuration") {
            return json(200, {
                issuer: this.issuer,
                authorization_endpoint: `${this.issuer}/authorize`,
                token_endpoint: `${this.issuer}/token`,
                token_endpoint_auth_methods_supported: [
                    "client_secret_basic",
                    "client_secret_post",
                ],
            });
        }

        if (url.pathname === "/authorize" && method === "GET") {
            const params = url.searchParams;
            const code = randomUUID();
            this.codes.set(code, {
                nonce: params.get("nonce") ?? "",
                codeChallenge: params.get("code_challenge") ?? "",
                redirectUri: params.get("redirect_uri") ?? "",
                user: this.user,
            });
            const target = new URL(params.get("redirect_uri") ?? "");
            target.searchParams.set("code", code);
            target.searchParams.set("state", params.get("state") ?? "");

            return { status: 302, headers: { Location: target.href }, body: "" };
        }

        if (url.pathname === "/token" && method === "POST") {
            const chunks: Buffer[] = [];

            for await (const chunk of body) {
                chunks.push(chunk);
            }

            const form = new URLSearchParams(Buffer.concat(chunks).toString());
            const expectedAuth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;

            if (body.headers["authorization"] !== expectedAuth) {
                return json(401, { error: "invalid_client" });
            }

            const issued = this.codes.get(form.get("code") ?? "");
            this.codes.delete(form.get("code") ?? "");

            const challenge = createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url");

            if (
                !issued ||
                issued.codeChallenge !== challenge ||
                issued.redirectUri !== form.get("redirect_uri")
            ) {
                return json(400, { error: "invalid_grant" });
            }

            const claims = {
                iss: this.issuer,
                aud: CLIENT_ID,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: issued.nonce,
                ...issued.user,
            };

            const idToken = [
                Buffer.from('{"alg":"none"}').toString("base64url"),
                Buffer.from(JSON.stringify(claims)).toString("base64url"),
                "signature",
            ].join(".");

            return json(200, {
                access_token: "access",
                token_type: "Bearer",
                id_token: idToken,
            });
        }

        return json(404, { error: "not_found" });
    }
}

/** One HTTP answer from the mock provider. */
type MockReply = {
    status: number;
    headers: Record<string, string>;
    body: string;
};

/** JSON documents the mock provider answers with. */
type JsonBody = Record<string, string | string[]>;

/** Builds a JSON reply for the mock provider. */
function json(status: number, value: JsonBody): MockReply {
    return {
        status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
    };
}

/** Returns the `name=value` pair of the named cookie from a response, if set. */
function setCookie(response: Response, name: string): string | null {
    const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${name}=`));

    return cookie ?? null;
}

/** Reduces a `Set-Cookie` value to the `name=value` pair a browser sends back. */
function cookiePair(cookie: string): string {
    return cookie.split(";", 1)[0] ?? "";
}

/** Requests a URL without following redirects, the way each browser hop is checked. */
function hop(url: string, cookie?: string): Promise<Response> {
    return fetch(url, {
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
    });
}

/**
 * Walks the browser through sign-in: start, provider, callback. Returns the callback
 * response and the state cookie the browser held.
 */
async function signIn(returnPath: string): Promise<{
    callback: Response;
    callbackUrl: string;
    stateCookie: string;
}> {
    const start = await hop(
        `${baseUrl}/api/v1/auth/oidc/login?redirect=${encodeURIComponent(returnPath)}`,
    );

    // Starting sign-in is a redirect to the provider, never a page of its own.
    expect(start.status).toBe(303);
    const state = setCookie(start, "redoor_oidc_state");
    // The browser must be bound to the attempt it started.
    expect(state).toMatch(/HttpOnly; SameSite=Lax; Path=\/api\/v1\/auth\/oidc/);
    const stateCookie = cookiePair(state ?? "");
    const authorize = await hop(start.headers.get("location") ?? "");
    const callbackUrl = authorize.headers.get("location") ?? "";
    const callback = await hop(callbackUrl, stateCookie);

    return { callback, callbackUrl, stateCookie };
}

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

const provider = new MockProvider();

let serverPid = 0;

/**
 * Starts the server with OIDC against the mock provider. `allowedGroups` of null leaves the
 * key out, which allows every account the provider signs in.
 */
async function startServer(allowedGroups: string[] | null): Promise<void> {
    const allowedGroupsLine =
        allowedGroups === null
            ? ""
            : `allowed_groups = ${JSON.stringify(allowedGroups)}`;

    const config = tempFiles.tempFile({
        suffix: ".toml",
        content: `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[server.oidc]
issuer = "${provider.issuer}"
client_id = "${CLIENT_ID}"
client_secret = "${CLIENT_SECRET}"
redirect_url = "${redirectUrl}"
${allowedGroupsLine}
provider_name = "Test ID"
session_lifetime_days = 365
`,
    });

    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    serverPid = processManager.spawnServer({ config, home: serverHome });
    await waitForPort(VITEST_SERVER_PORT);
}

beforeAll(async () => {
    await provider.start();
    rmSync(serverHome, { recursive: true, force: true });
    await startServer(["admins"]);
});

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
    await provider.stop();
});

describe("OIDC sign-in", () => {
    it("advertises the provider to the public login page", async () => {
        const methods = await new ApiClient(baseUrl).getLoginMethods();
        // The login page leads with the provider only when the server offers it.
        expect(methods).toEqual({ oidc: { provider_name: "Test ID" } });
    });

    it("signs an allowed user in and returns to the original page", async () => {
        provider.user = {
            sub: "subject-1",
            preferred_username: "alice",
            groups: ["family", "admins"],
        };
        const { callback } = await signIn("/transfers?from=oidc");
        // A successful sign-in resumes exactly where the user started.
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/transfers?from=oidc");
        const session = setCookie(callback, "redoor_session");
        // The OIDC session cookie lives as long as the configured sliding lifetime.
        expect(session).toMatch(
            /^redoor_session=[0-9a-f-]{36}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=31536000$/,
        );
        // The one-shot state cookie is removed once it has been used.
        expect(setCookie(callback, "redoor_oidc_state")).toMatch(/Max-Age=0/);

        const cookie = cookiePair(session ?? "");
        const sessionId = cookie.split("=", 2)[1] ?? "";

        const stored = JSON.parse(
            readFileSync(
                join(
                    serverHome,
                    ".local/share",
                    TEST_APP_NAME,
                    "sessions",
                    `session_${sessionId}.json`,
                ),
                "utf8",
            ),
        );

        // The session belongs to the server's single account and records how it was created.
        expect(stored).toMatchObject({
            username: TEST_USERNAME,
            method: "oidc",
        });

        const agents = await fetch(`${baseUrl}/api/v1/agents`, {
            headers: { Cookie: cookie },
        });

        // The new session authorizes protected APIs like a password session does.
        expect(agents.status).toBe(200);

        const logout = await fetch(`${baseUrl}/api/v1/logout`, {
            method: "POST",
            headers: { Cookie: cookie },
        });

        // Logging out works the same for OIDC sessions.
        expect(logout.status).toBe(200);

        const afterLogout = await fetch(`${baseUrl}/api/v1/agents`, {
            headers: { Cookie: cookie },
        });

        // A logged-out OIDC session can no longer be used.
        expect(afterLogout.status).toBe(401);
    });

    it("refuses users outside the allowed groups", async () => {
        provider.user = {
            sub: "subject-2",
            preferred_username: "mallory",
            groups: ["family"],
        };
        const { callback } = await signIn("/");

        const location = new URL(
            callback.headers.get("location") ?? "",
            baseUrl,
        );

        // The browser lands on the login page with an explanation instead of a session.
        expect(location.pathname).toBe("/login");
        expect(location.searchParams.get("oidc_error")).toBe("denied");
        // No session may be issued to a user the server itself does not allow.
        expect(setCookie(callback, "redoor_session")).toBeNull();
    });

    it("refuses callbacks that are replayed or opened in another browser", async () => {
        provider.user = {
            sub: "subject-1",
            preferred_username: "alice",
            groups: ["admins"],
        };
        const start = await hop(`${baseUrl}/api/v1/auth/oidc/login`);
        const authorize = await hop(start.headers.get("location") ?? "");
        const callbackUrl = authorize.headers.get("location") ?? "";
        const foreign = await hop(callbackUrl);
        // A callback without the state cookie cannot complete someone else's sign-in.
        expect(foreign.headers.get("location")).toContain("oidc_error=expired");
        expect(setCookie(foreign, "redoor_session")).toBeNull();

        const first = await signIn("/");
        // The genuine browser completes its own attempt.
        expect(setCookie(first.callback, "redoor_session")).not.toBeNull();
        const replay = await hop(first.callbackUrl, first.stateCookie);
        // Each attempt completes once; replaying the callback yields no second session.
        expect(replay.headers.get("location")).toContain("oidc_error=expired");
        expect(setCookie(replay, "redoor_session")).toBeNull();
    });

    it("keeps every protected endpoint closed without a session", async () => {
        const start = await hop(`${baseUrl}/api/v1/auth/oidc/login`);

        const stateCookie = cookiePair(
            setCookie(start, "redoor_oidc_state") ?? "",
        );

        const attempts = [
            fetch(`${baseUrl}/api/v1/agents`),
            fetch(`${baseUrl}/api/v1/server`),
            fetch(`${baseUrl}/api/v1/ui/ws`),
            fetch(`${baseUrl}/api/v1/tokens`),
            // An in-progress sign-in's state value is not a session.
            fetch(`${baseUrl}/api/v1/agents`, {
                headers: { Cookie: stateCookie },
            }),
            fetch(`${baseUrl}/api/v1/agents`, {
                headers: {
                    Cookie: `redoor_session=${stateCookie.split("=", 2)[1]}`,
                },
            }),
        ];

        for (const response of await Promise.all(attempts)) {
            // Configuring OIDC must not open any REST or WebSocket route.
            expect(response.status).toBe(401);
        }
    });

    it("keeps password login available as a fallback", async () => {
        const api = new ApiClient(baseUrl);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        // The password form still produces a working session alongside OIDC.
        expect(await api.listAgents()).toEqual([]);
        await api.logout();
    });

    it("leaves agent connections unaffected", async () => {
        const serverProcess = processManager.getProcess(serverPid);

        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const registered = waitForLogMessage(
            serverProcess,
            /Agent registered:.*agent_name=oidc-agent/,
            10000,
        );

        processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/agent/ws`,
            name: "oidc-agent",
            cwd: serverHome,
            home: serverHome,
        });
        // Agents still authenticate with the agent token, untouched by browser sign-in.
        await registered;
    });
});

describe("OIDC sign-in without allowed_groups", () => {
    beforeAll(async () => {
        // Restarted last, so the restricted tests above keep their own server.
        await processManager.killAndWait(serverPid);
        await startServer(null);
    });

    it("signs in a user of any group", async () => {
        provider.user = {
            sub: "subject-3",
            preferred_username: "carol",
            groups: ["family"],
        };
        const { callback } = await signIn("/");

        // Without a restriction a group outside any list still gets a session.
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/");
        expect(setCookie(callback, "redoor_session")).not.toBeNull();
    });
});
