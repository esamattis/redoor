import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import { join } from "node:path";

import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_APP_NAME,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

const processManager = new ProcessManager();
const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

beforeAll(async () => {
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processManager.spawnServer({});
    await waitForPort(VITEST_SERVER_PORT);
});

afterAll(() => {
    processManager.killAll();
});

/** Extracts the opaque identifier while keeping cookie attributes out of request headers. */
function sessionIdFromCookie(cookie: string): string {
    const value = cookie.split("=", 2)[1];
    if (!value) {
        throw new Error("Session cookie did not contain an identifier");
    }
    return value;
}

describe("HTTP authentication", () => {
    it("protects REST APIs while leaving the login endpoint public", async () => {
        const protectedResponse = await fetch(`${baseUrl}/api/v1/agents`);
        // Missing login state must be distinguishable from remote filesystem permission failures.
        expect(protectedResponse.status).toBe(401);
        // Clients rely on the standard error envelope for actionable failures.
        expect(await protectedResponse.json()).toEqual({
            error: "Authentication required",
        });

        const invalidLogin = await fetch(`${baseUrl}/api/v1/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: TEST_USERNAME,
                password: "incorrect",
            }),
        });
        // Invalid credentials must not create an authenticated browser session.
        expect(invalidLogin.status).toBe(401);
        // Login failures should not expose which credential was incorrect.
        expect(await invalidLogin.json()).toEqual({
            error: "Invalid username or password",
        });
    });

    it("persists login state and removes it during logout", async () => {
        const api = new ApiClient(baseUrl);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        const cookie = api.getAuthHeaders().Cookie;
        // Node clients must retain the same opaque cookie a browser receives automatically.
        expect(cookie).toMatch(/^redoor_session=[0-9a-f-]{36}$/);
        if (!cookie) {
            throw new Error("Login did not return a session cookie");
        }

        const sessionId = sessionIdFromCookie(cookie);
        const sessionPath = join(
            TEST_SERVER_HOME,
            ".local/share",
            TEST_APP_NAME,
            "sessions",
            `session_${sessionId}.json`,
        );
        // A successful login must have one durable server-side file as its source of truth.
        expect(existsSync(sessionPath)).toBe(true);

        const agents = await api.listAgents();
        // The persisted cookie must authorize protected APIs even when no agents are connected.
        expect(agents).toEqual([]);

        const serverInfo = await api.getServerInfo();
        // The home page must identify which isolated application namespace is active.
        expect(serverInfo.app_name).toBe(TEST_APP_NAME);
        // The authenticated home page must receive the real secret for its copyable agent config.
        expect(serverInfo.agent_token).toBe(TEST_AGENT_TOKEN);
        // Home UI needs an absolute config path so operators can find the file they edited.
        expect(serverInfo.config_path.startsWith("/")).toBe(true);
        expect(serverInfo.config_path.endsWith(".toml")).toBe(true);
        // Home UI needs an absolute binary path so operators can verify upgrades.
        expect(serverInfo.exe_path.startsWith("/")).toBe(true);
        // Test servers always pin username/password in TOML rather than PAM.
        expect(serverInfo.auth_mode).toBe("toml");
        // When routing discovers an external address, it must not return an empty value.
        expect(
            serverInfo.external_ip === null ||
                serverInfo.external_ip.length > 0,
        ).toBe(true);
        // Package version is baked at compile time for the home page identity card.
        expect(serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
        // Git revision comes from build.rs so operators can map a binary to source.
        expect(serverInfo.git_rev.length).toBeGreaterThan(0);
        expect([true, false]).toContain(serverInfo.git_dirty);
        // Version dirty means HEAD was not tagged v{version} at compile time.
        expect([true, false]).toContain(serverInfo.version_dirty);
        // Integration tests run against a debug cargo profile binary.
        expect(serverInfo.build_mode).toBe("debug");
        // Build date is UTC ISO-8601 so operators can tell rebuilds apart.
        expect(serverInfo.build_date).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
        );

        const tamperedResponse = await fetch(`${baseUrl}/api/v1/agents`, {
            headers: {
                Cookie: "redoor_session=00000000-0000-4000-8000-000000000000",
            },
        });
        // Guessing a syntactically valid identifier without its session file must not authenticate.
        expect(tamperedResponse.status).toBe(401);

        const logout = await api.logout();
        // Logout confirms completion only after deleting the durable session.
        expect(logout).toEqual({ logged_out: true });
        // The session file must be gone before the response is considered successful.
        expect(existsSync(sessionPath)).toBe(false);
    });
});
