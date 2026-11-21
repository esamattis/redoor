import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    TempFileManager,
    TEST_APP_NAME,
    getAvailablePort,
    seedUserWorkspace,
    serverDataDir,
    waitForPort,
    webSocketDataToString,
} from "./test-utils";
import { tokenProof } from "./fake-agent";

/** Builds the HMAC upgrade proof headers for a given agent token. */
function upgradeProofHeaders(token: string) {
    const nonce = randomBytes(32).toString("hex");

    return {
        "x-redoor-agent-nonce": nonce,
        "x-redoor-agent-proof": tokenProof(token, "redoor agent upgrade", [
            nonce,
        ]),
    };
}

/** Attempts a WebSocket upgrade and returns the HTTP rejection status code. */
function probeWsUpgradeStatus(
    wsUrl: string,
    protocol: string,
    headers: Record<string, string>,
): Promise<number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, [protocol], { headers });
        ws.once("unexpected-response", (_req, res) => {
            ws.terminate();
            resolve(res.statusCode ?? 0);
        });
        ws.once("open", () => {
            ws.close();
            resolve(101);
        });
        ws.once("error", (error) => {
            reject(error);
        });
    });
}

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** Starts an isolated multi-user server (`alice` and `bob`) on an ephemeral port. */
async function startTwoUserServer(options: {
    legacy?: boolean;
    seedWorkspaces?: boolean;
} = {}) {
    const port = await getAvailablePort();
    const home = tempFiles.tempDirectory({ suffix: "-server-home" });
    const appName = `${TEST_APP_NAME}-workspaces-${port}`;
    const configPath = tempFiles.create(
        options.legacy
            ? `agent_token = "legacy-shared-token"

[server]
port = ${port}

[[server.users]]
name = "alice"
password = "alice-password"

[[server.users]]
name = "bob"
password = "bob-password"

[[agents]]
local = true
name = "legacy_box"
home = "${home}"
`
            : `[server]
port = ${port}

[[server.users]]
name = "alice"
password = "alice-password"

[[server.users]]
name = "bob"
password = "bob-password"
`,
        { suffix: ".toml" },
    );

    if (options.legacy) {
        const dataDir = serverDataDir(home, appName);
        mkdirSync(join(dataDir, "ssh", "dev_legacykeyaaaaaaaaaaa"), {
            recursive: true,
        });
        mkdirSync(join(dataDir, "tokens"), { recursive: true });
        writeFileSync(join(dataDir, "vault.json"), "{}");
        writeFileSync(
            join(dataDir, "tokens", "access-tokens.json"),
            JSON.stringify({ version: 1, tokens: [] }),
        );
    } else if (options.seedWorkspaces) {
        seedUserWorkspace({
            home,
            appName,
            username: "alice",
            agentToken: "alice-agent-token",
        });
        seedUserWorkspace({
            home,
            appName,
            username: "bob",
            agentToken: "bob-agent-token",
        });
    }

    const pid = processManager.spawnServer({
        config: configPath,
        home,
        env: {
            REDOOR_PORT: String(port),
            REDOOR_APP_NAME: appName,
        },
        skipWorkspaceSeed: true,
    });

    onTestFinished(async () => {
        await processManager.killAndWait(pid);
    });

    await waitForPort(port);

    return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/api/v1/agent/ws`,
        home,
        appName,
        configPath,
    };
}

describe("Per-user workspaces", () => {
    it("isolates devices, tokens, MCP, terminals, managed agents, UI events, protocol mismatches, and sessions", async () => {
        const server = await startTwoUserServer({ seedWorkspaces: true });
        const alice = new ApiClient(server.baseUrl);
        const bob = new ApiClient(server.baseUrl);
        await alice.login("alice", "alice-password");
        await bob.login("bob", "bob-password");

        // Freshly logged-in users see their own per-user agent token from server info.
        const [aliceInfo, bobInfo] = await Promise.all([
            alice.getServerInfo(),
            bob.getServerInfo(),
        ]);
        expect(aliceInfo.agent_token).toBe("alice-agent-token");
        expect(bobInfo.agent_token).toBe("bob-agent-token");

        // Connect two standalone agents with the exact same name, one per user token.
        const aliceDir = tempFiles.tempDirectory({ suffix: "-alice-agent" });
        const bobDir = tempFiles.tempDirectory({ suffix: "-bob-agent" });
        writeFileSync(join(aliceDir, "secret.txt"), "alice-only");
        writeFileSync(join(bobDir, "secret.txt"), "bob-only");

        const aliceAgentPid = processManager.spawnAgent({
            wsAddress: server.wsUrl,
            name: "shared-box",
            cwd: aliceDir,
            home: aliceDir,
            token: "alice-agent-token",
        });
        const bobAgentPid = processManager.spawnAgent({
            wsAddress: server.wsUrl,
            name: "shared-box",
            cwd: bobDir,
            home: bobDir,
            token: "bob-agent-token",
        });
        onTestFinished(async () => {
            await processManager.killAndWait(aliceAgentPid);
            await processManager.killAndWait(bobAgentPid);
        });

        await Promise.all([
            alice.waitForConnectedAgentNames(["shared-box"], 15_000),
            bob.waitForConnectedAgentNames(["shared-box"], 15_000),
        ]);

        const [aliceAgents, bobAgents] = await Promise.all([
            alice.listAgents(),
            bob.listAgents(),
        ]);
        // Each user sees only their own device despite identical names.
        expect(aliceAgents.map((a) => a.name)).toEqual(["shared-box"]);
        expect(bobAgents.map((a) => a.name)).toEqual(["shared-box"]);
        const aliceDevice = aliceAgents[0];
        const bobDevice = bobAgents[0];
        expect(aliceDevice).toBeDefined();
        expect(bobDevice).toBeDefined();
        if (!aliceDevice || !bobDevice) {
            return;
        }
        expect(aliceDevice.id).not.toBe(bobDevice.id);

        // Reading the same relative path on `shared-box` reaches each user's own agent.
        expect(
            await (
                await aliceDevice.download(join(aliceDir, "secret.txt"))
            ).text(),
        ).toBe("alice-only");
        expect(
            await (
                await bobDevice.download(join(bobDir, "secret.txt"))
            ).text(),
        ).toBe("bob-only");

        // Bob cannot address Alice's device by its stable id.
        const crossDeviceResponse = await fetch(
            `${server.baseUrl}/api/v1/agents/${encodeURIComponent(aliceDevice.id)}`,
            { headers: bob.getAuthHeaders() },
        );
        expect(crossDeviceResponse.status).toBe(404);

        // Access tokens and DeviceScope::All are scoped to the issuing user's workspace.
        const aliceToken = await alice.createAccessToken({
            name: "alice-cli",
            permissions: ["files:read"],
            devices: { kind: "all" },
            expires_at: null,
        });
        // Bob does not see Alice's access tokens and cannot revoke them.
        expect((await bob.listAccessTokens()).tokens).toEqual([]);
        await expect(
            bob.deleteAccessToken(aliceToken.metadata.id),
        ).rejects.toThrow(ApiError);

        const aliceTokenClient = new ApiClient(server.baseUrl);
        aliceTokenClient.setAccessToken(aliceToken.token);
        // Alice's token with DeviceScope::All lists only Alice's devices.
        const tokenDevices = await aliceTokenClient.listAgents();
        expect(tokenDevices.map((d) => d.id)).toEqual([aliceDevice.id]);
        const tokenCrossDevice = await fetch(
            `${server.baseUrl}/api/v1/agents/${encodeURIComponent(bobDevice.id)}`,
            { headers: { Authorization: `Bearer ${aliceToken.token}` } },
        );
        expect(tokenCrossDevice.status).toBe(404);

        // Terminals created by Alice are invisible and un-closable by Bob.
        const terminal = await aliceDevice.createTerminalSession({
            cwd: aliceDir,
            title: "alice-shell",
            number: 1,
            size: { rows: 24, cols: 80 },
        });
        expect(
            (await alice.listTerminalSessions()).sessions.map((s) => s.id),
        ).toContain(terminal.session.id);
        expect((await bob.listTerminalSessions()).sessions).toEqual([]);
        const bobDeleteTerminal = await fetch(
            `${server.baseUrl}/api/v1/terminals/${encodeURIComponent(terminal.session.id)}`,
            { method: "DELETE", headers: bob.getAuthHeaders() },
        );
        expect(bobDeleteTerminal.status).toBe(404);

        // Managed devices created by Alice live only in Alice's workspace.
        const managed = await alice.createLocalAgent({
            name: "alice-managed",
            home: aliceDir,
        });
        expect((await alice.listAgents()).map((a) => a.id)).toContain(
            managed.agent.id,
        );
        expect((await bob.listAgents()).map((a) => a.id)).not.toContain(
            managed.agent.id,
        );
        const bobReadManaged = await fetch(
            `${server.baseUrl}/api/v1/local-agents/${encodeURIComponent(managed.agent.id)}/configuration`,
            { headers: bob.getAuthHeaders() },
        );
        expect(bobReadManaged.status).toBe(404);

        // Protocol mismatches using Alice's token appear only in Alice's mismatch list.
        const mismatchStatus = await probeWsUpgradeStatus(
            server.wsUrl,
            "redoor.v0",
            upgradeProofHeaders("alice-agent-token"),
        );
        expect(mismatchStatus).toBe(426);
        expect((await alice.listProtocolMismatches()).attempts.length).toBeGreaterThan(
            0,
        );
        expect((await bob.listProtocolMismatches()).attempts).toEqual([]);

        // UI WebSocket events for Alice's agent changes do not leak to Bob's socket.
        const aliceEvents: string[] = [];
        const bobEvents: string[] = [];
        const openUiWs = (client: ApiClient, sink: string[]) =>
            new Promise<WebSocket>((resolve, reject) => {
                const ws = new WebSocket(
                    `ws://127.0.0.1:${server.port}/api/v1/ui/ws`,
                    {
                        headers: {
                            ...client.getAuthHeaders(),
                            Origin: server.baseUrl,
                        },
                    },
                );
                ws.on("message", (data) => sink.push(webSocketDataToString(data)));
                ws.once("open", () => resolve(ws));
                ws.once("error", reject);
            });
        const [aliceWs, bobWs] = await Promise.all([
            openUiWs(alice, aliceEvents),
            openUiWs(bob, bobEvents),
        ]);
        onTestFinished(() => {
            aliceWs.close();
            bobWs.close();
        });

        const ephemeralPid = processManager.spawnAgent({
            wsAddress: server.wsUrl,
            token: "alice-agent-token",
            name: "alice-ephemeral",
            cwd: aliceDir,
            home: aliceDir,
        });
        onTestFinished(async () => {
            await processManager.killAndWait(ephemeralPid);
        });
        await alice.waitForConnectedAgentNames(["shared-box", "alice-ephemeral"]);
        // Alice receives agents_changed while Bob receives no event for Alice's agent.
        await expect
            .poll(() => aliceEvents.some((raw) => raw.includes("agents_changed")))
            .toBe(true);
        expect(bobEvents.some((raw) => raw.includes("agents_changed"))).toBe(
            false,
        );

        // Browser sessions list is scoped to the signed-in user.
        const [aliceSessions, bobSessions] = await Promise.all([
            alice.listBrowserSessions(),
            bob.listBrowserSessions(),
        ]);
        expect(aliceSessions.sessions.length).toBe(1);
        expect(bobSessions.sessions.length).toBe(1);
        expect(aliceSessions.sessions[0]?.id).not.toBe(
            bobSessions.sessions[0]?.id,
        );
    });

    it("gates legacy servers with 503 until confirmed, then migrates live to the chosen user", async () => {
        const server = await startTwoUserServer({ legacy: true });
        const alice = new ApiClient(server.baseUrl);
        await alice.login("alice", "alice-password");

        // Migration status reports pending=true and summarizes every legacy resource.
        const status = await alice.getMigrationStatus();
        expect(status.pending).toBe(true);
        expect(status.summary).toEqual({
            managed_device_count: 1,
            managed_device_names: ["legacy_box"],
            has_vault: true,
            ssh_key_count: 1,
            access_token_count: 0,
            agent_token: "legacy-shared-token",
        });

        // Normal REST endpoints are blocked with 503 + migration_required while pending.
        const blockedAgents = await fetch(`${server.baseUrl}/api/v1/agents`, {
            headers: alice.getAuthHeaders(),
        });
        expect(blockedAgents.status).toBe(503);
        expect(await blockedAgents.json()).toMatchObject({
            code: "migration_required",
        });

        // Agent websocket upgrades are also held off with 503 while migration is pending.
        const blockedWsStatus = await probeWsUpgradeStatus(
            server.wsUrl,
            "redoor.v7",
            upgradeProofHeaders("legacy-shared-token"),
        );
        expect(blockedWsStatus).toBe(503);

        // Operator switches to Bob; confirming with stale expected_username "alice" is rejected.
        const bob = new ApiClient(server.baseUrl);
        await bob.login("bob", "bob-password");
        await expect(bob.confirmMigration("alice")).rejects.toMatchObject({
            status: 409,
        });
        expect((await bob.getMigrationStatus()).pending).toBe(true);

        const confirmed = await bob.confirmMigration("bob");
        expect(confirmed.migrated_to).toBe("bob");

        // Gate is lifted immediately without restart.
        expect((await bob.getMigrationStatus()).pending).toBe(false);
        expect((await bob.listAgents()).map((a) => a.name)).toEqual([
            "legacy_box",
        ]);
        expect((await bob.getServerInfo()).agent_token).toBe(
            "legacy-shared-token",
        );

        // Alice starts with her own clean empty workspace and distinct generated agent token.
        expect(await alice.listAgents()).toEqual([]);
        const aliceToken = (await alice.getServerInfo()).agent_token;
        expect(aliceToken).not.toBe("legacy-shared-token");

        // Legacy global files were moved into Bob's workspace and config.toml was cleaned.
        const dataDir = serverDataDir(server.home, server.appName);
        const bobDir = join(dataDir, "users", "bob");
        expect(existsSync(join(dataDir, "layout-version"))).toBe(true);
        expect(existsSync(join(bobDir, "vault.json"))).toBe(true);
        expect(existsSync(join(dataDir, "vault.json"))).toBe(false);
        expect(
            existsSync(join(bobDir, "ssh", "dev_legacykeyaaaaaaaaaaa")),
        ).toBe(true);
        expect(existsSync(join(bobDir, "access-tokens.json"))).toBe(true);
        const cleanedConfig = readFileSync(server.configPath, "utf8");
        expect(cleanedConfig).not.toContain("agent_token");
        expect(cleanedConfig).not.toContain("[[agents]]");

        // Standalone agent using the preserved legacy token now connects directly to Bob.
        const agentDir = tempFiles.tempDirectory({ suffix: "-migrated-agent" });
        const agentPid = processManager.spawnAgent({
            wsAddress: server.wsUrl,
            name: "reconnected-agent",
            cwd: agentDir,
            home: agentDir,
            token: "legacy-shared-token",
        });
        onTestFinished(async () => {
            await processManager.killAndWait(agentPid);
        });
        await bob.waitForConnectedAgentNames(["reconnected-agent"], 15_000);
        expect((await alice.listAgents()).map((a) => a.name)).not.toContain(
            "reconnected-agent",
        );
    }, 30_000);

    it("skips migration on a fresh install with no legacy data", async () => {
        const server = await startTwoUserServer({
            legacy: false,
            seedWorkspaces: false,
        });
        const alice = new ApiClient(server.baseUrl);
        await alice.login("alice", "alice-password");

        // Fresh servers start directly in layout v2 with migration already cleared.
        expect((await alice.getMigrationStatus()).pending).toBe(false);
        expect(await alice.listAgents()).toEqual([]);
        expect((await alice.getServerInfo()).agent_token.length).toBeGreaterThan(
            0,
        );
    });
});
