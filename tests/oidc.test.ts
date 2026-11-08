import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { $ } from "zx";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

import { ApiClient } from "#ui/api-client";
import type { AccessTokenSecretResponse } from "#bindings/AccessTokenSecretResponse";
import type { CliLoginResponse } from "#bindings/CliLoginResponse";
import type { ErrorResponse } from "#bindings/ErrorResponse";
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
    cliLoginApproval,
    waitForApprovalPrompt,
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
    /** The query of the last authorization request, to check what Redoor asked for. */
    lastAuthorize: URLSearchParams | null = null;
    /**
     * The `auth_time` the next ID tokens carry: now, as after a real authentication, or an
     * hour ago, as a provider that ignored `prompt=login` and reused its session would send.
     */
    authTime: "now" | "old" = "now";
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
        await new Promise<void>((resolve) =>
            this.server?.close(() => resolve()),
        );
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
            this.lastAuthorize = params;
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

            return {
                status: 302,
                headers: { Location: target.href },
                body: "",
            };
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
                auth_time:
                    Math.floor(Date.now() / 1000) -
                    (this.authTime === "old" ? 3600 : 0),
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

/** Seconds until the session a callback created ends, read from its stored session file. */
function storedExpiresIn(callback: Response): number {
    const pair = cookiePair(setCookie(callback, "redoor_session") ?? "");
    // The stable session id names the file; the secret after the dot rotates.
    const sessionId = pair.split("=", 2)[1]?.split(".", 1)[0] ?? "";

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

    return stored.expires_at - Date.now() / 1000;
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
async function signIn(
    returnPath: string,
    sessionLength?: string,
    fresh = false,
): Promise<{
    callback: Response;
    callbackUrl: string;
    stateCookie: string;
}> {
    const session = `${sessionLength ? `&session=${sessionLength}` : ""}${fresh ? "&fresh=true" : ""}`;

    const start = await hop(
        `${baseUrl}/api/v1/auth/oidc/login?redirect=${encodeURIComponent(returnPath)}${session}`,
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
 * key out, which allows every account the provider signs in. `lifetimeDays` caps the session
 * length a sign-in may pick.
 */
async function startServer(
    allowedGroups: string[] | null,
    lifetimeDays = 365,
    passwordLogin = true,
): Promise<void> {
    const allowedGroupsLine =
        allowedGroups === null
            ? ""
            : `allowed_groups = ${JSON.stringify(allowedGroups)}`;

    const config = tempFiles.tempFile({
        suffix: ".toml",
        content: `agent_token = "${TEST_AGENT_TOKEN}"

[server]
${passwordLogin ? `username = "${TEST_USERNAME}"\npassword = "${TEST_PASSWORD}"` : ""}

[server.oidc]
issuer = "${provider.issuer}"
client_id = "${CLIENT_ID}"
client_secret = "${CLIENT_SECRET}"
redirect_url = "${redirectUrl}"
${allowedGroupsLine}
provider_name = "Test ID"
session_lifetime_days = ${lifetimeDays}
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
        const { callback } = await signIn("/transfers?from=oidc", "week");
        // A successful sign-in resumes exactly where the user started.
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/transfers?from=oidc");
        const session = setCookie(callback, "redoor_session");
        // Every session cookie outlasts the longest session; the server enforces the length.
        expect(session).toMatch(
            /^redoor_session=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=31536000$/,
        );
        // The length picked on the login page survives the provider round trip.
        expect(storedExpiresIn(callback)).toBeGreaterThan(604800 - 30);
        expect(storedExpiresIn(callback)).toBeLessThanOrEqual(604800 + 1);
        // The one-shot state cookie is removed once it has been used.
        expect(setCookie(callback, "redoor_oidc_state")).toMatch(/Max-Age=0/);

        const cookie = cookiePair(session ?? "");
        const sessionId = cookie.split("=", 2)[1]?.split(".", 1)[0] ?? "";

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

        // The session records how it was created and names the provider's user, which
        // logs and the UI show; it still grants the server's single account.
        expect(stored).toMatchObject({
            username: "alice",
            method: "oidc",
            length: "week",
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
        const { callback } = await signIn("/", "month");

        const location = new URL(
            callback.headers.get("location") ?? "",
            baseUrl,
        );

        // The browser lands on the login page with an explanation instead of a session.
        expect(location.pathname).toBe("/login");
        expect(location.searchParams.get("oidc_error")).toBe("denied");
        // The chosen length is still selected when the user tries again.
        expect(location.searchParams.get("session")).toBe("month");
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

/** Session cookie pair a finished sign-in set. */
function sessionCookie(callback: Response): string {
    return cookiePair(setCookie(callback, "redoor_session") ?? "");
}

/** Tries to create an access token with a session cookie; returns the response. */
function createToken(cookie: string): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/tokens`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "oidc token",
            permissions: ["files:read"],
            devices: { kind: "all" },
            expires_at: null,
        }),
    });
}

/** Deletes a token created by a test, with the session that created it. */
async function deleteToken(cookie: string, response: Response): Promise<void> {
    const { metadata }: AccessTokenSecretResponse = await response.json();

    onTestFinished(async () => {
        await fetch(`${baseUrl}/api/v1/tokens/${metadata.id}`, {
            method: "DELETE",
            headers: { Cookie: cookie },
        });
    });
}

describe("OIDC sign-in before creating access tokens", () => {
    it("asks the provider to authenticate again and lets that session create tokens", async () => {
        provider.user = {
            sub: "subject-1",
            preferred_username: "alice",
            groups: ["admins"],
        };
        const plain = await signIn("/");

        // An ordinary sign-in keeps the provider's single sign-on ...
        expect(provider.lastAuthorize?.get("prompt")).toBeNull();
        expect(provider.lastAuthorize?.get("max_age")).toBeNull();
        const refused = await createToken(sessionCookie(plain.callback));
        // ... which a copied browser profile could pass too, so it cannot create tokens.
        expect(refused.status).toBe(403);
        const error: ErrorResponse = await refused.json();
        expect(error.code).toBe("fresh_login_required");

        const fresh = await signIn("/settings/tokens", undefined, true);

        // A fresh sign-in asks the provider to check the credentials again.
        expect(provider.lastAuthorize?.get("prompt")).toBe("login");
        expect(provider.lastAuthorize?.get("max_age")).toBe("0");
        // It returns to where the user was creating the token.
        expect(fresh.callback.headers.get("location")).toBe("/settings/tokens");
        const cookie = sessionCookie(fresh.callback);
        const created = await createToken(cookie);
        // The provider's recent auth_time proves the check, so the token is created.
        expect(created.status).toBe(200);
        await deleteToken(cookie, created);
    });

    it("does not trust a provider that reused its old authentication", async () => {
        provider.authTime = "old";
        onTestFinished(() => {
            provider.authTime = "now";
        });
        const fresh = await signIn("/", undefined, true);

        // The sign-in itself still succeeds ...
        expect(fresh.callback.status).toBe(303);
        expect(fresh.callback.headers.get("location")).toBe("/");
        const refused = await createToken(sessionCookie(fresh.callback));
        // ... but an auth_time from before the sign-in started proves nothing, because
        // providers may ignore prompt=login.
        expect(refused.status).toBe(403);
    });
});

describe("OIDC sign-in without allowed_groups", () => {
    beforeAll(async () => {
        // Restarted last, so the restricted tests above keep their own server.
        await processManager.killAndWait(serverPid);
        // A one-week cap, so a longer choice on the login page is visibly clamped.
        await startServer(null, 7);
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
        // Without a choice the session lasts the default hour.
        expect(storedExpiresIn(callback)).toBeGreaterThan(3600 - 30);
        expect(storedExpiresIn(callback)).toBeLessThanOrEqual(3600 + 1);
    });

    it("caps the chosen length at session_lifetime_days", async () => {
        provider.user = {
            sub: "subject-3",
            preferred_username: "carol",
            groups: ["family"],
        };
        const { callback } = await signIn("/", "year");

        // A year is longer than the configured week, so the session gets a week.
        expect(storedExpiresIn(callback)).toBeGreaterThan(604800 - 30);
        expect(storedExpiresIn(callback)).toBeLessThanOrEqual(604800 + 1);
    });
});

describe("CLI login on a server with only OIDC sign-in", () => {
    const binary =
        process.env.REDOOR_TEST_BINARY ??
        join(process.cwd(), "target/debug/redoor");

    beforeAll(async () => {
        // No password login at all, so the CLI has no password it could ever use.
        await processManager.killAndWait(serverPid);
        await startServer(["admins"], 365, false);
    });

    it("logs the CLI in through the browser", async () => {
        provider.user = {
            sub: "subject-1",
            preferred_username: "alice",
            groups: ["admins"],
        };
        const home = tempFiles.tempDirectory();

        const cli = $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: "oidc-cli",
                REDOOR_REMOTE_SERVER: "",
                REDOOR_REMOTE_TOKEN: "",
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote login ${baseUrl}`;

        onTestFinished(async () => {
            try {
                await cli.kill();
            } catch {
                // Already exited.
            }
        });
        const prompt = await waitForApprovalPrompt(cli);
        const fresh = await signIn(`/cli-login/${prompt.id}`, undefined, true);

        // The provider sign-in returns to the approval page.
        expect(fresh.callback.headers.get("location")).toBe(
            `/cli-login/${prompt.id}`,
        );
        const cookie = sessionCookie(fresh.callback);
        const headers = { Cookie: cookie, "Content-Type": "application/json" };

        const request: CliLoginResponse = await (
            await fetch(`${baseUrl}/api/v1/cli-logins/${prompt.id}`, {
                headers,
            })
        ).json();

        const approved = await fetch(
            `${baseUrl}/api/v1/cli-logins/${prompt.id}/approve`,
            {
                method: "POST",
                headers,
                body: JSON.stringify(
                    cliLoginApproval(prompt.userCode, request.token),
                ),
            },
        );

        // A fresh OIDC session approves like a password session does.
        expect(approved.status).toBe(200);
        const result = await cli;
        // The CLI got its token without any password.
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toContain("Logged in to");
        expect(
            readFileSync(
                join(home, ".local/share/oidc-cli/remote-credentials.json"),
                "utf8",
            ),
        ).toContain("redoor_at_");
    });
});
