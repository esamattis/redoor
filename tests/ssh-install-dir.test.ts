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
    "TOML-managed SSH install directory",
    () => {
        test("refuses a noexec install directory before uploading and installs into the configured one", async () => {
            const processManager = new ProcessManager();

            const home = mkdtempSync(
                join(tmpdir(), "redoor-managed-ssh-install-dir-"),
            );

            const suffix = `${process.pid}-${Date.now()}`;
            const appName = `redoor-install-dir-test-${suffix}`;
            const agentName = `install-dir-test-${suffix}`;
            // `/run/lock` is a noexec tmpfs on the SSH test host, like the home on TrueNAS.
            const noexecDir = `/run/lock/redoor-install-dir-test-${suffix}`;
            const remoteRoot = `/tmp/redoor-install-dir-test-${suffix}`;
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
username = "${SSH_TEST_USER}"
name = "${agentName}"
install_dir = "${noexecDir}"
`,
            );

            const cleanupRemote = async () => {
                await cleanupSshTest({ remoteRoot, agentAppNames: [appName] });
                await sshTestCommand(`rm -rf ${shellQuote(noexecDir)}`);
            };

            onTestFinished(async () => {
                await processManager.killAll();

                try {
                    await cleanupRemote();
                } finally {
                    rmSync(home, { recursive: true, force: true });
                }
            });

            // Clear artifacts from an interrupted run before the server can prepare the host.
            await cleanupRemote();

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
                description: "install directory agent inventory registration",
            });

            await configuredAgent.start();
            const seenProvisioning = new Set<string>();

            const failed = await waitForValue({
                predicate: async () => {
                    const agent = (await apiClient.listAgents()).find(
                        (entry) => entry.name === agentName,
                    );

                    // A failed attempt's steps move to lastFailedAttempt.
                    for (const step of [
                        ...(agent?.provisioningStatus ?? []),
                        ...(agent?.lastFailedAttempt?.messages ?? []),
                    ]) {
                        seenProvisioning.add(step.message);
                    }

                    return agent?.connectionIssue?.includes("noexec")
                        ? agent
                        : undefined;
                },
                timeoutMs: 30_000,
                description: "noexec install directory issue",
            });

            // The issue names the mount and the setting that fixes it, instead of the kernel's
            // bare "Permission denied" after an upload.
            expect(failed.connectionIssue).toContain(
                "/run/lock, which is mounted noexec",
            );
            expect(failed.connectionIssue).toContain(noexecDir);
            expect(failed.connectionIssue).toContain("install directory");
            // The probe catches the mount first, so nothing is uploaded that could never run.
            expect(
                [...seenProvisioning].some((message) =>
                    message.startsWith("Uploading the binary to "),
                ),
            ).toBe(false);
            expect(
                (
                    await sshTestCommand(
                        `test -e ${shellQuote(noexecDir)} && echo exists || echo absent`,
                    )
                ).trim(),
            ).toBe("absent");

            await failed.shutdown();
            await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) =>
                            agent.name === agentName &&
                            agent.status === "stopped",
                    ),
                description: "failed install directory agent to stop",
            });

            await apiClient.updateSshAgent(configuredAgent.id, {
                target: SSH_TEST_HOST,
                username: SSH_TEST_USER,
                ssh_port: null,
                name: agentName,
                install_dir: remoteRoot,
                password: null,
                clear_password: null,
            });

            const edited = await waitForValue({
                predicate: async () =>
                    (await apiClient.listAgents()).find(
                        (agent) =>
                            agent.name === agentName &&
                            agent.status === "stopped",
                    ),
                description: "edited install directory agent registration",
            });

            await edited.start();

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
                description: "install directory agent to connect",
            });

            // A working control channel proves the agent runs from the configured directory.
            expect((await connected.echo("install-dir")).message).toBe(
                "install-dir",
            );

            // The binary is installed below the configured directory, in this server's
            // namespace, rather than in the home directory.
            const installed = await sshTestCommand(
                `ls ${shellQuote(`${remoteRoot}/${appName}/binaries`)}`,
            );

            expect(installed.trim()).not.toBe("");
        }, 120_000);
    },
);
