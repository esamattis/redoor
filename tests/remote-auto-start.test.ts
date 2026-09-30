import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { $ } from "zx";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

describe("Remote managed agent automatic startup", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();
    const binary = process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");
    const sourceId = "auto-start-source";
    const destinationId = "auto-start-destination";
    const failingId = "auto-start-failing";
    let api: ApiClient;
    let home: string;

    beforeAll(async () => {
        const agentHome = files.tempDirectory();
        const config = files.tempFile({ suffix: ".toml" });
        await fs.writeFile(config, `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${sourceId}"
home = "${agentHome}"

[[agents]]
local = true
name = "${destinationId}"
home = "${agentHome}"

[[agents]]
local = true
name = "${failingId}"
home = "${agentHome}/missing"
`);
        process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
        processes.spawnServer({ config });
        await waitForPort(VITEST_SERVER_PORT);
        api = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        home = files.tempDirectory();
        const directory = path.join(home, ".local/share/auto-start-test");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, "remote-session.json"), JSON.stringify({
            version: 1,
            generation: randomUUID(),
            server_url: `${api.baseUrl}/`,
            cookies: [{
                raw_cookie: `${api.getAuthHeaders().Cookie}; Path=/`,
                path: ["/", true],
                domain: { HostOnly: "127.0.0.1" },
                expires: "SessionEnd",
            }],
        }), { mode: 0o600 });
    });

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Each CLI invocation reloads the saved session and exposes progress separately from command output. */
    function remote(...args: string[]) {
        return $({
            env: { ...process.env, HOME: home, REDOOR_APP_NAME: "auto-start-test" },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;
    }

    /** Intentional shutdown resets the real supervisor so every workflow begins with dormant agents. */
    async function stop(...ids: string[]) {
        const agents = await api.listAgents();
        for (const id of ids) {
            const agent = agents.find((entry) => entry.id === id);
            if (agent === undefined) throw new Error(`Missing managed agent ${id}`);
            await agent.shutdown();
        }
    }

    it("starts a dormant agent before exec and leaves connected agents undisturbed", async () => {
        onTestFinished(() => stop(sourceId));
        const first = await remote("exec", sourceId, "--", "printf", "ready");
        // Successful remote output proves execution waited for registration instead of racing the start POST.
        expect(first.exitCode, first.stderr).toBe(0);
        expect(first.stdout).toBe("ready");
        expect(first.stderr).toContain(`Agent ${sourceId} is not running`);
        expect(first.stderr).toContain(`Device ${sourceId}: connected`);
        const connected = (await api.listAgents()).find((agent) => agent.id === sourceId);
        const second = await remote("exec", sourceId, "--", "printf", "again");
        // A live connection must not be restarted or produce spurious startup diagnostics.
        expect(second.exitCode, second.stderr).toBe(0);
        expect(second.stdout).toBe("again");
        expect(second.stderr).toBe("");
        expect((await api.listAgents()).find((agent) => agent.id === sourceId)?.connectionId)
            .toBe(connected?.connectionId);
    });

    it("starts both copy endpoints and handles upload, download, and same-agent copy", async () => {
        onTestFinished(() => stop(sourceId, destinationId));
        const root = files.tempDirectory();
        const source = path.join(root, "source.txt");
        const destination = path.join(root, "destination.txt");
        await fs.writeFile(source, "automatic startup payload");
        const copy = await remote("cp", "--json", `${sourceId}:${source}`, `${destinationId}:${destination}`);
        // Both remote endpoints must connect before copy metadata or job admission can succeed.
        expect(copy.exitCode, copy.stderr).toBe(0);
        expect(JSON.parse(copy.stdout).status).toBe("completed");
        expect(copy.stderr).toContain(`Device ${sourceId}: connected`);
        expect(copy.stderr).toContain(`Device ${destinationId}: connected`);
        expect(await fs.readFile(destination, "utf8")).toBe("automatic startup payload");

        await stop(sourceId, destinationId);
        const uploaded = path.join(root, "uploaded.txt");
        const upload = await remote("cp", "--quiet", source, `${destinationId}:${uploaded}`);
        // Quiet suppresses transfer progress but startup remains visible on stderr.
        expect(upload.exitCode, upload.stderr).toBe(0);
        expect(upload.stderr).toContain(`Device ${destinationId}: connected`);
        expect(upload.stdout).toBe("");
        const downloaded = path.join(root, "downloaded.txt");
        const download = await remote("cp", "--json", `${sourceId}:${source}`, downloaded);
        // Downloading must start its remote source before opening the raw stream.
        expect(download.exitCode, download.stderr).toBe(0);
        expect(download.stderr).toContain(`Device ${sourceId}: connected`);
        expect(await fs.readFile(downloaded, "utf8")).toBe("automatic startup payload");

        await stop(sourceId);
        const same = await remote("cp", "--json", `${sourceId}:${source}`, `${sourceId}:${path.join(root, "same.txt")}`);
        // One shared endpoint needs one startup, preserving the JSON result contract.
        expect(same.exitCode, same.stderr).toBe(0);
        expect(same.stderr.match(/is not running/g)).toHaveLength(1);
        expect(JSON.parse(same.stdout).status).toBe("completed");
    });

    it("reports startup failure to stderr without admitting exec or copy", async () => {
        onTestFinished(() => stop(failingId));
        const marker = path.join(files.tempDirectory(), "must-not-run");
        const execution = await remote("exec", "--json", failingId, "--", "touch", marker);
        // A failed supervisor must prevent the user command from running and retain the execution error shape.
        expect(execution.exitCode).toBe(125);
        expect(JSON.parse(execution.stdout).type).toBe("error");
        expect(execution.stderr).toContain(`Failed to start agent ${failingId}`);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await stop(failingId);
        const source = path.join(files.tempDirectory(), "source.txt");
        await fs.writeFile(source, "never uploaded");
        const copy = await remote("cp", "--json", "--quiet", source, `${failingId}:${marker}`);
        // Copy failures remain script-readable while actionable startup errors are always on stderr.
        expect(copy.exitCode).toBe(1);
        expect(JSON.parse(copy.stdout).status).toBe("failed");
        expect(copy.stderr).toContain(`Failed to start agent ${failingId}`);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
});
