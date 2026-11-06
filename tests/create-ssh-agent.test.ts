import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";

import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import type { UpdateSshAgentRequest } from "#bindings/UpdateSshAgentRequest";
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
    getAvailablePort,
    restartServerAndWait,
    waitForPort,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "created-ssh-agent";

const LOCAL_AGENT_NAME = "local-fixture-agent";

/** Builds a complete create payload so tests only override the field under assertion. */
function sshRequest(
    overrides: Partial<CreateSshAgentRequest> &
        Pick<CreateSshAgentRequest, "target">,
): CreateSshAgentRequest {
    return {
        username: null,
        ssh_port: null,
        name: null,
        install_dir: null,
        password: null,
        clear_password: null,
        ...overrides,
    };
}

/** Builds the generated update contract independently from the create request type. */
function sshUpdateRequest(
    overrides: Partial<UpdateSshAgentRequest> &
        Pick<UpdateSshAgentRequest, "target">,
): UpdateSshAgentRequest {
    return {
        username: null,
        ssh_port: null,
        name: null,
        install_dir: null,
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
local = true
name = "${LOCAL_AGENT_NAME}"
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

describe("SSH agent configuration API", () => {
    it("persists and dynamically registers an SSH-backed agent", async () => {
        const response = await apiClient.createSshAgent({
            target: "example-host",
            username: "deploy",
            ssh_port: 2222,
            name: AGENT_NAME,
            install_dir: "/mnt/tank/apps",
            password: "ssh-secret",
            clear_password: null,
        });

        // The response must be immediately usable without restarting or contacting SSH.
        expect(response.agent).toMatchObject({
            // The server creates an opaque id for the new device; the name stays separate.
            id: expect.stringMatching(DEVICE_ID_REGEXP),
            name: AGENT_NAME,
            // SSH devices open the remote user's home, unknown until the daemon connects.
            cwd: null,
            managed: true,
            configuration_editable: true,
            ssh_target: "example-host",
            status: "stopped",
            provisioning_status: [],
        });
        const inventory = await apiClient.listAgents();
        // Dynamic reload must expose exactly one retained managed inventory record.
        expect(
            inventory.filter((agent) => agent.name === AGENT_NAME),
        ).toHaveLength(1);
        // Local TOML agents are also configuration-editable, but stay out of the SSH APIs.
        expect(
            inventory.find((agent) => agent.name === LOCAL_AGENT_NAME)
                ?.configurationEditable,
        ).toBe(true);
        // List inventory must carry the SSH destination so UI chips need no extra fetch.
        expect(
            inventory.find((agent) => agent.name === AGENT_NAME)?.sshTarget,
        ).toBe("example-host");
        expect(
            inventory.find((agent) => agent.name === LOCAL_AGENT_NAME)
                ?.sshTarget,
        ).toBeNull();

        const editedConfig = readFileSync(configPath, "utf8");
        // toml_edit must preserve unrelated operator comments while appending every explicit field.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain('target = "example-host"');
        expect(editedConfig).toContain('username = "deploy"');
        expect(editedConfig).toContain("ssh_port = 2222");
        expect(editedConfig).toContain(`name = "${AGENT_NAME}"`);
        expect(editedConfig).toContain('install_dir = "/mnt/tank/apps"');
        expect(editedConfig).toContain('password = "ssh-secret"');
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
    });

    it("rejects invalid and duplicate effective names without appending TOML", async () => {
        const before = readFileSync(configPath, "utf8");
        await expect(
            apiClient.createSshAgent({
                target: "   ",
                username: null,
                ssh_port: null,
                name: null,
                install_dir: null,
                password: null,
                clear_password: null,
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
                install_dir: null,
                password: null,
                clear_password: null,
            }),
        ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);
        // A line break would end up inside the single-line scripts run on the device.
        await expect(
            apiClient.createSshAgent(
                sshRequest({
                    target: "another-host",
                    install_dir: "/mnt/tank\napps",
                }),
            ),
        ).rejects.toMatchObject({
            status: 400,
            message:
                "install_dir must not contain control characters such as newlines",
        } satisfies Partial<ApiError>);
        // Rejected submissions must not modify the durable source of truth.
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });

    it("reads, updates, renames, and deletes a stopped SSH entry", async () => {
        const configuration =
            await apiClient.getSshAgentConfiguration(AGENT_NAME);

        // The edit view must learn that a secret exists without receiving the secret itself.
        expect(configuration).toMatchObject({
            target: "example-host",
            username: "deploy",
            ssh_port: 2222,
            name: AGENT_NAME,
            // The edit form shows the saved install directory.
            install_dir: "/mnt/tank/apps",
            password: null,
            has_password: true,
        });

        const renamed = "updated-ssh-agent";

        const configuredAgent = (await apiClient.listAgents()).find(
            (agent) => agent.name === AGENT_NAME,
        );

        if (!configuredAgent) throw new Error("Created SSH agent missing");
        await configuredAgent.start();

        const updateRequest: UpdateSshAgentRequest = {
            target: "updated-host",
            username: "operator",
            ssh_port: 2200,
            name: renamed,
            install_dir: null,
            password: "updated-secret",
            clear_password: false,
        };

        const update = await apiClient.updateSshAgent(
            AGENT_NAME,
            updateRequest,
        );

        // Save must settle a delayed restart before applying the rename, rather than racing it.
        // A rename changes only the name; the id stays so stored references keep working.
        expect(update.agent).toMatchObject({
            id: configuredAgent.id,
            name: renamed,
            cwd: null,
            status: "stopped",
        });
        const inventory = await apiClient.listAgents();
        expect(inventory.some((agent) => agent.name === AGENT_NAME)).toBe(
            false,
        );
        expect(inventory.some((agent) => agent.name === renamed)).toBe(true);
        const afterUpdate = await apiClient.getSshAgentConfiguration(renamed);
        // Clearing optional paths on PUT must persist as omitted settings, not leftover values.
        expect(afterUpdate.install_dir).toBeNull();
        // GET must keep omitting the secret after an update that replaces it.
        expect(afterUpdate.password).toBeNull();
        expect(afterUpdate.has_password).toBe(true);
        const editedConfig = readFileSync(configPath, "utf8");
        // Updating must preserve unrelated comments while replacing old SSH values.
        expect(editedConfig).toContain(
            "# This comment must survive the config edit.",
        );
        expect(editedConfig).toContain('target = "updated-host"');
        expect(editedConfig).not.toContain('target = "example-host"');
        // A typed password on PUT must replace the durable secret, not keep the old one.
        expect(editedConfig).toContain('password = "updated-secret"');
        expect(editedConfig).not.toContain('password = "ssh-secret"');
        // The edit handler rebuilds the entry, so it must carry the id over explicitly.
        expect(editedConfig).toContain(`id = "${configuredAgent.id}"`);

        const deletion = await apiClient.deleteManagedAgent(renamed, "ssh");
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
        const name = "ssh-edit-keeps-id";

        const created = await apiClient.createSshAgent(
            sshRequest({ target: "before-host", name, ssh_port: 22 }),
        );

        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(created.agent.id, "ssh");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const update = await apiClient.updateSshAgent(
            created.agent.id,
            sshUpdateRequest({
                target: "after-host",
                name,
                username: "operator",
                ssh_port: 2022,
            }),
        );

        // Editing by id works, and the device keeps its id while its settings change.
        expect(update.agent).toMatchObject({
            id: created.agent.id,
            name,
            ssh_target: "after-host",
        });

        const table = readFileSync(configPath, "utf8")
            .split("[[agents]]")
            .find((entry) => entry.includes(`name = "${name}"`));

        // The rewritten entry still carries the original id, so the next startup does not
        // assign a new one and break token scopes.
        expect(table).toContain(`id = "${created.agent.id}"`);
        // The edit itself was applied to the same entry.
        expect(table).toContain('target = "after-host"');
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
                sshUpdateRequest({ target: "nobody", name: missing }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.deleteManagedAgent(missing, "ssh"),
        ).rejects.toMatchObject({
            status: 404,
        } satisfies Partial<ApiError>);
        // Local agents are managed but SSH GET/PUT must not convert them into SSH rows.
        await expect(
            apiClient.getSshAgentConfiguration(LOCAL_AGENT_NAME),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.updateSshAgent(
                LOCAL_AGENT_NAME,
                sshUpdateRequest({
                    target: "converted-host",
                    name: LOCAL_AGENT_NAME,
                }),
            ),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
        await expect(
            apiClient.deleteManagedAgent(LOCAL_AGENT_NAME, "ssh"),
        ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);

        const local = (await apiClient.listAgents()).find(
            (agent) => agent.name === LOCAL_AGENT_NAME,
        );

        // A rejected SSH mutation must not convert or remove the local fixture.
        expect(local?.managed).toBe(true);
        expect(local?.configurationEditable).toBe(true);
        expect(readFileSync(configPath, "utf8")).toContain(
            `name = "${LOCAL_AGENT_NAME}"`,
        );
        expect(readFileSync(configPath, "utf8")).toContain("local = true");
        expect(readFileSync(configPath, "utf8")).not.toContain(
            'target = "converted-host"',
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
                    await apiClient.deleteManagedAgent(name, "ssh");
                } catch {
                    // Cleanup must tolerate an already-removed leftover from a failed assertion.
                }
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
            apiClient.updateSshAgent(
                originalName,
                sshUpdateRequest({ target: "source-host", name: takenName }),
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
                await apiClient.deleteManagedAgent(name, "ssh");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const before = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        const updated = await apiClient.updateSshAgent(
            name,
            sshUpdateRequest({ target: "secret-host-2", name }),
        );

        // Identity stays the same so only the password-preservation path is under test.
        expect(updated.agent.id).toBe(before?.id);
        const kept = await apiClient.getSshAgentConfiguration(name);
        // GET still must not echo the secret after an update that kept it.
        expect(kept.password).toBeNull();
        // Presence must stay true so the edit form can keep the password radio selected.
        expect(kept.has_password).toBe(true);
        // An empty PUT password must leave the durable secret untouched.
        expect(readFileSync(configPath, "utf8")).toContain(
            'password = "keep-me"',
        );
        expect(readFileSync(configPath, "utf8")).toContain(
            'target = "secret-host-2"',
        );
    });

    it("reports missing passwords and can clear a stored secret", async () => {
        const name = "password-clear-agent";
        await apiClient.createSshAgent(
            sshRequest({ target: "key-only-host", name }),
        );
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "ssh");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const withoutPassword = await apiClient.getSshAgentConfiguration(name);
        // Key-auth agents must initialize the edit radios from absence, not a leaked secret.
        expect(withoutPassword.password).toBeNull();
        expect(withoutPassword.has_password).toBe(false);

        await apiClient.updateSshAgent(
            name,
            sshUpdateRequest({
                target: "key-only-host",
                name,
                password: "temporary-secret",
            }),
        );
        expect(readFileSync(configPath, "utf8")).toContain(
            'password = "temporary-secret"',
        );
        expect(
            (await apiClient.getSshAgentConfiguration(name)).has_password,
        ).toBe(true);

        await apiClient.updateSshAgent(
            name,
            sshUpdateRequest({
                target: "key-only-host",
                name,
                clear_password: true,
            }),
        );
        const cleared = await apiClient.getSshAgentConfiguration(name);
        // Clearing must flip presence so the UI can switch to key mode on the next edit.
        expect(cleared.has_password).toBe(false);
        expect(cleared.password).toBeNull();
        const afterClear = readFileSync(configPath, "utf8");

        const clearedTable = afterClear
            .split("[[agents]]")
            .find((table) => table.includes(`name = "${name}"`));

        // Persistence must drop the TOML key rather than leave an empty password string.
        expect(clearedTable).toBeDefined();
        expect(clearedTable).not.toMatch(/^\s*password\s*=/m);
        expect(afterClear).toContain('target = "key-only-host"');
    });

    it("stops a desired-running agent before deleting it", async () => {
        const name = "delete-running-agent";
        await apiClient.createSshAgent(
            sshRequest({ target: "delete-host", name }),
        );
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "ssh");
            } catch {
                // Cleanup must tolerate a successful delete leaving nothing behind.
            }
        });

        const created = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        if (!created) throw new Error("Delete-running agent missing");
        await created.start();
        // The API must accept delete while desired-running instead of asking the client to stop first.
        expect(
            (await apiClient.listAgents()).find((agent) => agent.name === name)
                ?.status,
        ).not.toBe("stopped");

        const deletion = await apiClient.deleteManagedAgent(name, "ssh");
        expect(deletion.deleted).toBe(true);
        // Both inventory and TOML must be gone after an auto-stop delete.
        expect(
            (await apiClient.listAgents()).some((agent) => agent.name === name),
        ).toBe(false);
        expect(readFileSync(configPath, "utf8")).not.toContain(
            `name = "${name}"`,
        );
    });

    it("keeps a failed SSH start attempt across retries and Disconnect", async () => {
        const name = "unreachable-ssh-progress";
        // Accepting TCP but never sending an SSH banner keeps the sniff pending for as long as
        // the test needs, without waiting out ssh's connect timeout on an unroutable address.
        const pendingSockets = new Set<Socket>();
        let answering = true;

        const silentServer = createServer((socket) => {
            if (answering) {
                pendingSockets.add(socket);
            } else {
                socket.destroy();
            }
        });

        const port = await getAvailablePort();

        await new Promise<void>((resolve) =>
            silentServer.listen(port, "127.0.0.1", resolve),
        );
        onTestFinished(async () => {
            for (const socket of pendingSockets) socket.destroy();
            await new Promise<void>((resolve) =>
                silentServer.close(() => resolve()),
            );
        });

        await apiClient.createSshAgent(
            sshRequest({ target: "127.0.0.1", ssh_port: port, name }),
        );
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "ssh");
            } catch {
                // Cleanup must tolerate an already-removed leftover from a failed assertion.
            }
        });

        const created = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        if (!created) throw new Error("Unreachable SSH agent missing");
        await created.start();

        const sniffing = await waitForValue({
            timeoutMs: 10_000,
            description:
                "SSH sniffing status while ssh waits on the silent target",
            predicate: async () => {
                if (pendingSockets.size === 0) return undefined;

                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === name,
                );

                // The first SSH round trip of a managed device resolves its socket
                // directory, so that step is what shows while ssh waits.
                return agent?.provisioningStatus.some((step) =>
                    step.message.includes("on the SSH target"),
                )
                    ? agent
                    : undefined;
            },
        });

        // Progress must appear on inventory while the SSH connection is still pending.
        expect(
            sniffing.provisioningStatus.map((step) => step.message),
        ).toContain("Finding the agent socket directory on the SSH target");
        // No connection issue yet: the sniff is still waiting for the target to answer.
        expect(sniffing.connectionIssue).toBeFalsy();

        // Hanging up now makes the sniff fail, as a target that times out eventually would.
        answering = false;

        for (const socket of pendingSockets) socket.destroy();
        pendingSockets.clear();

        const failed = await waitForValue({
            timeoutMs: 10_000,
            description:
                "last failed attempt after the silent SSH target hung up",
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === name,
                );

                const hasSniff = agent?.lastFailedAttempt?.messages.some(
                    (step) => step.message.includes("on the SSH target"),
                );

                return hasSniff ? agent : undefined;
            },
        });

        // The failure stays on connection_issue for the status displays and is kept with
        // the failed attempt's steps.
        expect(failed.connectionIssue).toBeTruthy();
        expect(failed.lastFailedAttempt?.error).toBe(failed.connectionIssue);

        // Answering again makes the next retry hang in its sniff, as a stuck start does.
        answering = true;

        const retrying = await waitForValue({
            timeoutMs: 10_000,
            description: "next retry sniffing while the failed attempt is kept",
            predicate: async () => {
                if (pendingSockets.size === 0) return undefined;

                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === name,
                );

                return agent?.provisioningStatus.some((step) =>
                    step.message.includes("on the SSH target"),
                )
                    ? agent
                    : undefined;
            },
        });

        // The previous attempt's steps and error stay readable while the next retry runs.
        expect(
            retrying.lastFailedAttempt?.messages.map((step) => step.message),
        ).toContain("Finding the agent socket directory on the SSH target");
        expect(retrying.lastFailedAttempt?.error).toBeTruthy();

        const stopped = (await retrying.shutdown()).agent;

        // Disconnecting the hanging start keeps its steps, so a stuck start can be inspected.
        expect(
            stopped.provisioning_status.map((step) => step.message),
        ).toContain("Finding the agent socket directory on the SSH target");
        // The failed attempt outlives the Disconnect as well.
        expect(stopped.last_failed_attempt?.error).toBe(
            retrying.lastFailedAttempt?.error,
        );
    });
});
