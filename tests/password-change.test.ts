import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    TEST_AGENT_TOKEN,
    VITEST_SERVER_PORT,
    createAccessToken,
    waitForPort,
} from "./test-utils";

const processManager = new ProcessManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

const username = "password-change-user";

const oldPassword = "old-password";

const newPassword = "brand-new-password";

/** Per-file config, so changing its password cannot affect other files in this worker. */
const configPath = join(
    tmpdir(),
    `redoor-vitest-password-change-${VITEST_SERVER_PORT}.toml`,
);

/** Per-file home, so sessions and tokens start empty and stay out of other files' way. */
const serverHome = join(
    tmpdir(),
    `redoor-vitest-password-change-home-${VITEST_SERVER_PORT}`,
);

let serverPid: number;

/** Starts the server on the per-file config and waits until it listens. */
async function startServer(): Promise<void> {
    serverPid = processManager.spawnServer({
        config: configPath,
        home: serverHome,
    });
    await waitForPort(VITEST_SERVER_PORT);
}

/** Signs a fresh client in with the given password. */
async function signIn(password: string): Promise<ApiClient> {
    const api = new ApiClient(baseUrl);
    await api.login(username, password);

    return api;
}

/** The status of a rejected call, so assertions can name the expected HTTP status. */
async function failureStatus(call: Promise<unknown>): Promise<number> {
    try {
        await call;
    } catch (error) {
        if (error instanceof ApiError) {
            return error.status;
        }

        throw error;
    }

    throw new Error("The call was expected to fail");
}

/** `[server].password` as currently written in the config file. */
function storedPassword(): string {
    // Plaintext and PHC strings in these tests need no escapes inside the quotes.
    const match = /^password = "([^"]*)"/m.exec(
        readFileSync(configPath, "utf8"),
    );

    if (match?.[1] === undefined) {
        throw new Error("The config file has no password line");
    }

    return match[1];
}

beforeAll(async () => {
    rmSync(serverHome, { recursive: true, force: true });
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${username}"
password = "${oldPassword}" # kept comment
`,
    );
    await startServer();
});

afterAll(() => processManager.killAll());

describe("password change", () => {
    it("rejects a wrong current password, a short new one and access tokens", async () => {
        const api = await signIn(oldPassword);

        // A stolen session alone must not be enough to take over the account; 403 rather
        // than 401 so the UI does not treat it as an expired session.
        expect(
            await failureStatus(api.changePassword("wrong", newPassword)),
        ).toBe(403);
        // The server enforces the minimum length, not only the form.
        expect(
            await failureStatus(api.changePassword(oldPassword, "short")),
        ).toBe(400);

        const { token } = await createAccessToken(api, {
            permissions: ["files:read", "files:write", "agents:manage"],
        });

        const tokenClient = new ApiClient(baseUrl);
        tokenClient.setAccessToken(token);
        // Even a token with every grantable permission cannot change the login password.
        expect(
            await failureStatus(
                tokenClient.changePassword(oldPassword, newPassword),
            ),
        ).toBe(403);

        // None of the refused attempts touched the file.
        expect(storedPassword()).toBe(oldPassword);
    });

    it("stores an Argon2 hash, signs out other sessions and keeps this one", async () => {
        const changer = await signIn(oldPassword);
        const otherBrowser = await signIn(oldPassword);

        const response = await changer.changePassword(oldPassword, newPassword);
        // The response names the account that owns the re-issued session.
        expect(response.username).toBe(username);

        const stored = storedPassword();
        // The plaintext never reaches the file; an Argon2id PHC string does.
        expect(stored).toMatch(/^\$argon2id\$v=19\$/);
        // Only the value changed: the operator's trailing comment is kept.
        expect(readFileSync(configPath, "utf8")).toContain(
            `password = "${stored}" # kept comment`,
        );

        // The browser that changed the password stays signed in with its new cookie.
        await expect(changer.listAgents()).resolves.toEqual([]);
        // Other browsers signed in with the old password are signed out.
        expect(await failureStatus(otherBrowser.listAgents())).toBe(401);
        // The old password no longer works and the new one does, without a restart.
        expect(await failureStatus(signIn(oldPassword))).toBe(401);
        await expect(signIn(newPassword)).resolves.toBeInstanceOf(ApiClient);

        await processManager.killAndWait(serverPid);
        await startServer();

        // After a restart the server reads the hash from the file and accepts the password.
        await expect(signIn(newPassword)).resolves.toBeInstanceOf(ApiClient);
        // The session issued by the change survives the restart, because the fingerprint
        // computed in memory matches the one derived from the stored hash.
        await expect(changer.listAgents()).resolves.toEqual([]);
    });
});
