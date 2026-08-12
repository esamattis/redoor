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

/** Stops any orphaned remote agent and removes only this test's isolated files. */
async function cleanupRelayDev(options: {
    remoteRoot: string;
    agentAppNames: string[];
}): Promise<void> {
    const appNames = options.agentAppNames.map(shellQuote).join(" ");
    const command = `for app in ${appNames}; do pid_file="$HOME/.local/share/$app/agent.pid"; if [ -f "$pid_file" ]; then pid=$(tr -d '[:space:]' < "$pid_file"); case "$pid" in *[!0-9]*|'') ;; *) kill "$pid" 2>/dev/null || true ;; esac; fi; rm -rf "$HOME/.local/share/$app"; done; rm -rf ${shellQuote(options.remoteRoot)}`;
    await execFileAsync("ssh", ["relay-dev", command]);
}

describe.skipIf(process.env.REDOOR_RELAY_DEV !== "1")(
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
target = "relay-dev"
server = "http://127.0.0.1:${VITEST_SERVER_PORT}"
name = "${agentNames[0]}"
agent_app_name = "${agentAppNames[0]}"
remote_bin = "${remoteRoot}/${relayIds[0]}/redoor"
binary_source = "${SERVER_PATH}"
home = "${remoteRoot}/${relayIds[0]}"
log = "${join(localLogDirectory, `${relayIds[0]}.log`)}"

[[relays]]
id = "${relayIds[1]}"
target = "relay-dev"
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
                    await cleanupRelayDev({ remoteRoot, agentAppNames });
                } finally {
                    processManager.killAll();
                    rmSync(home, { recursive: true, force: true });
                }
            });

            // Remove artifacts from an interrupted run before starting remote processes.
            await cleanupRelayDev({ remoteRoot, agentAppNames });
            processManager.spawnServer({ config: configPath });
            await waitForPort(VITEST_SERVER_PORT);
            const apiClient = new ApiClient(
                `http://127.0.0.1:${VITEST_SERVER_PORT}`,
            );
            await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

            for (const id of relayIds) {
                await relayCommand({
                    home,
                    appName,
                    args: [
                        "agent",
                        "relay",
                        "start",
                        id,
                        "--config",
                        configPath,
                        "--daemon",
                    ],
                });
            }

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
