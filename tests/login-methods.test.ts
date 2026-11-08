import {
    mkdirSync,
    rmSync,
    writeFileSync,
    existsSync,
    readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";

import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    TEST_AGENT_TOKEN,
    TEST_APP_NAME,
    VITEST_SERVER_PORT,
    createAccessToken,
    waitForAgentReady,
    waitForPort,
    waitForValue,
} from "./test-utils";

const processManager = new ProcessManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

/** Per-file config, so editing its users cannot affect other files in this worker. */
const configPath = join(
    tmpdir(),
    `redoor-vitest-login-methods-${VITEST_SERVER_PORT}.toml`,
);

/** Per-file home, so sessions, user state and the vault start empty. */
const serverHome = join(
    tmpdir(),
    `redoor-vitest-login-methods-home-${VITEST_SERVER_PORT}`,
);

/** The server's data directory inside the per-file home. */
const dataDir = join(serverHome, ".local/share", TEST_APP_NAME);

let serverPid: number;

/** Writes a config with one `[[server.users]]` entry per user. */
function writeUsers(users: Record<string, string>): void {
    const entries = Object.entries(users)
        .map(
            ([name, password]) => `[[server.users]]
name = "${name}"
password = "${password}"
`,
        )
        .join("\n");

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

${entries}`,
    );
}

/** Starts the server on the per-file config and waits until it listens. */
async function startServer(): Promise<void> {
    serverPid = processManager.spawnServer({
        config: configPath,
        home: serverHome,
    });
    await waitForPort(VITEST_SERVER_PORT);
}

/** Stops the server, writes `users` and starts it again. */
async function restartWith(users: Record<string, string>): Promise<void> {
    await processManager.killAndWait(serverPid);
    writeUsers(users);
    await startServer();
}

/** Signs a fresh client in. */
async function signIn(name: string, password: string): Promise<ApiClient> {
    const api = new ApiClient(baseUrl);
    await api.login(name, password);

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

const users = {
    alice: "alice-password",
    bob: "bob-password",
};

beforeAll(async () => {
    rmSync(serverHome, { recursive: true, force: true });
    writeUsers(users);
    await startServer();
});

afterAll(() => processManager.killAll());

describe("login methods", () => {
    it("signs in each listed user and rejects wrong names and passwords", async () => {
        for (const [name, password] of Object.entries(users)) {
            const api = await signIn(name, password);
            // Each user signs in with their own password and is reported as themselves.
            await expect(api.getCurrentUser()).resolves.toEqual({
                name,
                method: "password",
                token_id: null,
                // Browser sessions report when they end without activity.
                session: {
                    expires_at: expect.any(String),
                    expires_in_seconds: expect.any(Number),
                },
                // ... and how long a password sign-in may still create tokens.
                fresh_login_seconds_left: expect.any(Number),
            });
        }

        // Another user's password does not sign in.
        expect(await failureStatus(signIn("alice", users.bob))).toBe(401);
        // An unknown name fails exactly like a wrong password.
        expect(await failureStatus(signIn("carol", users.alice))).toBe(401);
    });

    it("reports a token's name and id from /auth/me", async () => {
        const api = await signIn("alice", users.alice);

        const { token, metadata } = await createAccessToken(api, {
            name: "ci token",
            permissions: ["files:read"],
            credentials: { username: "alice", password: users.alice },
        });

        const tokenClient = new ApiClient(baseUrl);
        tokenClient.setAccessToken(token);
        // Any principal may ask who it is; a token gets its own name and id.
        await expect(tokenClient.getCurrentUser()).resolves.toEqual({
            name: "ci token",
            method: "token",
            token_id: metadata.id,
            // Tokens do not idle out, so they have no session expiry.
            session: null,
            // Tokens can never manage tokens, so there is no sign-in window to report.
            fresh_login_seconds_left: null,
        });
    });

    it("keeps a separate user state for each user", async () => {
        const alice = await signIn("alice", users.alice);
        const bob = await signIn("bob", users.bob);
        await alice.updateUserState({ state: { theme: "alice-theme" } });
        await bob.updateUserState({ state: { theme: "bob-theme" } });

        // Each user reads back their own document, not the last one written.
        await expect(alice.getUserState()).resolves.toEqual({
            state: { theme: "alice-theme" },
        });
        await expect(bob.getUserState()).resolves.toEqual({
            state: { theme: "bob-theme" },
        });
        // The documents live in the users' own directories.
        expect(existsSync(join(dataDir, "users/alice/state.json"))).toBe(true);
        expect(existsSync(join(dataDir, "users/bob/state.json"))).toBe(true);
    });

    it("signs out only the changing user's other sessions on a password change", async () => {
        const changer = await signIn("alice", users.alice);
        const aliceElsewhere = await signIn("alice", users.alice);
        const bob = await signIn("bob", users.bob);

        await changer.changePassword(users.alice, "alice-new-password");
        onTestFinished(async () => {
            // Later tests sign in with the original passwords.
            await restartWith(users);
        });

        // The browser that made the change keeps working.
        await expect(changer.listAgents()).resolves.toEqual([]);
        // Alice's other browser is signed out.
        expect(await failureStatus(aliceElsewhere.listAgents())).toBe(401);
        // Bob is not affected by Alice's change.
        await expect(bob.listAgents()).resolves.toEqual([]);
        // Only Alice's entry changed in the file.
        const config = readFileSync(configPath, "utf8");
        expect(config).toContain(`password = "${users.bob}"`);
        expect(config).not.toContain(`password = "${users.alice}"`);
    });

    it("revokes the sessions of a user removed from the config", async () => {
        const alice = await signIn("alice", users.alice);
        const bob = await signIn("bob", users.bob);

        await restartWith({ alice: users.alice });
        onTestFinished(async () => {
            await restartWith(users);
        });

        // Bob's session ends with his entry.
        expect(await failureStatus(bob.listAgents())).toBe(401);
        // Alice keeps her session across the restart.
        await expect(alice.listAgents()).resolves.toEqual([]);
        // Bob cannot sign in any more.
        expect(await failureStatus(signIn("bob", users.bob))).toBe(401);
    });

    it("names the signed-in user in log lines, also from work the router does", async () => {
        const alice = await signIn("alice", users.alice);
        const serverProcess = processManager.getProcess(serverPid);

        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const agentName = `login-methods-agent-${VITEST_SERVER_PORT}`;
        const agentHome = join(serverHome, "agent-home");
        mkdirSync(agentHome, { recursive: true });
        const ready = waitForAgentReady(serverProcess, agentName);

        const agentPid = processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/agent/ws`,
            name: agentName,
            cwd: agentHome,
            home: agentHome,
        });

        onTestFinished(() => processManager.kill(agentPid));
        await ready;

        const agent = (await alice.listAgents()).find(
            (candidate) => candidate.name === agentName,
        );

        if (!agent) {
            throw new Error("The test agent did not register");
        }

        await agent.upload(
            join(agentHome, "uploaded.txt"),
            new File(["uploaded"], "uploaded.txt"),
        );

        // The upload is routed by the router's own task; the line still names Alice, so a
        // shared account's log shows who did what.
        await waitForValue({
            description: "an upload log line naming the user",
            predicate: async () =>
                /\[user=alice \(password\)\] Routing REST upload command/.test(
                    processManager.getStdout(serverPid),
                ),
        });
    });
});
