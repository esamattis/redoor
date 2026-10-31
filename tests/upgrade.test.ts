import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    writeFileSync,
    copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    onTestFinished,
    test,
    vi,
} from "vitest";
import { z } from "zod";
import { $ } from "zx";
import { ApiClient } from "#ui/api-client";
import type { ErrorResponse } from "#bindings/ErrorResponse";
import type { ExecRequest } from "#bindings/ExecRequest";
import type { ServerUpgradeResponse } from "#bindings/ServerUpgradeResponse";
import {
    getAvailablePort,
    SERVER_PATH,
    waitForPort,
    waitForValue,
} from "./test-utils";

/** Any tag works because the release mirror below is local. */
const RELEASE_TAG = "v0.0.0-upgrade-test";

/** Linux appends this to `/proc/<pid>/exe` once the file a process runs was replaced. */
const REPLACED_SUFFIX = " (deleted)";

const TOKEN = "upgrade-token";

const USERNAME = "upgrade-user";

const PASSWORD = "upgrade-password";

/** Hardlinks avoid copying the large debug binary; renaming over a link never touches the source. */
function placeBinary(destination: string) {
    try {
        linkSync(SERVER_PATH, destination);
    } catch {
        copyFileSync(SERVER_PATH, destination);
    }
}

/** Reads what a process executes so tests can tell the old image from the upgraded file. */
function executableOf(pid: number): string {
    return readlinkSync(`/proc/${pid}/exe`);
}

/**
 * Reads what the server executes, as the server itself sees it. The server is not dumpable
 * (so its user's other processes cannot read vault keys from its memory), which hides its
 * `/proc/<pid>/exe` from the test; its own view still ends in the replaced marker until it
 * re-executes.
 */
async function serverExecutable(port: number): Promise<string> {
    const client = new ApiClient(`http://127.0.0.1:${port}`);
    await client.login(USERNAME, PASSWORD);

    return (await client.getServerInfo()).exe_path;
}

/** Fields of the JSON PID record the upgrade tests rely on. */
const pidRecordSchema = z.object({ pid: z.number() });

/** Waits for a daemon to publish its PID file without relying on fixed delays. */
async function waitForPid(pidFile: string): Promise<number> {
    let pid = 0;
    await vi.waitFor(() => {
        // Parsing throws while the record is still being written, which retries the wait.
        pid = pidRecordSchema.parse(
            JSON.parse(readFileSync(pidFile, "utf8")),
        ).pid;

        // A positive PID proves the daemon completed the process-lock startup phase.
        expect(pid).toBeGreaterThan(0);
    });

    return pid;
}

/** /proc and the re-exec signal probe are Linux-specific; macOS restarts are not observable this way. */
describe.runIf(process.platform === "linux")("redoor upgrade", () => {
    let releaseRoot = "";

    beforeAll(async () => {
        releaseRoot = mkdtempSync(join(tmpdir(), "redoor-upgrade-release-"));
        const stage = join(releaseRoot, "stage");
        const tagDirectory = join(releaseRoot, "releases", RELEASE_TAG);
        mkdirSync(stage);
        mkdirSync(tagDirectory, { recursive: true });
        placeBinary(join(stage, "redoor"));
        const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
        const archive = join(tagDirectory, `redoor-${arch}-linux.tar.gz`);
        // Fast compression keeps archiving the debug binary quick; install.sh only needs gzip.
        await $`tar -cf - -C ${stage} redoor | gzip -1 > ${archive}`;
    }, 60_000);

    afterAll(() => {
        rmSync(releaseRoot, { recursive: true, force: true });
    });

    /** An isolated install of the binary plus a server config and a local release mirror. */
    async function fixture() {
        const root = mkdtempSync(join(tmpdir(), "redoor-upgrade-"));
        const home = join(root, "home");
        const binary = join(root, "bin", "redoor");
        const appName = `redoor-upgrade-${process.pid}-${Date.now()}`;
        const port = await getAvailablePort();
        mkdirSync(join(root, "bin"));
        placeBinary(binary);

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: home,
            REDOOR_APP_NAME: appName,
            REDOOR_AGENT_NOTIFICATION: "off",
            REDOOR_RELEASE_BASE_URL: `file://${join(releaseRoot, "releases")}`,
        };

        delete env.REDOOR_PORT;
        delete env.REDOOR_INSTALL_DIR;

        const configDirectory = join(home, ".config", appName);
        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(
            join(configDirectory, "config.toml"),
            `agent_token = "${TOKEN}"

[server]
username = "${USERNAME}"
password = "${PASSWORD}"
port = ${port}
`,
        );

        const dataDirectory = join(home, ".local", "share", appName);
        const run = $({ env, quiet: true, nothrow: true });

        onTestFinished(async () => {
            await run`${binary} agent stop`;
            await run`${binary} server stop`;
            rmSync(root, { recursive: true, force: true });
        });

        /** Starts both daemons from the binary under test and waits until the agent is connected. */
        async function startServerAndAgent() {
            await run`${binary} server --daemon`;

            const serverPid = await waitForPid(
                join(dataDirectory, "server.pid"),
            );

            await waitForPort(port);
            await run`${binary} agent ws://127.0.0.1:${port} --token ${TOKEN} --name upgrade-agent --daemon`;
            const agentPid = await waitForPid(join(dataDirectory, "agent.pid"));
            const agent = await waitForConnectedAgent();

            return { serverPid, agentPid, agentId: agent.id };
        }

        /** Logs in again on every attempt because a restarted server may drop the session. */
        async function waitForConnectedAgent() {
            return waitForValue({
                predicate: async () => {
                    const client = new ApiClient(`http://127.0.0.1:${port}`);
                    await client.login(USERNAME, PASSWORD);

                    return (await client.listAgents()).find(
                        (agent) =>
                            agent.name === "upgrade-agent" &&
                            agent.status === "connected",
                    );
                },
                timeoutMs: 30_000,
                description: "upgrade-agent connection",
            });
        }

        return {
            binary,
            port,
            pidFile: (role: "server" | "agent") =>
                join(dataDirectory, `${role}.pid`),
            run,
            startServerAndAgent,
            waitForConnectedAgent,
        };
    }

    test("restarts the running server and agent in place on the installed binary", async () => {
        const setup = await fixture();
        const { serverPid, agentPid } = await setup.startServerAndAgent();

        const upgrade = await setup.run`${setup.binary} upgrade ${RELEASE_TAG}`;

        // The embedded install script must succeed against the local mirror.
        expect(upgrade.exitCode, upgrade.stderr).toBe(0);
        // Both long-lived roles are reported, which proves they were found by binary path.
        expect(upgrade.stdout).toContain(`Restarted PID ${serverPid}`);
        expect(upgrade.stdout).toContain(`Restarted PID ${agentPid}`);
        // The same PIDs now execute the installed file instead of the replaced image, so
        // the restart was an in-place re-exec that a supervisor would keep tracking.
        expect(executableOf(agentPid)).toBe(setup.binary);
        // The server's image is hidden from the CLI, so its restart is only signalled and
        // may still be under way when the CLI exits.
        await vi.waitFor(
            async () => {
                expect(await serverExecutable(setup.port)).toBe(setup.binary);
            },
            { timeout: 60_000, interval: 100 },
        );
        // The re-exec kept the PID a supervisor tracks.
        expect(await waitForPid(setup.pidFile("server"))).toBe(serverPid);
        // The restarted agent must reach the restarted server again.
        await setup.waitForConnectedAgent();
    }, 90_000);

    test("leaves running processes on the old binary with --no-restart", async () => {
        const setup = await fixture();
        const { agentPid } = await setup.startServerAndAgent();

        const upgrade =
            await setup.run`${setup.binary} upgrade ${RELEASE_TAG} --no-restart`;

        // Installing alone must still succeed.
        expect(upgrade.exitCode, upgrade.stderr).toBe(0);
        // The operator is told the processes still need a restart.
        expect(upgrade.stdout).toContain("keep the old version");
        // The agent keeps executing the replaced image because nothing signalled it.
        expect(executableOf(agentPid)).toBe(
            `${setup.binary}${REPLACED_SUFFIX}`,
        );
    }, 90_000);

    test("finishes the restarts when it runs inside the agent it restarts", async () => {
        const setup = await fixture();

        const { serverPid, agentPid, agentId } =
            await setup.startServerAndAgent();

        const client = new ApiClient(`http://127.0.0.1:${setup.port}`);
        await client.login(USERNAME, PASSWORD);
        const originalInode = statSync(setup.binary).ino;

        const request: ExecRequest = {
            argv: [setup.binary, "upgrade", RELEASE_TAG],
            cwd: null,
            env: {},
            timeout_ms: null,
        };

        const response = await fetch(
            `http://127.0.0.1:${setup.port}/api/v1/agents/${agentId}/exec`,
            {
                method: "POST",
                headers: {
                    ...client.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
        );

        // The exec stream breaks when the server and agent restart, so its end is not awaited.
        void response.text().catch(() => "");

        await vi.waitFor(
            async () => {
                // Both processes already ran this path before the upgrade, so only a replaced
                // file proves the paths below point at the installed release.
                expect(statSync(setup.binary).ino).not.toBe(originalInode);
                // The server restarting drops the agent's connection, which kills the exec'd
                // command, so both restarts must complete even though their caller dies.
                expect(await serverExecutable(setup.port)).toBe(setup.binary);
                expect(executableOf(agentPid)).toBe(setup.binary);
            },
            { timeout: 60_000, interval: 100 },
        );
        // The re-exec kept the server's PID.
        expect(await waitForPid(setup.pidFile("server"))).toBe(serverPid);
        // The hosting agent must come back connected to the restarted server.
        await setup.waitForConnectedAgent();
    }, 90_000);

    /** Posts to the upgrade endpoint with a session so tests can assert raw statuses. */
    async function postUpgrade(port: number, targetVersion: string) {
        const client = new ApiClient(`http://127.0.0.1:${port}`);
        await client.login(USERNAME, PASSWORD);

        return fetch(`http://127.0.0.1:${port}/api/v1/server/upgrade`, {
            method: "POST",
            headers: {
                ...client.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ target_version: targetVersion }),
        });
    }

    test("upgrades the server and its agent through the REST API", async () => {
        const setup = await fixture();
        const { serverPid, agentPid } = await setup.startServerAndAgent();

        const response = await postUpgrade(setup.port, RELEASE_TAG);
        const body: ServerUpgradeResponse = await response.json();

        // The response arrives after the install, before the server restarts itself.
        expect(response.status, JSON.stringify(body)).toBe(200);
        // The install output reaches the caller so the UI can show what happened.
        expect(body.output).toContain("install: done");
        // The agent was signalled; the server cannot wait for it because it restarts too.
        expect(body.processes).toContainEqual({
            pid: agentPid,
            command: expect.stringContaining("upgrade-agent"),
            outcome: { type: "restarting" },
        });
        // The server restarts itself rather than listing itself among the other processes.
        expect(body.processes.map((process) => process.pid)).not.toContain(
            serverPid,
        );

        await vi.waitFor(
            async () => {
                // The helper restarts both in place even though the server answered first.
                expect(await serverExecutable(setup.port)).toBe(setup.binary);
                expect(executableOf(agentPid)).toBe(setup.binary);
            },
            { timeout: 60_000, interval: 100 },
        );
        // The re-exec kept the server's PID.
        expect(await waitForPid(setup.pidFile("server"))).toBe(serverPid);
        // The agent reconnects to the restarted server.
        await setup.waitForConnectedAgent();
    }, 90_000);

    test("reports a failed install and keeps the server running", async () => {
        const setup = await fixture();
        const { serverPid } = await setup.startServerAndAgent();

        const missing = await postUpgrade(setup.port, "v0.0.0-missing");
        const error: ErrorResponse = await missing.json();

        // A release missing from the mirror fails the install with its reason.
        expect(missing.status).toBe(500);
        expect(error.error).toContain("download failed");
        // Nothing was replaced, so the server still runs its original, intact binary.
        expect(await serverExecutable(setup.port)).toBe(setup.binary);
        expect(await waitForPid(setup.pidFile("server"))).toBe(serverPid);

        const invalid = await postUpgrade(setup.port, "--no-restart");

        // Tags that could be parsed as CLI options are refused before anything runs.
        expect(invalid.status).toBe(400);
        // The refusals left the server serving the agent.
        await setup.waitForConnectedAgent();
    }, 90_000);
});
