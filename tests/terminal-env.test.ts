import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient, type Agent } from "#ui/api-client";
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
import { openTerminal } from "./terminal-test-utils";

const AGENT_NAME = "terminal-env-agent";

const processes = new ProcessManager();

const tempFiles = new TempFileManager();

const api = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);

let configPath: string;

let agentHome: string;

/** The inventory row of the managed test device. */
async function testAgent(): Promise<Agent> {
    const agent = (await api.listAgents()).find(
        (entry) => entry.name === AGENT_NAME,
    );

    if (agent === undefined) {
        throw new Error(`Agent ${AGENT_NAME} not found`);
    }

    return agent;
}

/** Waits until the device's agent is connected and accepts commands. */
async function waitForConnected(): Promise<Agent> {
    return waitForValue({
        timeoutMs: 30_000,
        description: `${AGENT_NAME} to connect`,
        predicate: async () => {
            const agent = await testAgent();

            if (agent.status !== "connected") {
                return undefined;
            }

            // Inventory can say connected before the router accepts commands for it.
            await agent.echo("terminal-env-ready");

            return agent;
        },
    });
}

/** Prints `name` from a new shell between markers and returns its value. */
async function shellVariable(agent: Agent, name: string): Promise<string> {
    const { viewer } = await openTerminal(api, agent, agentHome);
    viewer.type(`printf '__%s=[%s]__\\n' ${name} "$${name}"\n`);

    const output = await viewer.waitForOutputMatching(
        new RegExp(`__${name}=\\[([^\\]]*)\\]__`),
    );

    const match = new RegExp(`__${name}=\\[([^\\]]*)\\]__`).exec(output);

    if (match === null) {
        throw new Error(`No value for ${name} in ${output}`);
    }

    return match[1] ?? "";
}

beforeAll(async () => {
    agentHome = tempFiles.tempDirectory({ suffix: "-terminal-env-home" });
    configPath = tempFiles.tempFile({ suffix: ".toml" });
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${AGENT_NAME}"
home = "${agentHome}"
`,
    );
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processes.spawnServer({
        config: configPath,
        log: join(import.meta.dirname, "..", "log", "terminal-env-server.log"),
        // The daemon inherits the server's environment: a plain shell needs no profile, and
        // LANG=C is what hosts without a configured locale give the agent.
        env: { SHELL: "/bin/sh", LANG: "C", LC_ALL: "", LC_CTYPE: "" },
    });
    await waitForPort(VITEST_SERVER_PORT);
    await api.login(TEST_USERNAME, TEST_PASSWORD);
    await (await testAgent()).start();
    await waitForConnected();
}, 60_000);

afterAll(async () => {
    await processes.killAll();
    tempFiles.cleanup();
});

describe("terminal environment", () => {
    it("saves a device's terminal_env while it runs and gives it to new shells", async () => {
        const agent = await waitForConnected();

        const saved = await api.updateTerminalEnv(agent.id, {
            env: { REDOOR_TEST_GREETING: "hello world", EDITOR: "vi" },
        });

        // The response echoes what new shells will get.
        expect(saved.env).toEqual({
            EDITOR: "vi",
            REDOOR_TEST_GREETING: "hello world",
        });
        // Saving the variables must not stop the agent, unlike the device edit.
        expect((await testAgent()).status).toBe("connected");
        // The configuration GET reports the saved variables for the edit page.
        expect(
            (await api.getLocalAgentConfiguration(agent.id)).terminal_env,
        ).toEqual(saved.env);
        // They are persisted in the TOML entry, not only in memory.
        expect(readFileSync(configPath, "utf8")).toContain(
            'REDOOR_TEST_GREETING = "hello world"',
        );
        // A shell opened after the save gets the variable, spaces included.
        expect(await shellVariable(agent, "REDOOR_TEST_GREETING")).toBe(
            "hello world",
        );
    });

    it("sets REDOOR_SERVER to the server's hostname", async () => {
        const agent = await waitForConnected();
        const { hostname } = await api.getServerInfo();

        // Every shell can tell which server it was opened through.
        expect(await shellVariable(agent, "REDOOR_SERVER")).toBe(hostname);
    });

    it("gives shells a UTF-8 locale when the agent has none", async () => {
        const agent = await waitForConnected();
        await api.updateTerminalEnv(agent.id, { env: {} });

        // The daemon inherited LANG=C; programs such as btop refuse to start without UTF-8.
        expect(await shellVariable(agent, "LANG")).toMatch(/utf-?8/i);
    });

    it("keeps a LANG the device's terminal_env sets", async () => {
        const agent = await waitForConnected();
        await api.updateTerminalEnv(agent.id, {
            env: { LANG: "en_US.UTF-8" },
        });

        // The device's own UTF-8 locale wins over the built-in fallback.
        expect(await shellVariable(agent, "LANG")).toBe("en_US.UTF-8");
    });

    it("refuses variables a shell cannot use", async () => {
        const agent = await waitForConnected();

        const invalid: { [name in string]: string }[] = [
            { "MY-VAR": "x" },
            { REDOOR_SERVER: "spoofed" },
            { A: "a\u0000b" },
        ];

        for (const env of invalid) {
            // Invalid names, the reserved REDOOR_SERVER and NUL bytes are client errors.
            await expect(
                api.updateTerminalEnv(agent.id, { env }),
            ).rejects.toMatchObject({ status: 400 });
        }
    });

    it("keeps terminal_env across a device edit", async () => {
        const agent = await waitForConnected();
        await api.updateTerminalEnv(agent.id, { env: { KEEP_ME: "1" } });
        await api.updateLocalAgent(agent.id, {
            name: AGENT_NAME,
            home: agentHome,
        });

        // The device form never sends the variables, so its save must carry them over.
        expect(
            (await api.getLocalAgentConfiguration(agent.id)).terminal_env,
        ).toEqual({ KEEP_ME: "1" });
    });
});
