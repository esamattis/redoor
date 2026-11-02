import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import type { CreateLocalAgentRequest } from "#bindings/CreateLocalAgentRequest";
import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import type { UpdateLocalAgentRequest } from "#bindings/UpdateLocalAgentRequest";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    DEVICE_ID_REGEXP,
    restartServerAndWait,
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
        ...overrides,
    };
}

/** Builds the generated update contract independently from the create request type. */
function localUpdateRequest(
    overrides: Partial<UpdateLocalAgentRequest> = {},
): UpdateLocalAgentRequest {
    return {
        name: null,
        home: null,
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
        password: null,
        clear_password: null,
        ...overrides,
    };
}

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

let apiClient: ApiClient;

let configPath: string;

let serverLog: string;

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
    serverLog = tempFiles.tempFile({ suffix: ".log" });
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
        });

        // The response must be immediately usable without restarting the server.
        expect(response.agent).toMatchObject({
            // The server creates an opaque id for the new device; the name stays separate.
            id: expect.stringMatching(DEVICE_ID_REGEXP),
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
            inventory.find((agent) => agent.name === SSH_FIXTURE_NAME)?.sshTarget,
        ).toBe("fixture-host");
        expect(
            inventory.find((agent) => agent.name === AGENT_NAME)?.sshTarget,
        ).toBeNull();
        expect(
            inventory.find((agent) => agent.name === AGENT_NAME)
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
        // The id is created on add and stored with the entry, so it survives restarts.
        expect(editedConfig).toContain(`id = "${response.agent.id}"`);

        await restartServerAndWait({ apiClient, serverLog });

        const afterRestart = await apiClient.listAgents();

        // The reloaded entry is the same device, not a new one with the same name.
        expect(
            afterRestart.find((agent) => agent.name === AGENT_NAME)?.id,
        ).toBe(response.agent.id);

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
        });

        const renamed = "updated-local-agent";

        const configuredAgent = (await apiClient.listAgents()).find(
            (agent) => agent.name === AGENT_NAME,
        );

        if (!configuredAgent) throw new Error("Created local agent missing");
        await configuredAgent.start();

        const updateRequest: UpdateLocalAgentRequest = {
            name: renamed,
            home: "/srv/updated-local",
        };

        const update = await apiClient.updateLocalAgent(
            AGENT_NAME,
            updateRequest,
        );

        // Save must settle a delayed restart before applying the rename, rather than racing it.
        // A rename changes only the name; the id stays so stored references keep working.
        expect(update.agent).toMatchObject({
            id: configuredAgent.id,
            name: renamed,
            cwd: "/srv/updated-local",
            status: "stopped",
            configuration_editable: true,
            ssh_target: null,
        });
        const inventory = await apiClient.listAgents();
        expect(inventory.some((agent) => agent.name === AGENT_NAME)).toBe(false);
        expect(inventory.some((agent) => agent.name === renamed)).toBe(true);
        const afterUpdate = await apiClient.getLocalAgentConfiguration(renamed);
        expect(afterUpdate.home).toBe("/srv/updated-local");
        const editedConfig = readFileSync(configPath, "utf8");
        // Updating must preserve unrelated comments while replacing old local values.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain("local = true");
        expect(editedConfig).toContain(`name = "${renamed}"`);
        expect(editedConfig).not.toContain(`name = "${AGENT_NAME}"`);
        // The edit handler rebuilds the entry, so it must carry the id over explicitly.
        expect(editedConfig).toContain(`id = "${configuredAgent.id}"`);

        const deletion = await apiClient.deleteManagedAgent(renamed, "local");
        expect(deletion.deleted).toBe(true);
        // Deletion must remove both durable TOML and retained runtime inventory.
        expect(
            (await apiClient.listAgents()).some(
                (agent) => agent.name === renamed,
            ),
        ).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(
            `name = "${renamed}"`,
        );
    });

    it("keeps the id in config.toml when another field is edited", async () => {
        const name = "local-edit-keeps-id";

        const created = await apiClient.createLocalAgent(
            localRequest({ name, home: "/srv/before" }),
        );

        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(created.agent.id, "local");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const update = await apiClient.updateLocalAgent(
            created.agent.id,
            localUpdateRequest({
                name,
                home: "/srv/after",
            }),
        );

        // Editing by id works, and the device keeps its id while its settings change.
        expect(update.agent).toMatchObject({
            id: created.agent.id,
            name,
            cwd: "/srv/after",
        });

        const table = readFileSync(configPath, "utf8")
            .split("[[agents]]")
            .find((entry) => entry.includes(`name = "${name}"`));

        // The rewritten entry still carries the original id, so the next startup does not
        // assign a new one and break token scopes.
        expect(table).toContain(`id = "${created.agent.id}"`);
        // The edit itself was applied to the same entry.
        expect(table).toContain('home = "/srv/after"');
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
                localUpdateRequest({ name: missing }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(apiClient.deleteManagedAgent(missing, "local")).rejects.toMatchObject(
            { status: 404 } satisfies Partial<ApiError>,
        );
        // SSH agents are managed but must stay out of the local configuration API.
        await expect(
            apiClient.getLocalAgentConfiguration(SSH_FIXTURE_NAME),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateLocalAgent(
                SSH_FIXTURE_NAME,
                localUpdateRequest({
                    name: SSH_FIXTURE_NAME,
                    home: "/converted",
                }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.deleteManagedAgent(SSH_FIXTURE_NAME, "local"),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);

        const ssh = (await apiClient.listAgents()).find(
            (agent) => agent.name === SSH_FIXTURE_NAME,
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
            try {
                await apiClient.deleteManagedAgent(originalName, "local");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }

            try {
                await apiClient.deleteManagedAgent(takenName, "ssh");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const original = (await apiClient.listAgents()).find(
            (agent) => agent.name === originalName,
        );

        if (!original) throw new Error("Rename source agent missing");
        await original.start();
        // Start is accepted immediately so uniqueness can be checked while desired-running is true.
        expect(
            (await apiClient.listAgents()).find(
                (agent) => agent.name === originalName,
            )?.status,
        ).not.toBe("stopped");

        await expect(
            apiClient.updateLocalAgent(
                originalName,
                localUpdateRequest({ name: takenName }),
            ),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);

        const afterConflict = (await apiClient.listAgents()).find(
            (agent) => agent.name === originalName,
        );

        // A 409 must not leave the original stopped after a uniqueness failure.
        expect(afterConflict?.status).not.toBe("stopped");
        expect(
            (await apiClient.listAgents()).some(
                (agent) => agent.name === takenName,
            ),
        ).toBe(true);
    });

    it("stops a desired-running local agent before deleting it", async () => {
        const name = "delete-running-local-agent";
        await apiClient.createLocalAgent(localRequest({ name }));
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "local");
            } catch {
                // Cleanup must tolerate a successful delete leaving nothing behind.
            }
        });

        const created = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        if (!created) throw new Error("Delete-running local agent missing");
        await created.start();
        // The API must accept delete while desired-running instead of asking the client to stop first.
        expect(
            (await apiClient.listAgents()).find((agent) => agent.name === name)
                ?.status,
        ).not.toBe("stopped");

        const deletion = await apiClient.deleteManagedAgent(name, "local");
        expect(deletion.deleted).toBe(true);
        // Both inventory and TOML must be gone after an auto-stop delete.
        expect(
            (await apiClient.listAgents()).some((agent) => agent.name === name),
        ).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(
            `name = "${name}"`,
        );
    });

    it("publishes only daemon steps, never SSH steps, for a local managed agent", async () => {
        const name = "local-silent-provisioning";
        await apiClient.createLocalAgent(localRequest({ name }));
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "local");
            } catch {
                // Cleanup must tolerate a successful delete leaving nothing behind.
            }
        });

        const created = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        if (!created)
            throw new Error("Local silent-provisioning agent missing");
        await created.start();

        const connected = await waitForValue({
            timeoutMs: 15_000,
            description: "local managed agent to connect",
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === name,
                );

                return agent?.status === "connected" &&
                    agent.provisioningStatus.some(
                        (step) => step.message === "Connected",
                    )
                    ? agent
                    : undefined;
            },
        });

        const messages = connected.provisioningStatus.map(
            (step) => step.message,
        );

        // A local start has no sniff, download or upload, only the daemon's ensure step.
        expect(messages.some((message) => /SSH|sniff|upload/i.test(message))).toBe(
            false,
        );
        // The ensure step says what it did with the daemon.
        expect(
            messages.some((message) =>
                message.startsWith("Started the agent daemon"),
            ),
        ).toBe(true);
    }, 20_000);
});
