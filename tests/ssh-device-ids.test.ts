import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { ApiClient } from "#ui/api-client";
import {
    DEVICE_ID_PATTERN,
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

/** One TOML-managed SSH server fixture whose entries all target the shared SSH test host. */
type ManagedSshFixture = {
    apiClient: ApiClient;
    configPath: string;
    processManager: ProcessManager;
    serverPid: number;
};

/**
 * Starts a server whose `[[agents]]` entries (written without ids) all target the SSH test
 * host as the same user, and removes every remote and local artifact when the test ends.
 */
async function startManagedSshFixture(options: {
    appName: string;
    remoteRoot: string;
    agentNames: string[];
}): Promise<ManagedSshFixture> {
    const processManager = new ProcessManager();
    const home = mkdtempSync(join(tmpdir(), "redoor-ssh-device-ids-"));
    const configPath = join(home, "config.toml");

    const entries = options.agentNames
        .map(
            (name) => `[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
name = "${name}"
home = "${options.remoteRoot}"
log = "${join(home, `${name}.log`)}"
`,
        )
        .join("\n");

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

${entries}`,
    );

    onTestFinished(async () => {
        await processManager.killAll();

        try {
            await cleanupSshTest({
                remoteRoot: options.remoteRoot,
                agentAppNames: [options.appName],
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    // Clear artifacts from an interrupted run before the server can prepare the host.
    await cleanupSshTest({
        remoteRoot: options.remoteRoot,
        agentAppNames: [options.appName],
    });
    await sshTestCommand(`mkdir -p ${shellQuote(options.remoteRoot)}`);

    const serverPid = processManager.spawn(
        SERVER_PATH,
        ["server", "--config", configPath],
        {
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: options.appName,
            },
        },
    );

    await waitForPort(VITEST_SERVER_PORT);

    const apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    return { apiClient, configPath, processManager, serverPid };
}

/** Reads the id startup wrote into the `[[agents]]` entry called `name`. */
function configuredDeviceId(
    configPath: string,
    name: string,
): string | undefined {
    const entry = readFileSync(configPath, "utf8")
        .split("[[agents]]")
        .find((table) => table.includes(`name = "${name}"`));

    return entry?.match(new RegExp(`^id = "(${DEVICE_ID_PATTERN})"`, "m"))?.[1];
}

/** Starts the managed SSH agent called `name` and waits for a connection newer than `previous`. */
async function startAndWaitForSshConnection(
    fixture: ManagedSshFixture,
    name: string,
    previousConnectionId: string | null = null,
) {
    const configured = (await fixture.apiClient.listAgents()).find(
        (agent) => agent.name === name,
    );

    if (configured === undefined)
        throw new Error(`Managed SSH agent ${name} missing`);
    await configured.start();

    return waitForValue({
        predicate: async () => {
            const agent = (await fixture.apiClient.listAgents()).find(
                (entry) => entry.name === name,
            );

            if (
                agent?.status === "connected" &&
                agent.connectionId !== null &&
                agent.connectionId !== previousConnectionId
            ) {
                return agent;
            }

            if (agent?.connectionIssue) {
                throw new Error(
                    `issue=${agent.connectionIssue}, server=${fixture.processManager.getStdout(fixture.serverPid)}`,
                );
            }

            return undefined;
        },
        timeoutMs: 60_000,
        description: `managed SSH agent ${name} to connect`,
    });
}

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")("SSH device ids", () => {
    test("connects two [[agents]] entries on the same user@host at once with different ids", async () => {
        const suffix = `${process.pid}-${Date.now()}`;
        const names = [`ssh-ids-first-${suffix}`, `ssh-ids-second-${suffix}`];

        const fixture = await startManagedSshFixture({
            appName: `redoor-ssh-ids-pair-${suffix}`,
            remoteRoot: `/tmp/redoor-ssh-ids-pair-${suffix}`,
            agentNames: names,
        });

        const connected = await Promise.all(
            names.map((name) => startAndWaitForSshConnection(fixture, name)),
        );

        const connectedIds = connected.map((agent) => agent.id);

        // Entries sharing one remote data dir must not share an id file, so the server
        // gives each its own id ...
        expect(new Set(connectedIds).size).toBe(2);
        // ... which is the one it wrote into the entry at startup.
        expect(connectedIds).toEqual(
            names.map((name) => configuredDeviceId(fixture.configPath, name)),
        );

        const inventory = await fixture.apiClient.listAgents();

        // Both stay connected at the same time instead of replacing each other.
        expect(
            names.map(
                (name) =>
                    inventory.find((agent) => agent.name === name)?.status,
            ),
        ).toEqual(["connected", "connected"]);

        for (const [index, agent] of connected.entries()) {
            // Each connection answers for its own device.
            expect((await agent.echo(`pair-${index}`)).message).toBe(
                `pair-${index}`,
            );
        }
    }, 120_000);
});
