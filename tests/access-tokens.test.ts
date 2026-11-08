import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";

import { ApiClient, type Agent } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import { existsSync } from "node:fs";

import type { AccessTokenSecretResponse } from "#bindings/AccessTokenSecretResponse";
import type { CurrentUserResponse } from "#bindings/CurrentUserResponse";
import type { ErrorResponse } from "#bindings/ErrorResponse";
import {
    ProcessManager,
    TempFileManager,
    VITEST_SERVER_PORT,
    ageFreshLogin,
    browserFetch,
    createAccessToken,
    signInBrowser,
    startServerAndAgent,
    waitForPort,
    waitForValue,
    withFreshSession,
} from "./test-utils";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

let api: ApiClient;

let agent: Agent;

let serverPid: number;

/** Builds a client that authenticates only with the given access token. */
function asToken(token: string): ApiClient {
    const client = new ApiClient(baseUrl);
    client.setAccessToken(token);

    return client;
}

/** Resolves to the HTTP status of an API call, so assertions can compare statuses directly. */
async function statusOf(call: Promise<unknown>): Promise<number> {
    try {
        await call;

        return 200;
    } catch (error) {
        if (error instanceof ApiError) {
            return error.status;
        }

        throw error;
    }
}

/** Starts a trivial command and reports the status, consuming the stream to completion. */
async function execStatus(token: string): Promise<number> {
    const response = await fetch(
        `${baseUrl}/api/v1/agents/${encodeURIComponent(agent.id)}/exec`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ argv: ["true"], cwd: null, env: {} }),
        },
    );

    await response.arrayBuffer();

    return response.status;
}

beforeAll(async () => {
    const setup = await startServerAndAgent({
        processManager,
        agentName: "access-token-agent",
        agentCwd: tempFiles.tempDirectory(),
    });

    api = setup.apiClient;
    agent = setup.testAgent;
    serverPid = setup.serverPid;
}, 30_000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** A token creation body for the fresh sign-in tests. */
const freshTokenRequest = {
    name: "fresh sign-in",
    permissions: ["files:read"],
    devices: { kind: "all" },
    expires_at: null,
};

describe("Fresh sign-in for token secrets", () => {
    it("creates and rotates right after a sign-in and refuses both a minute later", async () => {
        const session = await signInBrowser(baseUrl);

        const me: CurrentUserResponse = await (
            await browserFetch(baseUrl, session.cookie, {
                method: "GET",
                path: "/api/v1/auth/me",
            })
        ).json();

        // A password was just checked, so the UI learns how long it may still create tokens.
        expect(me.fresh_login_seconds_left).toBeGreaterThan(0);
        expect(me.fresh_login_seconds_left).toBeLessThanOrEqual(60);

        const created = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: "/api/v1/tokens",
            body: freshTokenRequest,
        });

        // A fresh session creates the token and gets its secret.
        expect(created.status).toBe(200);
        const token: AccessTokenSecretResponse = await created.json();
        onTestFinished(async () => {
            await api.deleteAccessToken(token.metadata.id);
        });

        // ... and may rotate it.
        expect(
            (
                await browserFetch(baseUrl, session.cookie, {
                    method: "POST",
                    path: `/api/v1/tokens/${token.metadata.id}/rotate`,
                })
            ).status,
        ).toBe(200);

        ageFreshLogin(session, 61);

        const stale: CurrentUserResponse = await (
            await browserFetch(baseUrl, session.cookie, {
                method: "GET",
                path: "/api/v1/auth/me",
            })
        ).json();

        // A minute after the sign-in the UI is told to sign in again first.
        expect(stale.fresh_login_seconds_left).toBe(0);

        for (const [method, path, body] of [
            ["POST", "/api/v1/tokens", freshTokenRequest],
            ["POST", `/api/v1/tokens/${token.metadata.id}/rotate`, undefined],
        ] as const) {
            const refused = await browserFetch(baseUrl, session.cookie, {
                method,
                path,
                body,
            });

            const error: ErrorResponse = await refused.json();

            // A copied browser profile holds such an older session, so it cannot get a
            // secret; the code tells the UI to sign in rather than to give up.
            expect(refused.status).toBe(403);
            expect(error.code).toBe("fresh_login_required");
        }

        // Editing hands out no secret, so the older session still may.
        expect(
            (
                await browserFetch(baseUrl, session.cookie, {
                    method: "PUT",
                    path: `/api/v1/tokens/${token.metadata.id}`,
                    body: {
                        name: "renamed",
                        permissions: ["files:read"],
                        devices: { kind: "all" },
                    },
                })
            ).status,
        ).toBe(200);
    });

    it("replaces the session of a browser that signs in again", async () => {
        const first = await signInBrowser(baseUrl);

        // The first session exists before the browser signs in again.
        expect(existsSync(first.file)).toBe(true);

        const second = await signInBrowser(baseUrl, { cookie: first.cookie });

        // The old session is gone, so fresh sign-ins leave no stray sessions behind ...
        expect(existsSync(first.file)).toBe(false);
        expect(
            (
                await browserFetch(baseUrl, first.cookie, {
                    method: "GET",
                    path: "/api/v1/auth/me",
                })
            ).status,
        ).toBe(401);
        // ... and the browser continues with the new one.
        expect(existsSync(second.file)).toBe(true);
        expect(
            (
                await browserFetch(baseUrl, second.cookie, {
                    method: "GET",
                    path: "/api/v1/auth/me",
                })
            ).status,
        ).toBe(200);
    });
});

describe("Access token REST API", () => {
    it("returns the secret once and never lists it", async () => {
        const created = await createAccessToken(api, {
            name: "listing test",
            permissions: ["files:read"],
        });

        // The prefix makes leaked tokens recognizable to secret scanners.
        expect(created.token).toMatch(/^redoor_at_[0-9a-f]{32}_/);
        // The metadata reflects the requested policy.
        expect(created.metadata).toMatchObject({
            name: "listing test",
            permissions: ["files:read"],
            devices: { kind: "all" },
            expires_at: null,
            last_used_at: null,
        });

        const response = await fetch(`${baseUrl}/api/v1/tokens`, {
            headers: api.getAuthHeaders(),
        });

        const body = await response.text();
        // Token responses must not be cached by browsers or proxies.
        expect(response.headers.get("cache-control")).toContain("no-store");
        // Listings contain the token but never its secret or verifier.
        expect(body).toContain(created.metadata.id);
        expect(body).not.toContain(created.token);
        expect(body).not.toContain("verifier");
    });

    it("rejects invalid policies", async () => {
        const invalid = [
            {
                name: " ",
                permissions: ["files:read" as const],
                devices: { kind: "all" as const },
                expires_at: null,
            },
            {
                name: "no permissions",
                permissions: [],
                devices: { kind: "all" as const },
                expires_at: null,
            },
            {
                name: "empty scope",
                permissions: ["files:read" as const],
                devices: { kind: "only" as const, device_ids: [] },
                expires_at: null,
            },
            {
                name: "unknown device",
                permissions: ["files:read" as const],
                devices: {
                    kind: "only" as const,
                    device_ids: ["no-such-device"],
                },
                expires_at: null,
            },
            {
                name: "past expiry",
                permissions: ["files:read" as const],
                devices: { kind: "all" as const },
                expires_at: new Date(Date.now() - 60_000).toISOString(),
            },
        ];

        await withFreshSession(baseUrl, async (fresh) => {
            for (const request of invalid) {
                // Each invalid policy is refused instead of creating an unusable token.
                expect(await statusOf(fresh.createAccessToken(request))).toBe(
                    400,
                );
            }
        });

        const unknownPermission = await fetch(`${baseUrl}/api/v1/tokens`, {
            method: "POST",
            headers: {
                ...api.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                name: "unknown permission",
                permissions: ["devices:read"],
                devices: { kind: "all" },
                expires_at: null,
            }),
        });

        // Unknown permission names fail request decoding rather than granting nothing.
        expect(unknownPermission.status).toBe(422);
        // None of the rejected requests left a token behind.
        expect(
            (await api.listAccessTokens()).tokens.some((token) =>
                [
                    "no permissions",
                    "empty scope",
                    "unknown device",
                    "past expiry",
                    "unknown permission",
                ].includes(token.name),
            ),
        ).toBe(false);
    });

    it("applies updated permissions to the same bearer at once", async () => {
        const created = await createAccessToken(api, {
            name: "editable",
            permissions: ["files:read", "commands:execute"],
        });

        // The original policy allows execution.
        expect(await execStatus(created.token)).toBe(200);

        const updated = await api.updateAccessToken(created.metadata.id, {
            name: "edited",
            permissions: ["files:read"],
            devices: { kind: "only", device_ids: [agent.id] },
        });

        // The update keeps the token's identity and returns the new policy.
        expect(updated).toMatchObject({
            id: created.metadata.id,
            name: "edited",
            permissions: ["files:read"],
            devices: { kind: "only", device_ids: [agent.id] },
        });
        // The next request with the unchanged secret already lacks the removed permission.
        expect(await execStatus(created.token)).toBe(403);
        // Permissions that remain still work.
        expect(
            await statusOf(asToken(created.token).getCurrentAccessToken()),
        ).toBe(200);
    });

    it("rotates the secret but keeps the id", async () => {
        const created = await createAccessToken(api, {
            name: "rotating",
            permissions: ["files:read"],
        });

        const rotated = await withFreshSession(baseUrl, (fresh) =>
            fresh.rotateAccessToken(created.metadata.id),
        );

        // Rotation keeps the id, so MCP operations owned by the token survive it.
        expect(rotated.metadata.id).toBe(created.metadata.id);
        expect(rotated.token).not.toBe(created.token);
        // The old secret stops working immediately.
        expect(
            await statusOf(asToken(created.token).getCurrentAccessToken()),
        ).toBe(401);
        // The new secret works.
        expect((await asToken(rotated.token).getCurrentAccessToken()).id).toBe(
            created.metadata.id,
        );
    });

    it("rejects expired tokens and refuses to revive them", async () => {
        const created = await createAccessToken(api, {
            name: "expiring",
            permissions: ["files:read"],
            expiresAt: new Date(Date.now() + 1_500).toISOString(),
        });

        const client = asToken(created.token);
        // The token works before it expires.
        expect(await statusOf(client.getCurrentAccessToken())).toBe(200);
        // Expiry is checked on every request, so the token is rejected once it passes.
        await waitForValue({
            description: "expired token rejection",
            timeoutMs: 10_000,
            predicate: async () =>
                (await statusOf(client.getCurrentAccessToken())) === 401
                    ? true
                    : undefined,
        });
        // Rotating or editing an expired token would revive a dead credential.
        expect(
            await withFreshSession(baseUrl, (fresh) =>
                statusOf(fresh.rotateAccessToken(created.metadata.id)),
            ),
        ).toBe(409);
        expect(
            await statusOf(
                api.updateAccessToken(created.metadata.id, {
                    name: "revived",
                    permissions: ["files:read"],
                    devices: { kind: "all" },
                }),
            ),
        ).toBe(409);
        // Expired tokens stay listed so users can see why a client stopped working.
        expect(
            (await api.listAccessTokens()).tokens.some(
                (token) => token.id === created.metadata.id,
            ),
        ).toBe(true);
    });

    it("revokes on delete", async () => {
        const created = await createAccessToken(api, {
            name: "deleted",
            permissions: ["files:read"],
        });

        await api.deleteAccessToken(created.metadata.id);
        // Deletion takes effect on the very next request.
        expect(
            await statusOf(asToken(created.token).getCurrentAccessToken()),
        ).toBe(401);
        // Unknown and malformed ids are distinct client errors.
        expect(await statusOf(api.deleteAccessToken(created.metadata.id))).toBe(
            404,
        );
        expect(await statusOf(api.deleteAccessToken("not-a-uuid"))).toBe(400);
    });

    it("rejects cross-site token mutations", async () => {
        const body = JSON.stringify({
            name: "csrf",
            permissions: ["files:read"],
            devices: { kind: "all" },
            expires_at: null,
        });

        // A session that may create tokens, so only the origin check can refuse them.
        const session = await signInBrowser(baseUrl);

        for (const [name, value] of [
            ["Sec-Fetch-Site", "cross-site"],
            ["Origin", "https://attacker.example"],
        ] as const) {
            const headers = new Headers({ Cookie: session.cookie });
            headers.set(name, value);
            headers.set("Content-Type", "application/json");

            const response = await fetch(`${baseUrl}/api/v1/tokens`, {
                method: "POST",
                headers,
                body,
            });

            // Another site cannot use the browser session cookie to mint tokens.
            expect(response.status).toBe(403);
        }
    });

    it("never lets a token manage tokens", async () => {
        const created = await createAccessToken(api, {
            name: "no escalation",
            permissions: [
                "files:read",
                "files:write",
                "files:delete",
                "commands:execute",
                "agents:manage",
            ],
        });

        const client = asToken(created.token);
        // Even a full-permission token cannot list tokens.
        expect(await statusOf(client.listAccessTokens())).toBe(403);
        // Nor mint a broader one.
        expect(
            await statusOf(
                client.createAccessToken({
                    name: "escalated",
                    permissions: ["files:read"],
                    devices: { kind: "all" },
                    expires_at: null,
                }),
            ),
        ).toBe(403);
        // Nor rotate or delete other tokens by id.
        expect(
            await statusOf(client.rotateAccessToken(created.metadata.id)),
        ).toBe(403);
    });

    it("lets a token read and delete itself through /current", async () => {
        const created = await createAccessToken(api, {
            name: "self",
            permissions: ["files:read", "agents:manage"],
        });

        const client = asToken(created.token);
        const current = await client.getCurrentAccessToken();

        // A token learns its own policy, which CLI status relies on.
        expect(current).toMatchObject({
            id: created.metadata.id,
            permissions: ["files:read", "agents:manage"],
        });
        // The request that just authenticated is recorded as a use.
        expect(current.last_used_at).not.toBeNull();
        // A browser session has no "current token".
        expect(await statusOf(api.getCurrentAccessToken())).toBe(400);

        const deleted = await fetch(`${baseUrl}/api/v1/tokens/current`, {
            method: "DELETE",
            headers: client.getAuthHeaders(),
        });

        // Self-deletion is what CLI logout uses.
        expect(deleted.status).toBe(200);
        expect(await statusOf(client.getCurrentAccessToken())).toBe(401);
    });

    it("keeps tokens across a server restart", async () => {
        const created = await createAccessToken(api, {
            name: "durable",
            permissions: ["files:read"],
        });

        await processManager.killAndWait(serverPid);
        serverPid = processManager.spawnServer({});
        await waitForPort(VITEST_SERVER_PORT);

        // The token store is persisted, so existing clients keep working after a restart.
        expect(
            (await asToken(created.token).getCurrentAccessToken()).name,
        ).toBe("durable");
    });
});
