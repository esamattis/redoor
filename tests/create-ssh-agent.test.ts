import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

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
            status: "stopped",
        });
        const inventory = await apiClient.listAgents();
        // Dynamic reload must expose exactly one retained managed inventory record.
        expect(
            inventory.filter((agent) => agent.name === AGENT_NAME),
        ).toHaveLength(1);

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
});
