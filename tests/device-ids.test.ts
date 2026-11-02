import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { $ } from "zx";

import type { Agent } from "#ui/api-client";
import { ApiClient } from "#ui/api-client";
import type { AgentDetailsResponse } from "#bindings/AgentDetailsResponse";
import type { LsDirectoryResponse } from "#bindings/LsDirectoryResponse";
import type { Permission } from "#bindings/Permission";
import { ApiError } from "#ui/api-transport";
import { type JsonObject, createMcpTestClient } from "./mcp-client";
import {
    ALL_PERMISSIONS,
    DEVICE_ID_PATTERN,
    DEVICE_ID_REGEXP,
    ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_USERNAME,
    TempFileManager,
    VITEST_SERVER_PORT,
    agentDataDir,
    createAccessToken,
    generateDeviceId,
    getAvailablePort,
    remoteEnv,
    removeAgentDataDir,
    restartServerAndWait,
    waitForAgentReady,
    waitForPort,
    waitForValue,
} from "./test-utils";

const processes = new ProcessManager();

const tempFiles = new TempFileManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

const wsUrl = `ws://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/agent/ws`;

const api = new ApiClient(baseUrl);

/** Hand-written `[[agents]]` entry without an id, which startup must give one. */
const HAND_WRITTEN_NAME = "ids-hand-written";

/** Standalone agent used as the first endpoint of addressing tests. */
const AGENT_A = "ids-agent-a";

/** Standalone agent used as the second endpoint of addressing tests. */
const AGENT_B = "ids-agent-b";

let configPath: string;

let serverLog: string;

let serverPid: number;

let rootA: string;

let rootB: string;

/** Inventory id of each standalone test agent, keyed by name. */
const ids = new Map<string, string>();

/** Project log directory, where agent logs survive the test's temp files. */
const LOG_DIRECTORY = join(import.meta.dirname, "..", "log");

/** The redoor binary under test, for the CLI and the startup-failure check. */
const binary = SERVER_PATH;

/** Returns the id of a device the suite started; fails loudly if it was never registered. */
function idOf(name: string): string {
    const id = ids.get(name);

    if (id === undefined) throw new Error(`No id recorded for ${name}`);

    return id;
}

/** The server process, for waiting on registration log lines. */
function serverProcess() {
    const server = processes.getProcess(serverPid);

    if (server === undefined) throw new Error("Server process missing");

    return server;
}

/** Spawns one standalone agent and waits until the router registered it under `name`. */
async function spawnStandalone(options: {
    name: string;
    root: string;
    appName?: string;
    log?: string;
}): Promise<number> {
    const ready = waitForAgentReady(serverProcess(), options.name, 15_000);

    const pid = processes.spawnAgent({
        wsAddress: wsUrl,
        name: options.name,
        cwd: options.root,
        home: options.root,
        appName: options.appName,
        log: options.log,
    });

    await ready;

    return pid;
}

/** Polls the inventory until the device called `name` is connected. */
async function waitForConnected(
    name: string,
    timeoutMs = 15_000,
): Promise<Agent> {
    return waitForValue({
        timeoutMs,
        description: `${name} to be connected`,
        predicate: async () =>
            (await api.listAgents()).find(
                (agent) => agent.name === name && agent.status === "connected",
            ),
    });
}

/** Creates a managed local agent rooted at `home`, starts it and waits for its connection. */
async function createConnectedLocalAgent(
    name: string,
    home: string,
): Promise<Agent> {
    const created = await api.createLocalAgent({ name, home });

    onTestFinished(async () => {
        try {
            await api.deleteManagedAgent(created.agent.id, "local");
        } catch (error) {
            // A test may already have deleted it; anything else is a real cleanup failure.
            if (!(error instanceof ApiError && error.status === 404))
                throw error;
        }
    });

    const configured = (await api.listAgents()).find(
        (agent) => agent.id === created.agent.id,
    );

    if (configured === undefined)
        throw new Error(`Created agent ${name} missing`);
    await configured.start();

    return waitForConnected(name);
}

/** Answer of one raw REST request, for asserting on statuses and bodies of either auth. */
type RawAnswer = { status: number; body: string };

/** Sends one REST request with a bearer token, or with the session cookie when it is null. */
async function rawRequest(request: {
    bearer: string | null;
    method: string;
    path: string;
    json?: unknown;
}): Promise<RawAnswer> {
    const headers = new Headers(
        request.bearer === null
            ? api.getAuthHeaders()
            : { Authorization: `Bearer ${request.bearer}` },
    );

    if (request.json !== undefined)
        headers.set("Content-Type", "application/json");

    const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body:
            request.json === undefined
                ? undefined
                : JSON.stringify(request.json),
    });

    return { status: response.status, body: await response.text() };
}

/** Path of one device route; the device value is encoded like every client must. */
function devicePath(device: string, route = ""): string {
    return `/api/v1/agents/${encodeURIComponent(device)}${route}`;
}

/** Lists a directory through REST, addressing the device with `device` (a name or an id). */
async function listNames(
    device: string,
    directory: string,
    bearer: string | null = null,
) {
    const answer = await rawRequest({
        bearer,
        method: "GET",
        path: devicePath(device, `/ls${directory}`),
    });

    if (answer.status !== 200) return { status: answer.status, names: [] };

    const listing: LsDirectoryResponse = JSON.parse(answer.body);

    return {
        status: answer.status,
        names: listing.files.map((entry) => entry.name).sort(),
    };
}

/** Mints a token for one test; it is deleted when the test finishes. */
async function token(permissions: Permission[], deviceIds?: string[]) {
    return createAccessToken(api, {
        permissions,
        devices:
            deviceIds === undefined
                ? { kind: "all" }
                : { kind: "only", device_ids: deviceIds },
    });
}

/** Reads the `id = "dev_..."` line of the `[[agents]]` entry that contains `marker`. */
function configuredId(marker: string): string | undefined {
    const entry = readFileSync(configPath, "utf8")
        .split("[[agents]]")
        .find((table) => table.includes(marker));

    return entry?.match(new RegExp(`^id = "(${DEVICE_ID_PATTERN})"`, "m"))?.[1];
}

beforeAll(async () => {
    const directory = tempFiles.tempDirectory({ suffix: "-device-ids" });
    rootA = join(directory, "a");
    rootB = join(directory, "b");
    const handWrittenRoot = join(directory, "hand-written");

    for (const root of [rootA, rootB, handWrittenRoot]) mkdirSync(root);
    writeFileSync(join(rootA, "only-on-a.txt"), "a");
    writeFileSync(join(rootB, "only-on-b.txt"), "b");
    configPath = join(directory, "config.toml");
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

# A hand-written entry: operators should not have to invent an id.
[[agents]]
local = true
name = "${HAND_WRITTEN_NAME}" # this comment must survive the id write-back
home = "${handWrittenRoot}"
`,
    );
    serverLog = join(directory, "server.log");
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    // A private home keeps this suite's token store away from other suites' tokens.
    serverPid = processes.spawnServer({
        config: configPath,
        log: serverLog,
        home: join(directory, "server-home"),
    });
    await waitForPort(VITEST_SERVER_PORT);
    await api.login(TEST_USERNAME, TEST_PASSWORD);
    await spawnStandalone({ name: AGENT_A, root: rootA });
    await spawnStandalone({ name: AGENT_B, root: rootB });

    for (const agent of await api.listAgents()) ids.set(agent.name, agent.id);
}, 60_000);

afterAll(async () => {
    await processes.killAll();
    tempFiles.cleanup();
});

describe("Managed device ids in config.toml", () => {
    it("gives hand-written entries an id at startup and keeps it across restarts", async () => {
        const assigned = configuredId(`name = "${HAND_WRITTEN_NAME}"`);

        // Startup wrote an id into the entry that had none.
        expect(assigned).toMatch(DEVICE_ID_REGEXP);
        // The write-back preserves the operator's comments.
        expect(readFileSync(configPath, "utf8")).toContain(
            "# this comment must survive the id write-back",
        );
        expect(readFileSync(configPath, "utf8")).toContain(
            "# A hand-written entry: operators should not have to invent an id.",
        );
        // The inventory uses the written id, so token scopes can refer to it.
        expect(ids.get(HAND_WRITTEN_NAME)).toBe(assigned);

        await restartServerAndWait({ apiClient: api, serverLog });
        onTestFinished(() =>
            api.waitForConnectedAgentNames([AGENT_A, AGENT_B], 30_000),
        );

        // The id is read back on the next start instead of being generated again.
        expect(configuredId(`name = "${HAND_WRITTEN_NAME}"`)).toBe(assigned);
        expect(
            (await api.listAgents()).find(
                (agent) => agent.name === HAND_WRITTEN_NAME,
            )?.id,
        ).toBe(assigned);
    }, 30_000);

    it("refuses to start with a read-only config.toml and prints a ready-to-paste id", async () => {
        if (process.getuid?.() === 0) {
            // Root ignores file permissions, so a read-only file cannot be produced.
            return;
        }

        const directory = tempFiles.tempDirectory({
            suffix: "-read-only-config",
        });

        const readOnlyConfig = join(directory, "config.toml");

        const content = `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
name = "read-only-pi"
target = "pi.invalid"
`;

        writeFileSync(readOnlyConfig, content, { mode: 0o444 });

        const result = await $({
            env: {
                ...process.env,
                HOME: directory,
                REDOOR_APP_NAME: `${TEST_APP_NAME}-read-only-config`,
                // A free port keeps a failure to fail from colliding with the suite's server.
                REDOOR_PORT: (await getAvailablePort()).toString(),
            },
            quiet: true,
            nothrow: true,
            timeout: "20s",
        })`exec ${binary} server --config ${readOnlyConfig}`;

        const output = `${result.stdout}\n${result.stderr}`;

        // An id kept only in memory would change on every start, so startup must fail.
        expect(result.exitCode, output).not.toBe(0);
        // The error names the entry without an id ...
        expect(output).toContain("read-only-pi");
        // ... and prints a complete line the operator can paste into it.
        expect(output).toMatch(new RegExp(`id = "${DEVICE_ID_PATTERN}"`));
        // The file is left exactly as it was.
        expect(readFileSync(readOnlyConfig, "utf8")).toBe(content);
    }, 30_000);
});

describe("Renames, names and token scopes", () => {
    it("keeps the id on rename, and a token scoped by name follows the device, not the name", async () => {
        const root = tempFiles.tempDirectory({ suffix: "-rename" });
        writeFileSync(join(root, "renamed-marker.txt"), "x");

        const device = await createConnectedLocalAgent(
            "ids-rename-before",
            root,
        );

        const scoped = await token(["files:read"], ["ids-rename-before"]);

        // A device name in a token scope is stored as the device's id.
        expect(scoped.metadata.devices).toEqual({
            kind: "only",
            device_ids: [device.id],
        });

        const update = await api.updateLocalAgent("ids-rename-before", {
            name: "ids-rename-after",
            home: root,
        });

        // Renaming changes only the name.
        expect(update.agent).toMatchObject({
            id: device.id,
            name: "ids-rename-after",
        });
        // The config entry still carries the same id, so the next start keeps it too.
        expect(configuredId('name = "ids-rename-after"')).toBe(device.id);

        const renamed = (await api.listAgents()).find(
            (agent) => agent.id === device.id,
        );

        if (renamed === undefined) throw new Error("Renamed device missing");
        await renamed.start();
        await waitForConnected("ids-rename-after");

        // The token reaches the renamed device by its new name and by its id.
        expect(
            (await listNames("ids-rename-after", root, scoped.token)).names,
        ).toContain("renamed-marker.txt");
        expect(
            (await listNames(device.id, root, scoped.token)).names,
        ).toContain("renamed-marker.txt");
        // The old name no longer exists at all.
        expect(
            (
                await rawRequest({
                    bearer: scoped.token,
                    method: "GET",
                    path: devicePath("ids-rename-before"),
                })
            ).status,
        ).toBe(404);

        const stored = (await api.listAccessTokens()).tokens.find(
            (entry) => entry.id === scoped.metadata.id,
        );

        // The stored scope did not follow the name: it is still the id it was created with.
        expect(stored?.devices).toEqual({
            kind: "only",
            device_ids: [device.id],
        });
    }, 60_000);

    it("does not hand a renamed device's token scope to the next device that takes its name", async () => {
        const oldRoot = tempFiles.tempDirectory({ suffix: "-old-pi" });
        const newRoot = tempFiles.tempDirectory({ suffix: "-new-pi" });
        writeFileSync(join(oldRoot, "old-pi.txt"), "old");
        writeFileSync(join(newRoot, "new-pi.txt"), "new");

        const oldPi = await createConnectedLocalAgent("ids-pi", oldRoot);
        const scoped = await token(["files:read"], ["ids-pi"]);
        await api.updateLocalAgent("ids-pi", {
            name: "ids-pi-old",
            home: oldRoot,
        });

        const renamed = (await api.listAgents()).find(
            (agent) => agent.id === oldPi.id,
        );

        if (renamed === undefined) throw new Error("Renamed device missing");
        await renamed.start();
        await waitForConnected("ids-pi-old");
        // A different device now takes the freed name.
        await spawnStandalone({ name: "ids-pi", root: newRoot });

        const newPi = await waitForConnected("ids-pi");

        // The new device is really a different device.
        expect(newPi.id).not.toBe(oldPi.id);

        const tokenClient = new ApiClient(baseUrl);
        tokenClient.setAccessToken(scoped.token);

        // The token still sees only the device it was created for, never the new `ids-pi`.
        expect(
            (await tokenClient.listAgents()).map((agent) => agent.id),
        ).toEqual([oldPi.id]);
        // Addressing the old name now resolves to the new device, which is outside the scope.
        expect(
            (
                await rawRequest({
                    bearer: scoped.token,
                    method: "GET",
                    path: devicePath("ids-pi"),
                })
            ).status,
        ).toBe(403);
        expect((await listNames("ids-pi", newRoot, scoped.token)).status).toBe(
            403,
        );
        // The token keeps working for the old device under its new name.
        expect(
            (await listNames("ids-pi-old", oldRoot, scoped.token)).names,
        ).toEqual(["old-pi.txt"]);

        const details = await rawRequest({
            bearer: null,
            method: "GET",
            path: devicePath("ids-pi"),
        });

        const detailsBody: AgentDetailsResponse = JSON.parse(details.body);

        // A script addressing `ids-pi` by name follows the name to the new device.
        expect(details.status).toBe(200);
        expect(detailsBody.id).toBe(newPi.id);
        expect((await listNames("ids-pi", newRoot)).names).toEqual([
            "new-pi.txt",
        ]);
    }, 60_000);

    it("refuses to create or rename a device to a name that is already taken", async () => {
        const before = readFileSync(configPath, "utf8");

        for (const name of [AGENT_A, HAND_WRITTEN_NAME]) {
            // A live standalone device and a configured device both own their names.
            await expect(
                api.createLocalAgent({ name, home: null }),
                name,
            ).rejects.toMatchObject({
                status: 409,
            } satisfies Partial<ApiError>);
            await expect(
                api.createSshAgent({
                    target: "taken.invalid",
                    username: null,
                    ssh_port: null,
                    name,
                    remote_bin: null,
                    home: null,
                    password: null,
                    clear_password: null,
                }),
                name,
            ).rejects.toMatchObject({
                status: 409,
            } satisfies Partial<ApiError>);
        }

        // Refused creations leave the config untouched.
        expect(readFileSync(configPath, "utf8")).toBe(before);

        const created = await api.createLocalAgent({
            name: "ids-rename-conflict",
            home: null,
        });

        onTestFinished(async () => {
            await api.deleteManagedAgent(created.agent.id, "local");
        });

        for (const name of [AGENT_B, HAND_WRITTEN_NAME]) {
            // Renaming onto a taken name is refused just like creating it.
            await expect(
                api.updateLocalAgent(created.agent.id, {
                    name,
                    home: null,
                }),
                name,
            ).rejects.toMatchObject({
                status: 409,
            } satisfies Partial<ApiError>);
        }

        // The refused renames kept the original name.
        expect(
            (await api.listAgents()).find(
                (agent) => agent.id === created.agent.id,
            )?.name,
        ).toBe("ids-rename-conflict");
    });

    it("refuses names that would break device addressing", async () => {
        for (const name of [
            "ids:colon",
            "ids/slash",
            "dev_abcdefghijklmnopqrst",
        ]) {
            // `:` splits CLI `device:path`, `/` splits URLs and an id-shaped name is ambiguous.
            await expect(
                api.createLocalAgent({ name, home: null }),
                name,
            ).rejects.toMatchObject({
                status: 400,
            } satisfies Partial<ApiError>);
        }
    });
});

describe("Addressing a device by name or id", () => {
    it("accepts a name or an id in REST paths and reports unknown devices", async () => {
        const byName = await rawRequest({
            bearer: null,
            method: "GET",
            path: devicePath(AGENT_A),
        });

        const byId = await rawRequest({
            bearer: null,
            method: "GET",
            path: devicePath(idOf(AGENT_A)),
        });

        const byNameDetails: AgentDetailsResponse = JSON.parse(byName.body);
        const byIdDetails: AgentDetailsResponse = JSON.parse(byId.body);

        // Both forms address the same device.
        expect(byName.status).toBe(200);
        expect(byId.status).toBe(200);
        expect(byNameDetails.id).toBe(idOf(AGENT_A));
        expect(byIdDetails.id).toBe(idOf(AGENT_A));
        // Device routes below the path work with both forms as well.
        expect((await listNames(AGENT_A, rootA)).names).toEqual([
            "only-on-a.txt",
        ]);
        expect((await listNames(idOf(AGENT_A), rootA)).names).toEqual([
            "only-on-a.txt",
        ]);

        const unknown = await rawRequest({
            bearer: null,
            method: "GET",
            path: devicePath("ids-no-such-device"),
        });

        // An unknown device is a 404 that names the value, not a server error.
        expect(unknown.status).toBe(404);
        expect(unknown.body).toContain("Device not found: ids-no-such-device");

        const unknownId = generateDeviceId();

        const unknownById = await rawRequest({
            bearer: null,
            method: "GET",
            path: devicePath(unknownId),
        });

        // A well-formed id resolves through the id lookup, which must also end in a 404.
        expect(unknownById.status).toBe(404);
        expect(unknownById.body).toContain(`Device not found: ${unknownId}`);
    });

    it("accepts a name or an id in request body device fields", async () => {
        const source = join(rootA, "body-source.txt");
        writeFileSync(source, "body fields");

        for (const [sourceDevice, destinationDevice, file] of [
            [AGENT_A, idOf(AGENT_B), "copied-name-to-id.txt"],
            [idOf(AGENT_A), AGENT_B, "copied-id-to-name.txt"],
        ] as const) {
            const destination = join(rootB, file);

            const copy = await rawRequest({
                bearer: null,
                method: "POST",
                path: "/api/v1/copy",
                json: {
                    source: { agent: sourceDevice, path: source },
                    dest: { agent: destinationDevice, path: destination },
                    on_existing: "error",
                    resume: "auto",
                },
            });

            // The copy is admitted with either form on either side.
            expect(copy.status, copy.body).toBe(200);
            await waitForValue({
                description: `copy to ${file}`,
                predicate: async () =>
                    existsSync(destination) &&
                    readFileSync(destination, "utf8") === "body fields",
            });
        }

        writeFileSync(join(rootB, "body-right.txt"), "right\n");

        const diff = await rawRequest({
            bearer: null,
            method: "POST",
            path: "/api/v1/diff",
            json: {
                left: { agent: AGENT_A, path: source },
                right: {
                    agent: idOf(AGENT_B),
                    path: join(rootB, "body-right.txt"),
                },
            },
        });

        // A diff resolves a name on one side and an id on the other.
        expect(diff.status, diff.body).toBe(200);

        const unknown = await rawRequest({
            bearer: null,
            method: "POST",
            path: "/api/v1/copy",
            json: {
                source: { agent: "ids-no-such-device", path: source },
                dest: { agent: AGENT_B, path: join(rootB, "never.txt") },
                on_existing: "error",
                resume: "auto",
            },
        });

        // An unknown body device is reported like an unknown path device.
        expect(unknown.status).toBe(404);
        expect(unknown.body).toContain("Device not found: ids-no-such-device");
    });

    it("scopes body device fields by the resolved id", async () => {
        const onlyA = await token(["files:read", "files:write"], [AGENT_A]);
        const source = join(rootA, "scoped-body-source.txt");
        writeFileSync(source, "scoped");

        for (const destinationDevice of [AGENT_B, idOf(AGENT_B)]) {
            const copy = await rawRequest({
                bearer: onlyA.token,
                method: "POST",
                path: "/api/v1/copy",
                json: {
                    source: { agent: AGENT_A, path: source },
                    dest: {
                        agent: destinationDevice,
                        path: join(rootB, "scoped-never.txt"),
                    },
                    on_existing: "error",
                    resume: "auto",
                },
            });

            // Neither the name nor the id of an out-of-scope device gets past the scope check.
            expect(copy.status, destinationDevice).toBe(403);
        }

        // Nothing reached the out-of-scope device.
        expect(existsSync(join(rootB, "scoped-never.txt"))).toBe(false);
    });

    it("accepts a name or an id in MCP tool arguments", async () => {
        const mcp = createMcpTestClient({
            endpoint: `${baseUrl}/mcp`,
            token: (await token(ALL_PERMISSIONS)).token,
        });

        for (const device of [AGENT_A, idOf(AGENT_A)]) {
            const listed = await mcp.callTool<
                JsonObject & { entries: Array<{ name: string }> }
            >("list_directory", { device_id: device, path: rootA });

            // File tools reach the same device with either form.
            expect(
                listed.result.structuredContent?.entries.map(
                    (entry) => entry.name,
                ),
            ).toContain("only-on-a.txt");

            const described = await mcp.callTool<
                JsonObject & {
                    device: { device_id: string; display_name: string };
                }
            >("get_device", { device_id: device });

            // Responses always identify the device by its id, with the name beside it.
            expect(described.result.structuredContent?.device).toMatchObject({
                device_id: idOf(AGENT_A),
                display_name: AGENT_A,
            });
        }

        const destination = join(rootB, "mcp-name-to-id.txt");

        const copy = await mcp.callTool<JsonObject & { operation_id: string }>(
            "copy_path",
            {
                source: {
                    device_id: AGENT_A,
                    path: join(rootA, "only-on-a.txt"),
                },
                destination: { device_id: idOf(AGENT_B), path: destination },
                on_existing: "error",
            },
        );

        const operationId = copy.result.structuredContent?.operation_id;

        if (operationId === undefined)
            throw new Error("MCP copy has no operation id");

        const completed = await mcp.waitForOperation(operationId);

        // A transfer resolves a name on one side and an id on the other.
        expect(completed.result.structuredContent?.state).toBe("completed");
        expect(readFileSync(destination, "utf8")).toBe("a");
        // An unknown device is an error, not a silent no-op.
        await expect(
            mcp.callTool("list_directory", {
                device_id: "ids-no-such-device",
                path: "/",
            }),
        ).rejects.toThrow("Device not found");
    });

    it("accepts a name or an id in CLI device:path arguments", async () => {
        const home = tempFiles.tempDirectory({ suffix: "-cli-home" });
        const bearer = (await token(ALL_PERMISSIONS)).token;

        /** Runs one remote CLI command authenticated by the token from the environment. */
        function remote(args: string[]) {
            return $({
                env: {
                    ...process.env,
                    HOME: home,
                    REDOOR_APP_NAME: `${TEST_APP_NAME}-device-ids-cli`,
                    ...remoteEnv(baseUrl, bearer),
                },
                quiet: true,
                nothrow: true,
            })`exec ${binary} remote ${args}`;
        }

        for (const device of [AGENT_A, idOf(AGENT_A)]) {
            const ls = await remote(["ls", "--json", `${device}:${rootA}`]);

            // Listing works with either form.
            expect(ls.exitCode, ls.stderr).toBe(0);

            const listing: LsDirectoryResponse = JSON.parse(ls.stdout);

            expect(listing.files.map((entry) => entry.name)).toContain(
                "only-on-a.txt",
            );
        }

        const destination = join(rootB, "cli-name-to-id.txt");

        const copy = await remote([
            "cp",
            "--quiet",
            `${AGENT_A}:${join(rootA, "only-on-a.txt")}`,
            `${idOf(AGENT_B)}:${destination}`,
        ]);

        // A copy between a name and an id is one ordinary remote copy.
        expect(copy.exitCode, copy.stderr).toBe(0);
        expect(readFileSync(destination, "utf8")).toBe("a");

        const unknown = await remote(["ls", "ids-no-such-device:/"]);

        // An unknown device fails and lists the devices the user can address instead.
        expect(unknown.exitCode).not.toBe(0);
        expect(unknown.stderr).toContain("ids-no-such-device");
        expect(unknown.stderr).toContain(AGENT_A);
        expect(unknown.stderr).toContain(idOf(AGENT_A));
    });
});

describe("Standalone agent ids", () => {
    it("keeps its id across restarts, is never refused for restarting, and gets a new id without its id file", async () => {
        const appName = `${TEST_APP_NAME}-ids-standalone`;
        const name = "ids-standalone";
        const root = tempFiles.tempDirectory({ suffix: "-standalone" });
        const idFile = join(agentDataDir(appName), "agent-id");
        removeAgentDataDir(appName);
        onTestFinished(() => removeAgentDataDir(appName));

        let pid = await spawnStandalone({ name, root, appName });
        const first = await waitForConnected(name);

        // The agent created its own id and stored it in its data directory.
        expect(first.id).toMatch(DEVICE_ID_REGEXP);
        expect(readFileSync(idFile, "utf8").trim()).toBe(first.id);

        // Restart without waiting for the server to notice the exit, like `systemctl restart`,
        // more often than the clone detector's threshold.
        for (let restart = 0; restart < 4; restart++) {
            await processes.killAndWait(pid);
            pid = await spawnStandalone({ name, root, appName });

            const restarted = await waitForConnected(name);

            // A normal reconnect is the same device and is never refused as a clone.
            expect(restarted.id, `restart ${restart}`).toBe(first.id);
            expect(restarted.duplicateId, `restart ${restart}`).toBeNull();
        }

        await processes.killAndWait(pid);
        rmSync(idFile);
        pid = await spawnStandalone({ name, root, appName });

        const fresh = await waitForValue({
            description: "the agent to register with a new id",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.name === name &&
                        agent.status === "connected" &&
                        agent.id !== first.id,
                ),
        });

        // Deleting the id file is how a cloned machine gets its own identity.
        expect(fresh.id).toMatch(DEVICE_ID_REGEXP);
        expect(readFileSync(idFile, "utf8").trim()).toBe(fresh.id);
        await processes.killAndWait(pid);
    }, 60_000);

    it("keeps one clone connected and refuses the other with duplicate_id instead of evicting forever", async () => {
        const name = "ids-clone";
        const originalApp = `${TEST_APP_NAME}-ids-clone-original`;
        const cloneApp = `${TEST_APP_NAME}-ids-clone-copy`;
        const root = tempFiles.tempDirectory({ suffix: "-clone" });

        // Logs go to ./log so a failure can be diagnosed after the temp files are gone.
        const logs = [
            join(LOG_DIRECTORY, "ids-clone-original.log"),
            join(LOG_DIRECTORY, "ids-clone-copy.log"),
        ];

        for (const appName of [originalApp, cloneApp]) {
            removeAgentDataDir(appName);
            onTestFinished(() => removeAgentDataDir(appName));
        }

        const originalPid = await spawnStandalone({
            name,
            root,
            appName: originalApp,
            log: logs[0],
        });

        const original = await waitForConnected(name);
        // Copying the data directory is what cloning a home directory or VM image does.
        mkdirSync(agentDataDir(cloneApp), { recursive: true });
        copyFileSync(
            join(agentDataDir(originalApp), "agent-id"),
            join(agentDataDir(cloneApp), "agent-id"),
        );

        const clonePid = processes.spawnAgent({
            wsAddress: wsUrl,
            name,
            cwd: root,
            home: root,
            appName: cloneApp,
            log: logs[1],
        });

        onTestFinished(async () => {
            await processes.killAndWait(clonePid);
            await processes.killAndWait(originalPid);
        });

        const warned = await waitForValue({
            timeoutMs: 60_000,
            intervalMs: 100,
            description: "the duplicate id warning",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.id === original.id &&
                        agent.status === "connected" &&
                        agent.duplicateId !== null,
                ),
        });

        // The device warns that several machines use its id and names their hostname.
        expect(warned.duplicateId?.hostnames).toContain(hostname());

        /** Counts the duplicate-id refusals both clones have logged so far. */
        const refusals = () =>
            logs
                .map((log) =>
                    existsSync(log) ? readFileSync(log, "utf8") : "",
                )
                .join("\n")
                .match(/Server refused the duplicate device id/g)?.length ?? 0;

        const refusedBefore = refusals();

        // The refused clone keeps retrying with its normal backoff ...
        await waitForValue({
            timeoutMs: 60_000,
            intervalMs: 200,
            description: "the refused clone to retry and be refused again",
            predicate: async () => refusals() > refusedBefore,
        });

        const after = (await api.listAgents()).find(
            (agent) => agent.id === original.id,
        );

        // ... and the retry did not evict the connected clone: its connection is unchanged.
        expect(after?.status).toBe("connected");
        expect(after?.connectionId).toBe(warned.connectionId);
        // Only one device carries the shared id; the clone did not appear as another device.
        expect(
            (await api.listAgents()).filter((agent) => agent.name === name),
        ).toHaveLength(1);
        // Both processes are still running: the refused one waits and retries instead of exiting.
        expect(processes.getProcess(originalPid)?.exitCode).toBeNull();
        expect(processes.getProcess(clonePid)?.exitCode).toBeNull();
    }, 150_000);
});
