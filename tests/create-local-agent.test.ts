import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import type { CreateLocalAgentRequest } from "#bindings/CreateLocalAgentRequest";
import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import { ApiClient, ApiError } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "created-local-agent";
const SSH_FIXTURE_NAME = "ssh-fixture-agent";

/** Builds a complete local payload so tests only override the field under assertion. */
function localRequest(
    overrides: Partial<CreateLocalAgentRequest> = {},
): CreateLocalAgentRequest {
    return {
        name: null,
        home: null,
        log: null,
        ...overrides,
    };
}

/** Builds a complete SSH payload so uniqueness tests can create a colliding identity. */
function sshRequest(
    overrides: Partial<CreateSshAgentRequest> &
        Pick<CreateSshAgentRequest, "target">,
): CreateSshAgentRequest {
    return {
        username: null,
        ssh_port: null,
        name: null,
        remote_bin: null,
        home: null,
        log: null,
        password: null,
        clear_password: null,
        ...overrides,
    };
}

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
let apiClient: ApiClient;
let configPath: string;

beforeAll(async () => {
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    writeFileSync(
        configPath,
        `# This comment must survive the config edit.
agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
target = "fixture-host"
name = "${SSH_FIXTURE_NAME}"
`,
    );
    const serverLog = tempFiles.tempFile({ suffix: ".log" });
    rmSync(serverLog, { force: true });
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processManager.spawnServer({ config: configPath, log: serverLog });
    await waitForPort(VITEST_SERVER_PORT);
    apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
});

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

describe("Local agent configuration API", () => {
    it("persists and dynamically registers a local managed agent", async () => {
        const response = await apiClient.createLocalAgent({
            name: AGENT_NAME,
            home: "/srv/local",
            log: "/tmp/created-local-agent.log",
        });

        // The response must be immediately usable without restarting the server.
        expect(response.agent).toMatchObject({
            id: AGENT_NAME,
            name: AGENT_NAME,
            cwd: "/srv/local",
            managed: true,
            configuration_editable: true,
            ssh_target: null,
            status: "stopped",
        });
        const inventory = await apiClient.listAgents();
        // Dynamic reload must expose exactly one retained managed inventory record.
        expect(
            inventory.filter((agent) => agent.name === AGENT_NAME),
        ).toHaveLength(1);
        // SSH fixtures stay SSH and must not be rewritten by a local create.
        expect(
            inventory.find((agent) => agent.id === SSH_FIXTURE_NAME)?.sshTarget,
        ).toBe("fixture-host");
        expect(
            inventory.find((agent) => agent.id === AGENT_NAME)?.sshTarget,
        ).toBeNull();
        expect(
            inventory.find((agent) => agent.id === AGENT_NAME)
                ?.configurationEditable,
        ).toBe(true);

        const editedConfig = readFileSync(configPath, "utf8");
        // toml_edit must preserve unrelated operator comments while appending local fields.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain("local = true");
        expect(editedConfig).toContain(`name = "${AGENT_NAME}"`);
        expect(editedConfig).toContain('home = "/srv/local"');
        expect(editedConfig).toContain('log = "/tmp/created-local-agent.log"');

        await apiClient.restartServer();
        const afterRestart = await waitForValue({
            timeoutMs: 15_000,
            description: "created local agent after server restart",
            predicate: async () => {
                try {
                    const agents = await apiClient.listAgents();
                    return agents.some((agent) => agent.name === AGENT_NAME)
                        ? agents
                        : undefined;
                } catch {
                    return undefined;
                }
            },
        });
        // Persistence must reconstruct the same dormant agent after a full config reload.
        expect(
            afterRestart.find((agent) => agent.name === AGENT_NAME)?.status,
        ).toBe("stopped");
        expect(
            afterRestart.find((agent) => agent.name === AGENT_NAME)
                ?.configurationEditable,
        ).toBe(true);
    });

    it("rejects duplicate effective names without appending TOML", async () => {
        const before = readFileSync(configPath, "utf8");
        await expect(
            apiClient.createLocalAgent(localRequest({ name: AGENT_NAME })),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);
        await expect(
            apiClient.createLocalAgent(
                localRequest({ name: SSH_FIXTURE_NAME }),
            ),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);
        // Rejected submissions must not modify the durable source of truth.
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });

    it("reads, updates, renames, and deletes a stopped local entry", async () => {
        const configuration =
            await apiClient.getLocalAgentConfiguration(AGENT_NAME);
        // The edit view must receive the persisted optional fields for a local agent.
        expect(configuration).toMatchObject({
            name: AGENT_NAME,
            home: "/srv/local",
            log: "/tmp/created-local-agent.log",
        });

        const renamed = "updated-local-agent";
        const configuredAgent = (await apiClient.listAgents()).find(
            (agent) => agent.id === AGENT_NAME,
        );
        if (!configuredAgent) throw new Error("Created local agent missing");
        await configuredAgent.start();
        const update = await apiClient.updateLocalAgent(AGENT_NAME, {
            name: renamed,
            home: "/srv/updated-local",
            log: null,
        });
        // Save must settle a delayed restart before replacing the identity, rather than racing it.
        expect(update.agent).toMatchObject({
            id: renamed,
            cwd: "/srv/updated-local",
            status: "stopped",
            configuration_editable: true,
            ssh_target: null,
        });
        const inventory = await apiClient.listAgents();
        expect(inventory.some((agent) => agent.id === AGENT_NAME)).toBe(false);
        expect(inventory.some((agent) => agent.id === renamed)).toBe(true);
        const afterUpdate = await apiClient.getLocalAgentConfiguration(renamed);
        // Clearing optional paths on PUT must persist as omitted settings, not leftover values.
        expect(afterUpdate.log).toBeNull();
        expect(afterUpdate.home).toBe("/srv/updated-local");
        const editedConfig = readFileSync(configPath, "utf8");
        // Updating must preserve unrelated comments while replacing old local values.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain("local = true");
        expect(editedConfig).toContain(`name = "${renamed}"`);
        expect(editedConfig).not.toContain(`name = "${AGENT_NAME}"`);
        expect(editedConfig).not.toContain("/tmp/created-local-agent.log");

        const deletion = await apiClient.deleteManagedAgent(renamed);
        expect(deletion.deleted).toBe(true);
        // Deletion must remove both durable TOML and retained runtime inventory.
        expect(
            (await apiClient.listAgents()).some((agent) => agent.id === renamed),
        ).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(
            `name = "${renamed}"`,
        );
    });

    it("returns 404 for unknown and SSH agents without converting them", async () => {
        const missing = "missing-local-agent";
        // Unknown ids must not invent configuration, replace, or delete anything.
        await expect(
            apiClient.getLocalAgentConfiguration(missing),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateLocalAgent(
                missing,
                localRequest({ name: missing }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        // SSH agents are managed but must stay out of the local configuration API.
        await expect(
            apiClient.getLocalAgentConfiguration(SSH_FIXTURE_NAME),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateLocalAgent(
                SSH_FIXTURE_NAME,
                localRequest({ name: SSH_FIXTURE_NAME, home: "/converted" }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        const ssh = (await apiClient.listAgents()).find(
            (agent) => agent.id === SSH_FIXTURE_NAME,
        );
        // A rejected local mutation must not convert or remove the SSH fixture.
        expect(ssh?.managed).toBe(true);
        expect(ssh?.sshTarget).toBe("fixture-host");
        expect(readFileSync(configPath, "utf8")).toContain(
            `name = "${SSH_FIXTURE_NAME}"`,
        );
        expect(readFileSync(configPath, "utf8")).toContain(
            'target = "fixture-host"',
        );
        expect(readFileSync(configPath, "utf8")).not.toContain("/converted");
    });

    it("rejects a rename onto an existing id without stopping the original", async () => {
        const originalName = "local-rename-conflict-source";
        const takenName = "local-rename-conflict-taken";
        await apiClient.createLocalAgent(localRequest({ name: originalName }));
        await apiClient.createSshAgent(
            sshRequest({ target: "taken-host", name: takenName }),
        );
        onTestFinished(async () => {
            for (const name of [originalName, takenName]) {
                try {
                    await apiClient.deleteManagedAgent(name);
                } catch {
                    // Cleanup must tolerate an already-removed leftover from a failed assertion.
                }
            }
        });
        const original = (await apiClient.listAgents()).find(
            (agent) => agent.id === originalName,
        );
        if (!original) throw new Error("Rename source agent missing");
        await original.start();
        // Start is accepted immediately so uniqueness can be checked while desired-running is true.
        expect(
            (await apiClient.listAgents()).find(
                (agent) => agent.id === originalName,
            )?.status,
        ).not.toBe("stopped");

        await expect(
            apiClient.updateLocalAgent(
                originalName,
                localRequest({ name: takenName }),
            ),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);

        const afterConflict = (await apiClient.listAgents()).find(
            (agent) => agent.id === originalName,
        );
        // A 409 must not leave the original stopped after a uniqueness failure.
        expect(afterConflict?.status).not.toBe("stopped");
        expect(
            (await apiClient.listAgents()).some(
                (agent) => agent.id === takenName,
            ),
        ).toBe(true);
    });

    it("stops a desired-running local agent before deleting it", async () => {
        const name = "delete-running-local-agent";
        await apiClient.createLocalAgent(localRequest({ name }));
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name);
            } catch {
                // Cleanup must tolerate a successful delete leaving nothing behind.
            }
        });
        const created = (await apiClient.listAgents()).find(
            (agent) => agent.id === name,
        );
        if (!created) throw new Error("Delete-running local agent missing");
        await created.start();
        // The API must accept delete while desired-running instead of asking the client to stop first.
        expect(
            (await apiClient.listAgents()).find((agent) => agent.id === name)
                ?.status,
        ).not.toBe("stopped");

        const deletion = await apiClient.deleteManagedAgent(name);
        expect(deletion.deleted).toBe(true);
        // Both inventory and TOML must be gone after an auto-stop delete.
        expect(
            (await apiClient.listAgents()).some((agent) => agent.id === name),
        ).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(
            `name = "${name}"`,
        );
    });
});
