import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

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

const AGENT_NAME = "created-ssh-agent";
const LOCAL_AGENT_NAME = "local-fixture-agent";

/** Builds a complete create/update payload so tests only override the field under assertion. */
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
local = true
name = "${LOCAL_AGENT_NAME}"
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

afterAll(() => {
    processManager.killAll();
    tempFiles.cleanup();
});

describe("SSH agent configuration API", () => {
    it("persists and dynamically registers an SSH-backed agent", async () => {
        const response = await apiClient.createSshAgent({
            target: "example-host",
            username: "deploy",
            ssh_port: 2222,
            name: AGENT_NAME,
            remote_bin: "/opt/redoor",
            home: "/srv/app",
            log: "/tmp/created-ssh-agent.log",
            password: "ssh-secret",
        });

        // The response must be immediately usable without restarting or contacting SSH.
        expect(response.agent).toMatchObject({
            id: AGENT_NAME,
            name: AGENT_NAME,
            cwd: "/srv/app",
            managed: true,
            configuration_editable: true,
            status: "stopped",
        });
        const inventory = await apiClient.listAgents();
        // Dynamic reload must expose exactly one retained managed inventory record.
        expect(
            inventory.filter((agent) => agent.name === AGENT_NAME),
        ).toHaveLength(1);
        // Local TOML agents are managed but must stay out of the SSH configuration API.
        expect(
            inventory.find((agent) => agent.id === LOCAL_AGENT_NAME)
                ?.configurationEditable,
        ).toBe(false);

        const editedConfig = readFileSync(configPath, "utf8");
        // toml_edit must preserve unrelated operator comments while appending every explicit field.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain('target = "example-host"');
        expect(editedConfig).toContain('username = "deploy"');
        expect(editedConfig).toContain("ssh_port = 2222");
        expect(editedConfig).toContain(`name = "${AGENT_NAME}"`);
        expect(editedConfig).toContain('password = "ssh-secret"');

        await apiClient.restartServer();
        const afterRestart = await waitForValue({
            timeoutMs: 15_000,
            description: "created SSH agent after server restart",
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
    });

    it("rejects invalid and duplicate effective names without appending TOML", async () => {
        const before = readFileSync(configPath, "utf8");
        await expect(
            apiClient.createSshAgent({
                target: "   ",
                username: null,
                ssh_port: null,
                name: null,
                remote_bin: null,
                home: null,
                log: null,
                password: null,
            }),
        ).rejects.toMatchObject({
            status: 400,
            message: "SSH target is required",
        } satisfies Partial<ApiError>);
        await expect(
            apiClient.createSshAgent({
                target: "another-host",
                username: null,
                ssh_port: null,
                name: AGENT_NAME,
                remote_bin: null,
                home: null,
                log: null,
                password: null,
            }),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);
        // Rejected submissions must not modify the durable source of truth.
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });

    it("reads, updates, renames, and deletes a stopped SSH entry", async () => {
        const configuration = await apiClient.getSshAgentConfiguration(AGENT_NAME);
        // The edit view must receive persisted settings without the stored SSH password.
        expect(configuration).toMatchObject({
            target: "example-host",
            username: "deploy",
            ssh_port: 2222,
            name: AGENT_NAME,
            password: null,
        });

        const renamed = "updated-ssh-agent";
        const configuredAgent = (await apiClient.listAgents()).find(
            (agent) => agent.id === AGENT_NAME,
        );
        if (!configuredAgent) throw new Error("Created SSH agent missing");
        await configuredAgent.start();
        const update = await apiClient.updateSshAgent(AGENT_NAME, {
            target: "updated-host",
            username: "operator",
            ssh_port: 2200,
            name: renamed,
            remote_bin: null,
            home: "/srv/updated",
            log: null,
            password: "updated-secret",
        });
        // Save must settle a delayed restart before replacing the identity, rather than racing it.
        expect(update.agent).toMatchObject({
            id: renamed,
            cwd: "/srv/updated",
            status: "stopped",
        });
        const inventory = await apiClient.listAgents();
        expect(inventory.some((agent) => agent.id === AGENT_NAME)).toBe(false);
        expect(inventory.some((agent) => agent.id === renamed)).toBe(true);
        const afterUpdate = await apiClient.getSshAgentConfiguration(renamed);
        // Clearing optional paths on PUT must persist as omitted settings, not leftover values.
        expect(afterUpdate.remote_bin).toBeNull();
        expect(afterUpdate.log).toBeNull();
        // GET must keep omitting the secret after an update that replaces it.
        expect(afterUpdate.password).toBeNull();
        const editedConfig = readFileSync(configPath, "utf8");
        // Updating must preserve unrelated comments while replacing old SSH values.
        expect(editedConfig).toContain("# This comment must survive the config edit.");
        expect(editedConfig).toContain('target = "updated-host"');
        expect(editedConfig).not.toContain('target = "example-host"');

        const deletion = await apiClient.deleteManagedAgent(renamed);
        expect(deletion.deleted).toBe(true);
        // Deletion must remove both durable TOML and retained runtime inventory.
        expect((await apiClient.listAgents()).some((agent) => agent.id === renamed)).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(`name = "${renamed}"`);
    });

    it("returns 404 for unknown and local agents without converting them", async () => {
        const missing = "missing-ssh-agent";
        // Unknown ids must not invent configuration, replace, or delete anything.
        await expect(
            apiClient.getSshAgentConfiguration(missing),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateSshAgent(
                missing,
                sshRequest({ target: "nobody", name: missing }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(apiClient.deleteManagedAgent(missing)).rejects.toMatchObject(
            { status: 404 } satisfies Partial<ApiError>,
        );
        // Local agents are managed but must stay out of the SSH configuration API.
        await expect(
            apiClient.getSshAgentConfiguration(LOCAL_AGENT_NAME),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateSshAgent(
                LOCAL_AGENT_NAME,
                sshRequest({
                    target: "converted-host",
                    name: LOCAL_AGENT_NAME,
                }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.deleteManagedAgent(LOCAL_AGENT_NAME),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        const local = (await apiClient.listAgents()).find(
            (agent) => agent.id === LOCAL_AGENT_NAME,
        );
        // A rejected SSH mutation must not convert or remove the local fixture.
        expect(local?.managed).toBe(true);
        expect(local?.configurationEditable).toBe(false);
        expect(readFileSync(configPath, "utf8")).toContain(
            `name = "${LOCAL_AGENT_NAME}"`,
        );
    });

    it("rejects a rename onto an existing id without stopping the original", async () => {
        const originalName = "rename-conflict-source";
        const takenName = "rename-conflict-taken";
        await apiClient.createSshAgent(
            sshRequest({ target: "source-host", name: originalName }),
        );
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
            apiClient.updateSshAgent(
                originalName,
                sshRequest({ target: "source-host", name: takenName }),
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

    it("keeps the stored password when PUT omits it", async () => {
        const name = "password-keep-agent";
        await apiClient.createSshAgent(
            sshRequest({
                target: "secret-host",
                name,
                password: "keep-me",
            }),
        );
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name);
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const updated = await apiClient.updateSshAgent(
            name,
            sshRequest({ target: "secret-host-2", name }),
        );
        // Identity stays the same so only the password-preservation path is under test.
        expect(updated.agent.id).toBe(name);
        // GET still must not echo the secret after an update that kept it.
        expect((await apiClient.getSshAgentConfiguration(name)).password).toBeNull();
        // An empty PUT password must leave the durable secret untouched.
        expect(readFileSync(configPath, "utf8")).toContain('password = "keep-me"');
        expect(readFileSync(configPath, "utf8")).toContain('target = "secret-host-2"');
    });

    it("stops a desired-running agent before deleting it", async () => {
        const name = "delete-running-agent";
        await apiClient.createSshAgent(
            sshRequest({ target: "delete-host", name }),
        );
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
        if (!created) throw new Error("Delete-running agent missing");
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
        expect(readFileSync(configPath, "utf8")).not.toContain(`name = "${name}"`);
    });
});
