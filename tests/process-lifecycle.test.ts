import { execFile, spawn } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished, describe, expect, test, vi } from "vitest";
import { ApiClient } from "#ui/api-client";
import {
    getAvailablePort,
    SERVER_PATH,
    waitForPort,
    waitForValue,
} from "./test-utils";

const execFileAsync = promisify(execFile);

/** Creates an isolated application namespace and guarantees daemon cleanup after a test. */
function isolatedProcess(role: "agent" | "server") {
    const home = mkdtempSync(join(tmpdir(), `redoor-${role}-lifecycle-`));
    const appName = `redoor-${role}-${process.pid}-${Date.now()}`;
    const env: NodeJS.ProcessEnv & {
        HOME: string;
        REDOOR_APP_NAME: string;
        REDOOR_AGENT_NOTIFICATION: string;
    } = {
        ...process.env,
        HOME: home,
        REDOOR_APP_NAME: appName,
        REDOOR_AGENT_NOTIFICATION: "off",
    };
    delete env.REDOOR_PORT;
    const pidFile = join(home, ".local", "share", appName, `${role}.pid`);
    const stopArgs = [role, "stop"];

    onTestFinished(async () => {
        try {
            await execFileAsync(SERVER_PATH, stopArgs, { env });
        } catch {
            // The tested stop command may already have removed the process.
        }
        rmSync(home, { recursive: true, force: true });
    });

    return { env, pidFile, stopArgs };
}

/** Waits for a daemon to atomically publish its numeric PID without relying on fixed delays. */
async function waitForPid(pidFile: string, stalePid?: number): Promise<number> {
    let pid = 0;
    await vi.waitFor(() => {
        pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        // A numeric PID proves the daemon completed the process-lock startup phase.
        expect(pid).toBeGreaterThan(0);
        if (stalePid !== undefined) {
            // A changed PID proves startup replaced the unlocked stale record.
            expect(pid).not.toBe(stalePid);
        }
    });
    return pid;
}

/** Starts a foreground command beneath a shell that can be SIGKILLed independently. */
function spawnWithKillableParent(args: string[], env: NodeJS.ProcessEnv) {
    const command = [SERVER_PATH, ...args]
        .map((value) => `'${value.replaceAll("'", `'\\''`)}'`)
        .join(" ");
    return spawn("sh", ["-c", `${command}; true`], { env });
}

/** Best-effort cleanup prevents failed parent-death assertions from leaking processes. */
function killOnTestFinished(pid: number) {
    onTestFinished(() => {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // The parent-death assertion may already have reaped the process.
        }
    });
}

describe("process lifecycle commands", () => {
    test("server daemon writes a PID, rejects duplicates, and stops", async () => {
        const isolated = isolatedProcess("server");
        const port = await getAvailablePort();
        const configDirectory = join(
            isolated.env.HOME,
            ".config",
            isolated.env.REDOOR_APP_NAME,
        );
        const configPath = join(configDirectory, "config.toml");
        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(
            configPath,
            `agent_token = "lifecycle-token"

[server]
username = "lifecycle-user"
password = "lifecycle-password"
port = ${port}
`,
        );
        mkdirSync(dirname(isolated.pidFile), { recursive: true });
        writeFileSync(isolated.pidFile, `${process.pid}\n`);

        await execFileAsync(
            SERVER_PATH,
            ["server", "--config", configPath, "--daemon"],
            {
                env: isolated.env,
            },
        );
        const pid = await waitForPid(isolated.pidFile, process.pid);
        // An unlocked stale file must not make an unrelated live PID look like the server.
        expect(pid).not.toBe(process.pid);

        const status = await execFileAsync(SERVER_PATH, ["server", "status"], {
            env: isolated.env,
        });
        // Status must report the lock owner rather than only checking file presence.
        expect(status.stdout).toContain(`server is running with PID ${pid}`);

        await expect(
            execFileAsync(SERVER_PATH, ["server", "--config", configPath], {
                env: isolated.env,
            }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                "run `redoor server stop` to stop it",
            ),
        });

        const stopped = await execFileAsync(SERVER_PATH, ["server", "stop"], {
            env: isolated.env,
        });
        // Reporting the daemon PID confirms the stop command targeted the PID-file owner.
        expect(stopped.stdout).toContain(`Stopped server process ${pid}`);
        await vi.waitFor(() => {
            // Signal 0 failing proves stop waited for process termination rather than only deleting the file.
            expect(() => process.kill(pid, 0)).toThrow();
        });

        await expect(
            execFileAsync(SERVER_PATH, ["server", "status"], {
                env: isolated.env,
            }),
        ).rejects.toMatchObject({
            // After stop, status must not claim a process from a leftover unlocked file.
            stderr: expect.stringContaining("server is not running"),
        });
    });

    test("agent daemon writes a PID, rejects duplicates, and stops", async () => {
        const isolated = isolatedProcess("agent");
        const port = await getAvailablePort();
        const agentArgs = [
            "agent",
            `ws://127.0.0.1:${port}/ws`,
            "--token",
            "lifecycle-token",
            "--name",
            "lifecycle-agent",
        ];

        await execFileAsync(SERVER_PATH, [...agentArgs, "--daemon"], {
            env: isolated.env,
        });
        const pid = await waitForPid(isolated.pidFile);

        const status = await execFileAsync(SERVER_PATH, ["agent", "status"], {
            env: isolated.env,
        });
        // Status shares the same lock truth as stop/duplicate-start rejection.
        expect(status.stdout).toContain(`agent is running with PID ${pid}`);

        await expect(
            execFileAsync(SERVER_PATH, agentArgs, { env: isolated.env }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                "run `redoor agent stop` to stop it",
            ),
        });

        const stopped = await execFileAsync(SERVER_PATH, ["agent", "stop"], {
            env: isolated.env,
        });
        // Reporting the daemon PID confirms agent stop used the isolated application namespace.
        expect(stopped.stdout).toContain(`Stopped agent process ${pid}`);
        await vi.waitFor(() => {
            // The agent must be gone even though its WebSocket reconnect loop was active.
            expect(() => process.kill(pid, 0)).toThrow();
        });
    });

    test("named relay status and stop need only the relay ID", async () => {
        const isolated = isolatedProcess("agent");

        await expect(
            execFileAsync(
                SERVER_PATH,
                ["agent", "relay", "status", "production"],
                {
                    env: isolated.env,
                },
            ),
        ).rejects.toMatchObject({
            // Empty namespaces must report the selected relay instead of requiring TOML startup fields.
            stderr: expect.stringContaining(
                "relay 'production' is not running",
            ),
        });

        await expect(
            execFileAsync(
                SERVER_PATH,
                ["agent", "relay", "stop", "production"],
                {
                    env: isolated.env,
                },
            ),
        ).rejects.toMatchObject({
            // Stop must use the same isolated runtime identity as status.
            stderr: expect.stringContaining(
                "relay 'production' is not running",
            ),
        });
    });

    test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
        "foreground server exits when its parent is killed",
        async () => {
            const isolated = isolatedProcess("server");
            const port = await getAvailablePort();
            const configDirectory = join(
                isolated.env.HOME,
                ".config",
                isolated.env.REDOOR_APP_NAME,
            );
            const configPath = join(configDirectory, "config.toml");
            mkdirSync(configDirectory, { recursive: true });
            writeFileSync(
                configPath,
                `agent_token = "lifecycle-token"

[server]
username = "lifecycle-user"
password = "lifecycle-password"
port = ${port}
`,
            );

            const parent = spawnWithKillableParent(
                ["server", "--config", configPath],
                isolated.env,
            );

            const serverPid = await waitForPid(isolated.pidFile);

            if (parent.pid === undefined) {
                throw new Error("parent shell should have a pid");
            }
            killOnTestFinished(parent.pid);
            killOnTestFinished(serverPid);
            // bash execs a lone `sh -c` command; `; true` keeps a real parent to SIGKILL.
            expect(parent.pid).not.toBe(serverPid);
            process.kill(parent.pid, "SIGKILL");
            await vi.waitFor(() => {
                // SIGKILL of playwright-dev cannot run a trap; the server must exit itself.
                expect(() => process.kill(serverPid, 0)).toThrow();
            });
        },
    );

    test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
        "foreground standalone agent exits when its parent is killed",
        async () => {
            const isolated = isolatedProcess("agent");
            const port = await getAvailablePort();
            const parent = spawnWithKillableParent(
                [
                    "agent",
                    `ws://127.0.0.1:${port}/ws`,
                    "--token",
                    "lifecycle-token",
                    "--name",
                    "foreground-lifecycle-agent",
                ],
                isolated.env,
            );
            const agentPid = await waitForPid(isolated.pidFile);

            if (parent.pid === undefined) {
                throw new Error("parent shell should have a pid");
            }
            killOnTestFinished(parent.pid);
            killOnTestFinished(agentPid);
            // The agent command must remain below the shell whose death it watches.
            expect(parent.pid).not.toBe(agentPid);
            process.kill(parent.pid, "SIGKILL");
            await vi.waitFor(() => {
                // The reconnect loop must not outlive a killed foreground supervisor.
                expect(() => process.kill(agentPid, 0)).toThrow();
            });
        },
    );

    test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
        "managed local agent exits when its daemon server is killed",
        async () => {
            const isolated = isolatedProcess("server");
            const port = await getAvailablePort();
            const configDirectory = join(
                isolated.env.HOME,
                ".config",
                isolated.env.REDOOR_APP_NAME,
            );
            const configPath = join(configDirectory, "config.toml");
            const agentHome = join(isolated.env.HOME, "managed-agent-home");
            mkdirSync(configDirectory, { recursive: true });
            mkdirSync(agentHome, { recursive: true });
            writeFileSync(
                configPath,
                `agent_token = "lifecycle-token"

[server]
username = "lifecycle-user"
password = "lifecycle-password"
port = ${port}

[[agents]]
local = true
name = "managed-lifecycle-agent"
home = "${agentHome}"
`,
            );

            await execFileAsync(
                SERVER_PATH,
                ["server", "--config", configPath, "--daemon"],
                { env: isolated.env },
            );
            const serverPid = await waitForPid(isolated.pidFile);
            killOnTestFinished(serverPid);
            await waitForPort(port);
            const apiClient = new ApiClient(`http://127.0.0.1:${port}`);
            await apiClient.login("lifecycle-user", "lifecycle-password");
            const configuredAgent = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) => agent.name === "managed-lifecycle-agent",
                    ),
                description: "managed lifecycle agent registration",
            });
            await configuredAgent.start();
            const connectedAgent = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) =>
                            agent.name === "managed-lifecycle-agent" &&
                            agent.status === "connected",
                    ),
                timeoutMs: 15_000,
                description: "managed lifecycle agent connection",
            });
            const agentPid = (await connectedAgent.getDetails()).pid;
            killOnTestFinished(agentPid);

            process.kill(serverPid, "SIGKILL");
            await vi.waitFor(() => {
                // A daemon marker inherited from the server must not detach its managed child.
                expect(() => process.kill(agentPid, 0)).toThrow();
            });
        },
        30_000,
    );
});
