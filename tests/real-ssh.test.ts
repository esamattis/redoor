import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
    waitForValue,
} from "./test-utils";

const execFileAsync = promisify(execFile);

const SSH_TEST_HOST = "redoor-ssh-test";
const SSH_TEST_USER = "redoor";
const SSH_PASSWORD_USER = "redoor-password";

type RelayPidMetadata = {
    pid: number;
    id: string;
    agent_name: string;
    agent_app_name: string;
};

const relayPidMetadataSchema: z.ZodType<RelayPidMetadata> = z.object({
    pid: z.number().int().positive(),
    id: z.string(),
    agent_name: z.string(),
    agent_app_name: z.string(),
});

/** Quotes one controlled value for the remote POSIX shell used by OpenSSH. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Runs a finite relay lifecycle command inside the test's isolated local namespace. */
async function relayCommand(options: {
    home: string;
    appName: string;
    args: string[];
}): Promise<void> {
    await execFileAsync(SERVER_PATH, options.args, {
        env: {
            ...process.env,
            HOME: options.home,
            REDOOR_APP_NAME: options.appName,
            REDOOR_AGENT_NOTIFICATION: "off",
        },
    });
}

/** Runs a command on the SSH test host as the required redoor user. */
async function sshTestCommand(command: string): Promise<void> {
    await execFileAsync("ssh", ["-l", SSH_TEST_USER, SSH_TEST_HOST, command]);
}

/** Runs a command as the password-only user so cleanup can reach that user's home. */
async function sshPasswordTestCommand(command: string): Promise<void> {
    const password = process.env.REDOOR_SSH_TEST_PASSWORD;
    if (password === undefined || password === "") {
        throw new Error(
            "REDOOR_SSH_TEST_PASSWORD is required for password SSH cleanup",
        );
    }
    const askpassDir = mkdtempSync(join(tmpdir(), "redoor-ssh-askpass-"));
    const askpassPath = join(askpassDir, "askpass");
    writeFileSync(
        askpassPath,
        `#!/bin/sh
printf '%s\n' ${shellQuote(password)}
`,
        { mode: 0o700 },
    );
    try {
        await execFileAsync(
            "ssh",
            ["-l", SSH_PASSWORD_USER, SSH_TEST_HOST, command],
            {
                env: {
                    ...process.env,
                    DISPLAY: process.env.DISPLAY ?? ":0",
                    SSH_ASKPASS: askpassPath,
                    SSH_ASKPASS_REQUIRE: "force",
                },
            },
        );
    } finally {
        rmSync(askpassDir, { recursive: true, force: true });
    }
}

/** Stops any orphaned remote agent and removes only this test's isolated files. */
async function cleanupSshTest(options: {
    remoteRoot: string;
    agentAppNames: string[];
    sshCommand?: (command: string) => Promise<void>;
}): Promise<void> {
    const run = options.sshCommand ?? sshTestCommand;
    const appNames = options.agentAppNames.map(shellQuote).join(" ");
    const command = `for app in ${appNames}; do pid_file="$HOME/.local/share/$app/agent.pid"; if [ -f "$pid_file" ]; then pid=$(tr -d '[:space:]' < "$pid_file"); case "$pid" in *[!0-9]*|'') ;; *) kill "$pid" 2>/dev/null || true ;; esac; fi; rm -rf "$HOME/.local/share/$app"; done; rm -rf ${shellQuote(options.remoteRoot)}`;
    await run(command);
}

/** Kills one remote relay agent so the owning local SSH process must reconnect it. */
async function killRemoteAgent(agentAppName: string): Promise<void> {
    const appName = shellQuote(agentAppName);
    const command = `app=${appName}; pid_file="$HOME/.local/share/$app/agent.pid"; pid=$(tr -d '[:space:]' < "$pid_file"); kill -KILL "$pid"`;
    await sshTestCommand(command);
}

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")(
    "named SSH relays",
    () => {
        test("runs and controls multiple relays independently on one SSH host", async () => {
            const processManager = new ProcessManager();
            const home = mkdtempSync(
                join(tmpdir(), "redoor-relay-integration-"),
            );
            const suffix = `${process.pid}-${Date.now()}`;
            const appName = `redoor-relay-test-${suffix}`;
            const relayIds = ["first", "second"] as const;
            const agentNames = relayIds.map(
                (id) => `relay-test-${id}-${suffix}`,
            );
            const agentAppNames = relayIds.map(
                (id) => `redoor-relay-agent-${id}-${suffix}`,
            );
            const remoteRoot = `/tmp/redoor-relay-test-${suffix}`;
            const configPath = join(home, "config.toml");
            const localLogDirectory = join(home, "logs");
            mkdirSync(localLogDirectory, { recursive: true });
            writeFileSync(
                configPath,
                `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[relays]]
id = "${relayIds[0]}"
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
server = "http://127.0.0.1:${VITEST_SERVER_PORT}"
name = "${agentNames[0]}"
agent_app_name = "${agentAppNames[0]}"
remote_bin = "${remoteRoot}/${relayIds[0]}/redoor"
binary_source = "${SERVER_PATH}"
home = "${remoteRoot}/${relayIds[0]}"
log = "${join(localLogDirectory, `${relayIds[0]}.log`)}"

[[relays]]
id = "${relayIds[1]}"
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
server = "http://127.0.0.1:${VITEST_SERVER_PORT}"
name = "${agentNames[1]}"
agent_app_name = "${agentAppNames[1]}"
remote_bin = "${remoteRoot}/${relayIds[1]}/redoor"
binary_source = "${SERVER_PATH}"
home = "${remoteRoot}/${relayIds[1]}"
log = "${join(localLogDirectory, `${relayIds[1]}.log`)}"
`,
            );

            onTestFinished(async () => {
                for (const id of relayIds) {
                    try {
                        await relayCommand({
                            home,
                            appName,
                            args: ["agent", "relay", "stop", id],
                        });
                    } catch {
                        // The test may already have stopped the selected relay.
                    }
                }
                try {
                    await cleanupSshTest({ remoteRoot, agentAppNames });
                } finally {
                    processManager.killAll();
                    rmSync(home, { recursive: true, force: true });
                }
            });

            // Remove artifacts from an interrupted run before starting remote processes.
            await cleanupSshTest({ remoteRoot, agentAppNames });
            processManager.spawnServer({ config: configPath });
            await waitForPort(VITEST_SERVER_PORT);
            const apiClient = new ApiClient(
                `http://127.0.0.1:${VITEST_SERVER_PORT}`,
            );
            await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

            const foregroundRelayPid = processManager.spawn(
                SERVER_PATH,
                [
                    "agent",
                    "relay",
                    "start",
                    relayIds[0],
                    "--config",
                    configPath,
                ],
                {
                    env: {
                        ...process.env,
                        HOME: home,
                        REDOOR_APP_NAME: appName,
                        REDOOR_AGENT_NOTIFICATION: "off",
                    },
                },
            );
            await relayCommand({
                home,
                appName,
                args: [
                    "agent",
                    "relay",
                    "start",
                    relayIds[1],
                    "--config",
                    configPath,
                    "--daemon",
                ],
            });

            const metadata = await Promise.all(
                relayIds.map((id) =>
                    waitForValue<RelayPidMetadata>({
                        predicate: async () => {
                            try {
                                const path = join(
                                    home,
                                    ".local",
                                    "share",
                                    appName,
                                    "relays",
                                    `${id}.pid`,
                                );
                                return relayPidMetadataSchema.parse(
                                    JSON.parse(readFileSync(path, "utf8")),
                                );
                            } catch {
                                return undefined;
                            }
                        },
                        timeoutMs: 30_000,
                        description: `relay ${id} JSON PID metadata`,
                    }),
                ),
            );
            // Distinct remote namespaces prove same-host agents cannot contend for agent.pid.
            expect(metadata.map((entry) => entry.agent_app_name)).toEqual(
                agentAppNames,
            );
            expect(new Set(metadata.map((entry) => entry.pid)).size).toBe(2);
            const firstMetadata = metadata[0];
            if (firstMetadata === undefined) {
                throw new Error(
                    "Foreground relay metadata unexpectedly missing",
                );
            }
            // The first runtime record proves the non-daemon command itself owns the watchdog.
            expect(firstMetadata.pid).toBe(foregroundRelayPid);

            const connected = await waitForValue({
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    const selected = agentNames.map((name) =>
                        agents.find(
                            (agent) =>
                                agent.name === name &&
                                agent.status === "connected",
                        ),
                    );
                    return selected.every((agent) => agent !== undefined)
                        ? selected
                        : undefined;
                },
                timeoutMs: 60_000,
                description: "both relay agents to connect",
            });
            for (const [index, agent] of connected.entries()) {
                if (agent === undefined) {
                    throw new Error(
                        "connected relay agent unexpectedly missing",
                    );
                }
                const message = `through-${relayIds[index]}`;
                const response = await agent.echo(message);
                // Echo proves REST control traffic traverses each independent SSH relay.
                expect(response.message).toBe(message);

                const payload = randomBytes(64 * 1024 + index);
                const remotePath = `${remoteRoot}/${relayIds[index]}/round-trip.bin`;
                await agent.upload(
                    remotePath,
                    new File([payload], "round-trip.bin", {
                        type: "application/octet-stream",
                    }),
                );
                const downloaded = Buffer.from(await agent.raw(remotePath));
                // A byte-exact round trip exercises streamed upload and download over this relay.
                expect(Buffer.compare(downloaded, payload)).toBe(0);
            }

            const originalConnectionIds = connected.map(
                (agent) => agent?.connectionId,
            );
            for (const [index, agentAppName] of agentAppNames.entries()) {
                await killRemoteAgent(agentAppName);
                const replacement = await waitForValue({
                    predicate: async () =>
                        (await apiClient.listAgents()).find(
                            (agent) =>
                                agent.name === agentNames[index] &&
                                agent.status === "connected" &&
                                agent.connectionId !==
                                    originalConnectionIds[index],
                        ),
                    timeoutMs: 30_000,
                    description: `${relayIds[index]} relay watchdog to reconnect its agent`,
                });
                const response = await replacement.echo(
                    `restarted-${relayIds[index]}`,
                );
                // A fresh usable connection proves foreground and daemon relays both supervise SSH exits.
                expect(response.message).toBe(`restarted-${relayIds[index]}`);
                const currentMetadata = relayPidMetadataSchema.parse(
                    JSON.parse(
                        readFileSync(
                            join(
                                home,
                                ".local",
                                "share",
                                appName,
                                "relays",
                                `${relayIds[index]}.pid`,
                            ),
                            "utf8",
                        ),
                    ),
                );
                const originalMetadata = metadata[index];
                if (originalMetadata === undefined) {
                    throw new Error(
                        "Original relay metadata unexpectedly missing",
                    );
                }
                // Retry happens inside the same locked relay process rather than a replacement daemon.
                expect(currentMetadata.pid).toBe(originalMetadata.pid);
            }

            await relayCommand({
                home,
                appName,
                args: ["agent", "relay", "stop", relayIds[0]],
            });
            const survivingAgent = await waitForValue({
                predicate: async () => {
                    const agents = await apiClient.listAgents();
                    return agents.find(
                        (agent) =>
                            agent.name === agentNames[1] &&
                            agent.status === "connected",
                    );
                },
                timeoutMs: 20_000,
                description: "second relay to survive first relay shutdown",
            });
            const response = await survivingAgent.echo("still-connected");
            // Independent local and remote PID namespaces keep the second relay usable.
            expect(response.message).toBe("still-connected");

            await relayCommand({
                home,
                appName,
                args: ["agent", "relay", "stop", relayIds[1]],
            });
        }, 120_000);
    },
);

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")(
    "TOML-managed SSH agents",
    () => {
        test("starts, controls, and restarts an [[agents]] entry through redoor-ssh-test", async () => {
            const processManager = new ProcessManager();
            const home = mkdtempSync(
                join(tmpdir(), "redoor-managed-ssh-integration-"),
            );
            const suffix = `${process.pid}-${Date.now()}`;
            const appName = `redoor-managed-ssh-test-${suffix}`;
            const agentName = `managed-ssh-test-${suffix}`;
            const remoteRoot = `/tmp/redoor-managed-ssh-test-${suffix}`;
            const configPath = join(home, "config.toml");
            const agentLogPath = join(home, "managed-agent.log");
            writeFileSync(
                configPath,
                `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
name = "${agentName}"
home = "${remoteRoot}"
log = "${agentLogPath}"
`,
            );

            onTestFinished(async () => {
                processManager.killAll();
                try {
                    await cleanupSshTest({
                        remoteRoot,
                        agentAppNames: [appName],
                    });
                } finally {
                    rmSync(home, { recursive: true, force: true });
                }
            });

            // Clear artifacts from an interrupted run before the server can prepare the host.
            await cleanupSshTest({
                remoteRoot,
                agentAppNames: [appName],
            });
            await sshTestCommand(`mkdir -p ${shellQuote(remoteRoot)}`);
            const serverPid = processManager.spawn(
                SERVER_PATH,
                ["server", "--config", configPath],
                {
                    env: {
                        ...process.env,
                        HOME: home,
                        REDOOR_APP_NAME: appName,
                    },
                },
            );
            await waitForPort(VITEST_SERVER_PORT);
            const apiClient = new ApiClient(
                `http://127.0.0.1:${VITEST_SERVER_PORT}`,
            );
            await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

            const configuredAgent = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) => agent.name === agentName,
                    ),
                description: "managed SSH agent inventory registration",
            });
            // TOML registration must remain dormant until an explicit REST lifecycle request.
            expect(configuredAgent.managed).toBe(true);
            expect(configuredAgent.status).toBe("stopped");
            expect(configuredAgent.cwd).toBe(remoteRoot);

            await configuredAgent.start();
            const firstConnection = await waitForValue({
                predicate: async () => {
                    const agent = (await apiClient.listAgents()).find(
                        (entry) => entry.name === agentName,
                    );
                    if (agent?.connectionId) {
                        return agent;
                    }
                    throw new Error(
                        `status=${agent?.status ?? "missing"}, issue=${agent?.connectionIssue ?? "none"}, server=${processManager.getStdout(serverPid)}`,
                    );
                },
                timeoutMs: 60_000,
                description: "managed SSH agent to connect",
            });
            const firstConnectionId = firstConnection.connectionId;
            if (firstConnectionId === null) {
                throw new Error(
                    "Connected managed SSH agent has no connection ID",
                );
            }
            const echo = await firstConnection.echo("managed-through-ssh");
            // A successful command proves control traffic reaches the TOML-managed remote process.
            expect(echo.message).toBe("managed-through-ssh");

            const payload = randomBytes(64 * 1024 + 1);
            const remotePath = `${remoteRoot}/round-trip.bin`;
            await firstConnection.upload(
                remotePath,
                new File([payload], "round-trip.bin", {
                    type: "application/octet-stream",
                }),
            );
            const downloaded = Buffer.from(
                await firstConnection.raw(remotePath),
            );
            // Byte equality exercises streamed upload and download over the managed SSH tunnel.
            expect(Buffer.compare(downloaded, payload)).toBe(0);

            const shutdown = await firstConnection.shutdown();
            // Managed shutdown retains configured inventory while reaping the SSH child.
            expect(shutdown.agent.managed).toBe(true);
            expect(shutdown.agent.status).toBe("stopped");
            const stoppedAgent = (await apiClient.listAgents()).find(
                (agent) => agent.name === agentName,
            );
            if (stoppedAgent === undefined) {
                throw new Error("Stopped managed SSH agent disappeared");
            }
            await stoppedAgent.start();

            const replacement = await waitForValue({
                predicate: async () => {
                    const agent = (await apiClient.listAgents()).find(
                        (entry) =>
                            entry.name === agentName &&
                            entry.status === "connected" &&
                            entry.connectionId !== firstConnectionId,
                    );
                    return agent;
                },
                timeoutMs: 60_000,
                description: "managed SSH agent to reconnect after restart",
            });
            const restartedEcho = await replacement.echo("managed-restarted");
            // A new usable connection proves the watchdog can respawn the prepared SSH agent.
            expect(restartedEcho.message).toBe("managed-restarted");
        }, 120_000);
    },
);

describe.skipIf(
    process.env.REDOOR_SSH_TEST !== "1" ||
        !process.env.REDOOR_SSH_TEST_PASSWORD,
)("TOML-managed SSH agents with password auth", () => {
    test("starts an [[agents]] entry as redoor-password", async () => {
        const processManager = new ProcessManager();
        const home = mkdtempSync(
            join(tmpdir(), "redoor-managed-ssh-password-"),
        );
        const suffix = `${process.pid}-${Date.now()}`;
        const appName = `redoor-managed-ssh-password-${suffix}`;
        const agentName = `managed-ssh-password-${suffix}`;
        const remoteRoot = `/tmp/redoor-managed-ssh-password-${suffix}`;
        const configPath = join(home, "config.toml");
        const agentLogPath = join(home, "managed-agent.log");
        const sshPassword = process.env.REDOOR_SSH_TEST_PASSWORD;
        if (sshPassword === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }
        writeFileSync(
            configPath,
            `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_PASSWORD_USER}"
password = ${JSON.stringify(sshPassword)}
name = "${agentName}"
home = "${remoteRoot}"
log = "${agentLogPath}"
`,
        );

        onTestFinished(async () => {
            processManager.killAll();
            try {
                await cleanupSshTest({
                    remoteRoot,
                    agentAppNames: [appName],
                    sshCommand: sshPasswordTestCommand,
                });
            } finally {
                rmSync(home, { recursive: true, force: true });
            }
        });

        // Password-user artifacts live in a different home than the key-auth user.
        await cleanupSshTest({
            remoteRoot,
            agentAppNames: [appName],
            sshCommand: sshPasswordTestCommand,
        });
        await sshPasswordTestCommand(`mkdir -p ${shellQuote(remoteRoot)}`);
        const serverPid = processManager.spawn(
            SERVER_PATH,
            ["server", "--config", configPath],
            {
                env: {
                    ...process.env,
                    HOME: home,
                    REDOOR_APP_NAME: appName,
                },
            },
        );
        await waitForPort(VITEST_SERVER_PORT);
        const apiClient = new ApiClient(
            `http://127.0.0.1:${VITEST_SERVER_PORT}`,
        );
        await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

        const configuredAgent = await waitForValue({
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) => agent.name === agentName,
                ),
            description: "password SSH agent inventory registration",
        });
        expect(configuredAgent.managed).toBe(true);
        expect(configuredAgent.status).toBe("stopped");

        await configuredAgent.start();
        const connected = await waitForValue({
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === agentName,
                );
                if (agent?.connectionId) {
                    return agent;
                }
                throw new Error(
                    `status=${agent?.status ?? "missing"}, issue=${agent?.connectionIssue ?? "none"}, server=${processManager.getStdout(serverPid)}`,
                );
            },
            timeoutMs: 60_000,
            description: "password SSH agent to connect",
        });
        const echo = await connected.echo("managed-through-password-ssh");
        // Echo proves sniff, binary upload, and the long-lived session all used askpass.
        expect(echo.message).toBe("managed-through-password-ssh");
    }, 120_000);
});

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")(
    "TOML-managed SSH authentication errors",
    () => {
        test("reports a missing password promptly and remains controllable", async () => {
            const processManager = new ProcessManager();
            const home = mkdtempSync(join(tmpdir(), "redoor-managed-ssh-no-password-"));
            const suffix = `${process.pid}-${Date.now()}`;
            const appName = `redoor-managed-ssh-no-password-${suffix}`;
            const agentName = `managed-ssh-no-password-${suffix}`;
            const remoteRoot = `/tmp/redoor-managed-ssh-no-password-${suffix}`;
            const configPath = join(home, "config.toml");
            writeFileSync(
                configPath,
                `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_PASSWORD_USER}"
name = "${agentName}"
home = "${remoteRoot}"
`,
            );

            onTestFinished(() => {
                processManager.killAll();
                rmSync(home, { recursive: true, force: true });
            });

            const serverPid = processManager.spawn(
                SERVER_PATH,
                ["server", "--config", configPath],
                {
                    env: {
                        ...process.env,
                        HOME: home,
                        REDOOR_APP_NAME: appName,
                    },
                },
            );
            await waitForPort(VITEST_SERVER_PORT);
            const apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
            await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
            const configuredAgent = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find((agent) => agent.name === agentName),
                description: "password-only agent inventory registration",
            });

            await configuredAgent.start();
            const failed = await waitForValue({
                predicate: async () => {
                    const agent = (await apiClient.listAgents()).find(
                        (entry) => entry.name === agentName,
                    );
                    return agent?.connectionIssue ? agent : undefined;
                },
                timeoutMs: 15_000,
                description: "non-interactive SSH authentication issue",
            });
            // The REST issue must tell operators how to configure password-only hosts.
            expect(failed.connectionIssue).toContain(
                "Configure a password, SSH key, or ssh-agent credential",
            );
            // The failed startup remains desired-running so watchdog retries are visible.
            expect(failed.status).toBe("starting");
            const shutdown = await failed.shutdown();
            // Shutdown proves an SSH preparation failure does not block lifecycle control.
            expect(shutdown.agent.status).toBe("stopped");
            const serverOutput = processManager.getStdout(serverPid);
            // Neither the server token nor fixture password may leak into SSH diagnostics.
            expect(serverOutput).not.toContain(TEST_AGENT_TOKEN);
            if (process.env.REDOOR_SSH_TEST_PASSWORD) {
                expect(serverOutput).not.toContain(process.env.REDOOR_SSH_TEST_PASSWORD);
            }
        }, 60_000);
    },
);
