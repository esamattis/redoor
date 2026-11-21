import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { $ } from "zx";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import type { Permission } from "#bindings/Permission";
import {
    ALL_PERMISSIONS,
    ProcessManager,
    createAccessToken,
    remoteEnv,
    seedUserWorkspace,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

describe("Remote managed agent automatic startup", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();
    const binary = process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");
    const sourceName = "auto-start-source";
    const destinationName = "auto-start-destination";
    const failingName = "auto-start-failing";
    let api: ApiClient;
    let home: string;
    let token: string;

    beforeAll(async () => {
        const agentHome = files.tempDirectory();
        const config = files.tempFile({ suffix: ".toml" });
        await fs.writeFile(
            config,
            `[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
`,
        );
        seedUserWorkspace({
            home: TEST_SERVER_HOME,
            appName: TEST_APP_NAME,
            username: TEST_USERNAME,
            agentToken: TEST_AGENT_TOKEN,
            agents: [
                {
                    kind: "local",
                    id: "dev_autostartsourceaaaaa",
                    name: sourceName,
                    home: agentHome,
                    terminal_env: {},
                },
                {
                    kind: "local",
                    id: "dev_autostartdestaaaaaaa",
                    name: destinationName,
                    home: agentHome,
                    terminal_env: {},
                },
                {
                    kind: "local",
                    id: "dev_autostartfailaaaaaaa",
                    name: failingName,
                    home: `${agentHome}/missing`,
                    terminal_env: {},
                },
            ],
        });
        process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
        processes.spawnServer({ config });
        await waitForPort(VITEST_SERVER_PORT);
        api = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        home = files.tempDirectory();
        token = (await createAccessToken(api, {
            name: "auto-start test",
            permissions: ALL_PERMISSIONS,
        })).token;
    });

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Each CLI invocation authenticates with a token and exposes progress separately from command output. */
    function remote(...args: string[]) {
        return remoteWith(token, args);
    }

    /** Runs the CLI with a specific token, so permission-limited tokens use the same harness. */
    function remoteWith(bearer: string, args: string[]) {
        return $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: "auto-start-test",
                ...remoteEnv(api.baseUrl, bearer),
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;
    }

    /** Intentional shutdown resets the real supervisor so every workflow begins with dormant agents. */
    async function stop(...names: string[]) {
        const agents = await api.listAgents();

        for (const name of names) {
            const agent = agents.find((entry) => entry.name === name);

            if (agent === undefined) throw new Error(`Missing managed agent ${name}`);
            await agent.shutdown();
        }
    }

    it("explains that auto-start needs agents:manage", async () => {
        const permissions: Permission[] = ALL_PERMISSIONS.filter(
            (permission) => permission !== "agents:manage",
        );

        const limited = await createAccessToken(api, {
            name: "no agents:manage",
            permissions,
        });

        const result = await remoteWith(limited.token, ["exec", sourceName, "--", "true"]);
        // Without agents:manage the dormant agent cannot be started, and the error says why.
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("lacks agents:manage");
        // The refused start leaves the agent dormant.
        expect((await api.listAgents()).find((agent) => agent.name === sourceName)?.status)
            .not.toBe("connected");
    });

    it("starts a dormant agent before exec and leaves connected agents undisturbed", async () => {
        onTestFinished(() => stop(sourceName));
        const first = await remote("exec", sourceName, "--", "printf", "ready");
        // Successful remote output proves execution waited for registration instead of racing the start POST.
        expect(first.exitCode, first.stderr).toBe(0);
        expect(first.stdout).toBe("ready");
        expect(first.stderr).toContain(`Agent ${sourceName} is not running`);
        expect(first.stderr).toContain(`Device ${sourceName}: connected`);
        const connected = (await api.listAgents()).find((agent) => agent.name === sourceName);
        const second = await remote("exec", sourceName, "--", "printf", "again");
        // A live connection must not be restarted or produce spurious startup diagnostics.
        expect(second.exitCode, second.stderr).toBe(0);
        expect(second.stdout).toBe("again");
        expect(second.stderr).toBe("");
        expect((await api.listAgents()).find((agent) => agent.name === sourceName)?.connectionId)
            .toBe(connected?.connectionId);
    });

    it("starts both copy endpoints and handles upload, download, and same-agent copy", async () => {
        onTestFinished(() => stop(sourceName, destinationName));
        const root = files.tempDirectory();
        const source = path.join(root, "source.txt");
        const destination = path.join(root, "destination.txt");
        await fs.writeFile(source, "automatic startup payload");
        const copy = await remote("cp", "--json", `${sourceName}:${source}`, `${destinationName}:${destination}`);
        // Both remote endpoints must connect before copy metadata or job admission can succeed.
        expect(copy.exitCode, copy.stderr).toBe(0);
        expect(JSON.parse(copy.stdout).status).toBe("completed");
        expect(copy.stderr).toContain(`Device ${sourceName}: connected`);
        expect(copy.stderr).toContain(`Device ${destinationName}: connected`);
        expect(await fs.readFile(destination, "utf8")).toBe("automatic startup payload");

        await stop(sourceName, destinationName);
        const uploaded = path.join(root, "uploaded.txt");
        const upload = await remote("cp", "--quiet", source, `${destinationName}:${uploaded}`);
        // Quiet suppresses transfer progress but startup remains visible on stderr.
        expect(upload.exitCode, upload.stderr).toBe(0);
        expect(upload.stderr).toContain(`Device ${destinationName}: connected`);
        expect(upload.stdout).toBe("");
        const downloaded = path.join(root, "downloaded.txt");
        const download = await remote("cp", "--json", `${sourceName}:${source}`, downloaded);
        // Downloading must start its remote source before opening the raw stream.
        expect(download.exitCode, download.stderr).toBe(0);
        expect(download.stderr).toContain(`Device ${sourceName}: connected`);
        expect(await fs.readFile(downloaded, "utf8")).toBe("automatic startup payload");

        await stop(sourceName);
        const same = await remote("cp", "--json", `${sourceName}:${source}`, `${sourceName}:${path.join(root, "same.txt")}`);
        // One shared endpoint needs one startup, preserving the JSON result contract.
        expect(same.exitCode, same.stderr).toBe(0);
        expect(same.stderr.match(/is not running/g)).toHaveLength(1);
        expect(JSON.parse(same.stdout).status).toBe("completed");
    });

    it("reports startup failure to stderr without admitting exec or copy", async () => {
        onTestFinished(() => stop(failingName));
        const marker = path.join(files.tempDirectory(), "must-not-run");
        const execution = await remote("exec", "--json", failingName, "--", "touch", marker);
        // A failed supervisor must prevent the user command from running and retain the execution error shape.
        expect(execution.exitCode).toBe(125);
        expect(JSON.parse(execution.stdout).type).toBe("error");
        expect(execution.stderr).toContain(`Failed to start agent ${failingName}`);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await stop(failingName);
        const source = path.join(files.tempDirectory(), "source.txt");
        await fs.writeFile(source, "never uploaded");
        const copy = await remote("cp", "--json", "--quiet", source, `${failingName}:${marker}`);
        // Copy failures remain script-readable while actionable startup errors are always on stderr.
        expect(copy.exitCode).toBe(1);
        expect(JSON.parse(copy.stdout).status).toBe("failed");
        expect(copy.stderr).toContain(`Failed to start agent ${failingName}`);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
});
