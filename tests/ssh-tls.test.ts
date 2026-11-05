import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    trustSelfSignedCertificate,
    waitForPort,
    waitForValue,
} from "./test-utils";
import {
    SSH_TEST_HOST,
    SSH_TEST_USER,
    cleanupSshTest,
    shellQuote,
    sshTestCommand,
} from "./ssh-test-utils";

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")(
    "SSH-backed agents of a server with built-in HTTPS",
    () => {
        test("connects an [[agents]] entry over wss:// through the tunnel when the server uses a self-signed certificate", async () => {
            const processManager = new ProcessManager();

            const home = mkdtempSync(join(tmpdir(), "redoor-managed-ssh-tls-"));

            const suffix = `${process.pid}-${Date.now()}`;
            const appName = `redoor-managed-ssh-tls-${suffix}`;
            const agentName = `managed-ssh-tls-${suffix}`;
            const remoteRoot = `/tmp/redoor-managed-ssh-tls-${suffix}`;
            const configPath = join(home, "config.toml");

            writeFileSync(
                configPath,
                `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[server.tls]
self_signed = true

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
name = "${agentName}"
`,
            );

            onTestFinished(async () => {
                await processManager.killAll();

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

            processManager.spawn(
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

            const trusted = await trustSelfSignedCertificate({ home, appName });

            onTestFinished(trusted.restore);
            await waitForPort(VITEST_SERVER_PORT, 30_000, "https");

            const apiClient = new ApiClient(
                `https://127.0.0.1:${VITEST_SERVER_PORT}`,
            );

            await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

            const configuredAgent = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) => agent.name === agentName,
                    ),
                description: "managed SSH agent inventory registration",
            });

            await configuredAgent.start();

            const connected = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) =>
                            agent.name === agentName &&
                            agent.status === "connected",
                    ),
                timeoutMs: 60_000,
                description: "managed SSH agent to connect over TLS",
            });

            const echo = await connected.echo("managed-tls");

            // A working command proves the TLS connection through the tunnel carries traffic.
            expect(echo.message).toBe("managed-tls");

            // The remote daemon must speak wss:// to the TLS listener, keeping the server's
            // port as its logical address while its stream goes through the tunnel socket.
            // It logs into its own namespace on the device.
            const daemonLog = await sshTestCommand(
                `cat "$HOME/.local/share/${appName}-${connected.id}/agent.log"`,
            );

            expect(daemonLog).toContain(
                `ws=wss://localhost:${VITEST_SERVER_PORT}/api/v1/agent/ws`,
            );
        }, 120_000);
    },
);
