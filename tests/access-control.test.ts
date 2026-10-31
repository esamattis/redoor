import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Agent, ApiClient } from "#ui/api-client";
import type { DeviceScope } from "#bindings/DeviceScope";
import type { Permission } from "#bindings/Permission";
import { ApiError } from "#ui/api-transport";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import {
    type JsonObject,
    type McpTestClient,
    createMcpTestClient,
} from "./mcp-client";
import {
    ALL_PERMISSIONS,
    ProcessManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    TempFileManager,
    VITEST_SERVER_PORT,
    createAccessToken,
    waitForAgentReady,
    waitForPort,
    waitForValue,
} from "./test-utils";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

const api = new ApiClient(baseUrl);

const endpoint = `${baseUrl}/mcp`;

const agentA = "access-control-a";

const agentB = "access-control-b";

const managedAgent = "access-control-managed";

let rootA: string;

let rootB: string;

let trashA: string;

/** Inventory records keyed by device name, the handle the tests address devices with. */
const infos = new Map<string, AgentInfoResponse>();

/** Builds an agent handle that authenticates only with the given access token. */
function agentAs(token: string, name: string): Agent {
    const info = infos.get(name);

    if (info === undefined) throw new Error(`Unknown test agent ${name}`);

    return new Agent(baseUrl, info, { getAccessToken: () => token });
}

/** Builds a client that authenticates only with the given access token. */
function clientAs(token: string): ApiClient {
    const client = new ApiClient(baseUrl);
    client.setAccessToken(token);

    return client;
}

/** Mints a token for one test; it is deleted when the test finishes. */
async function token(
    permissions: Permission[],
    devices: DeviceScope = { kind: "all" },
): Promise<string> {
    return (await createAccessToken(api, { permissions, devices })).token;
}

/** Resolves to the HTTP status of an API call, so assertions can compare statuses directly. */
async function statusOf(call: Promise<unknown>): Promise<number> {
    try {
        await call;

        return 200;
    } catch (error) {
        if (error instanceof ApiError) {
            return error.status;
        }

        throw error;
    }
}

/** Sends a raw request with a bearer token and returns its status, draining the body. */
async function rawStatus(request: {
    bearer: string;
    method: string;
    path: string;
    /** Serialized JSON request body, when the route takes one. */
    json?: string;
}): Promise<number> {
    const headers = new Headers({ Authorization: `Bearer ${request.bearer}` });

    if (request.json !== undefined) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body: request.json,
    });

    await response.arrayBuffer();

    return response.status;
}

/** Spawns one standalone agent and waits until its connection is ready. */
async function spawnAgent(options: {
    serverPid: number;
    name: string;
    root: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void> {
    const server = processManager.getProcess(options.serverPid);

    if (server === undefined) throw new Error("Server process missing");
    const ready = waitForAgentReady(server, options.name);
    processManager.spawnAgent({
        wsAddress: `ws://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/agent/ws`,
        name: options.name,
        cwd: options.root,
        home: options.root,
        env: options.env,
    });
    await ready;
}

beforeAll(async () => {
    const directory = tempFiles.tempDirectory();
    rootA = join(directory, "a");
    rootB = join(directory, "b");
    trashA = join(directory, "trash-a");
    const managedRoot = join(directory, "managed");

    for (const path of [rootA, rootB, managedRoot]) mkdirSync(path);
    const configPath = join(directory, "config.toml");
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"

[[agents]]
local = true
name = "${managedAgent}"
home = "${managedRoot}"
log = "${join(directory, "managed.log")}"
`,
    );
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    const serverPid = processManager.spawnServer({ config: configPath });
    await waitForPort(VITEST_SERVER_PORT);
    await api.login(TEST_USERNAME, TEST_PASSWORD);
    await spawnAgent({
        serverPid,
        name: agentA,
        root: rootA,
        env: { REDOOR_AGENT_TRASH_DIRECTORY: trashA },
    });
    await spawnAgent({ serverPid, name: agentB, root: rootB });

    const response = await fetch(`${baseUrl}/api/v1/agents`, {
        headers: api.getAuthHeaders(),
    });

    const listed: AgentListResponse = await response.json();

    for (const info of listed.agents) infos.set(info.name, info);
}, 30_000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

describe("Access token permissions", () => {
    it("files:read gates listing, metadata and downloads", async () => {
        const file = join(rootA, "read.txt");
        writeFileSync(file, "readable");
        const without = agentAs(await token(["files:write"]), agentA);
        const withRead = agentAs(await token(["files:read"]), agentA);

        for (const call of [
            (agent: Agent) => agent.ls(rootA),
            (agent: Agent) => agent.metadata(file),
            (agent: Agent) => agent.raw(file),
        ]) {
            // A token without files:read is refused before the agent is contacted.
            expect(await statusOf(call(without))).toBe(403);
            // The same request succeeds with files:read.
            expect(await statusOf(call(withRead))).toBe(200);
        }
    });

    it("files:write gates uploads and directory creation", async () => {
        const without = agentAs(await token(["files:read"]), agentA);
        const withWrite = agentAs(await token(["files:write"]), agentA);

        const upload = (agent: Agent, name: string) =>
            agent.upload(join(rootA, name), new File(["written"], name));

        // Uploads need files:write and must not create the file when refused.
        expect(await statusOf(upload(without, "denied.txt"))).toBe(403);
        expect(existsSync(join(rootA, "denied.txt"))).toBe(false);
        expect(await statusOf(upload(withWrite, "allowed.txt"))).toBe(200);
        expect(readFileSync(join(rootA, "allowed.txt"), "utf8")).toBe(
            "written",
        );
        // Directory creation is a write as well.
        expect(
            await statusOf(without.createDirectory(join(rootA, "denied-dir"))),
        ).toBe(403);
        expect(
            await statusOf(
                withWrite.createDirectory(join(rootA, "allowed-dir")),
            ),
        ).toBe(200);
    });

    it("files:delete gates permanent deletion, trash and emptying the trash", async () => {
        const permanent = join(rootA, "delete-permanent.txt");
        const trashed = join(rootA, "delete-trash.txt");
        writeFileSync(permanent, "x");
        writeFileSync(trashed, "x");

        const without = agentAs(
            await token(["files:read", "files:write"]),
            agentA,
        );

        const withDelete = agentAs(await token(["files:delete"]), agentA);

        // Deleting needs files:delete even with read and write.
        expect(await statusOf(without.deleteFile(permanent))).toBe(403);
        expect(
            await statusOf(without.deleteFile(trashed, { trash: true })),
        ).toBe(403);
        expect(await statusOf(without.emptyTrash())).toBe(403);
        // Refused deletions leave the files in place.
        expect(existsSync(permanent) && existsSync(trashed)).toBe(true);
        expect(await statusOf(withDelete.deleteFile(permanent))).toBe(200);
        expect(existsSync(permanent)).toBe(false);

        if (process.platform === "linux") {
            // Trash and emptying the trash use the same permission.
            expect(
                await statusOf(withDelete.deleteFile(trashed, { trash: true })),
            ).toBe(200);
            expect(await statusOf(withDelete.emptyTrash())).toBe(200);
        }
    });

    it("commands:execute gates exec", async () => {
        const json = JSON.stringify({ argv: ["true"], cwd: null, env: {} });
        const path = `/api/v1/agents/${agentA}/exec`;

        // Every file permission together still does not allow running commands.
        expect(
            await rawStatus({
                bearer: await token([
                    "files:read",
                    "files:write",
                    "files:delete",
                ]),
                method: "POST",
                path,
                json,
            }),
        ).toBe(403);
        expect(
            await rawStatus({
                bearer: await token(["commands:execute"]),
                method: "POST",
                path,
                json,
            }),
        ).toBe(200);
    });

    it("agents:manage gates starting and stopping managed agents", async () => {
        const without = agentAs(
            await token(
                ALL_PERMISSIONS.filter(
                    (permission) => permission !== "agents:manage",
                ),
            ),
            managedAgent,
        );

        const withManage = agentAs(
            await token(["agents:manage"]),
            managedAgent,
        );

        // Lifecycle control needs agents:manage.
        expect(await statusOf(without.start())).toBe(403);
        expect(await statusOf(withManage.start())).toBe(200);
        // Stopping is the same permission.
        expect(await statusOf(without.shutdown())).toBe(403);
        expect(await statusOf(withManage.shutdown())).toBe(200);
    });
});

describe("Access token device scope", () => {
    it("limits inventory, details and files to the scoped devices", async () => {
        const bearer = await token(["files:read"], {
            kind: "only",
            device_ids: [agentA],
        });

        const client = clientAs(bearer);
        const listed = (await client.listAgents()).map((agent) => agent.name);

        // Inventory lists only in-scope devices; the scope was given by name and stored as id.
        expect(listed).toEqual([agentA]);
        // Out-of-scope device details and files are refused.
        expect(
            await rawStatus({
                bearer,
                method: "GET",
                path: `/api/v1/agents/${agentB}`,
            }),
        ).toBe(403);
        expect(await statusOf(agentAs(bearer, agentB).ls(rootB))).toBe(403);
        // In-scope details work.
        expect(
            await rawStatus({
                bearer,
                method: "GET",
                path: `/api/v1/agents/${agentA}`,
            }),
        ).toBe(200);
    });

    it("needs read on the source and write on the destination for copies", async () => {
        const source = join(rootA, "copy-source.txt");
        writeFileSync(source, "copied");
        const readBoth = await token(["files:read"]);

        const readAWriteB = await token(["files:read", "files:write"], {
            kind: "only",
            device_ids: [agentA, agentB],
        });

        // Read alone cannot write the destination.
        expect(
            await statusOf(
                agentAs(readBoth, agentA).copyTo(
                    { agent: agentB, path: join(rootB, "denied-copy.txt") },
                    source,
                ),
            ),
        ).toBe(403);

        const started = await agentAs(readAWriteB, agentA).copyTo(
            { agent: agentB, path: join(rootB, "allowed-copy.txt") },
            source,
        );

        // Read on the source plus write on the destination admits the copy.
        expect(started.copy_request_id).toBeGreaterThan(0);
        await waitForValue({
            description: "scoped copy completion",
            predicate: async () =>
                existsSync(join(rootB, "allowed-copy.txt")) ? true : undefined,
        });
        // The copy transfer is visible to the token that can see both devices.
        expect(
            (await clientAs(readAWriteB).getTransferProgress()).transfers.some(
                (entry) => entry.request_id === started.copy_request_id,
            ),
        ).toBe(true);

        const onlyA = await token(["files:read"], {
            kind: "only",
            device_ids: [agentA],
        });

        // Transfer progress hides rows that touch a device outside the scope.
        expect(
            (await clientAs(onlyA).getTransferProgress()).transfers.some(
                (entry) => entry.request_id === started.copy_request_id,
            ),
        ).toBe(false);
        // Cancelling or pausing an invisible transfer reveals nothing about it.
        expect(
            await statusOf(
                clientAs(onlyA).cancelTransfer(started.copy_request_id),
            ),
        ).toBe(404);
        expect(
            await statusOf(
                clientAs(onlyA).pauseTransfer(started.copy_request_id),
            ),
        ).toBe(404);
    });

    it("needs delete on the source for moves", async () => {
        const source = join(rootA, "move-source.txt");
        writeFileSync(source, "moved");
        const readWrite = await token(["files:read", "files:write"]);
        const full = await token(["files:read", "files:write", "files:delete"]);
        const destination = { agent: agentB, path: join(rootB, "moved.txt") };

        // A move removes the source, so read and write are not enough.
        expect(
            await statusOf(
                agentAs(readWrite, agentA).moveTo(destination, source),
            ),
        ).toBe(403);
        // With delete the move is admitted and completes.
        expect(
            await statusOf(agentAs(full, agentA).moveTo(destination, source)),
        ).toBe(200);
        await waitForValue({
            description: "scoped move completion",
            predicate: async () =>
                existsSync(destination.path) && !existsSync(source)
                    ? true
                    : undefined,
        });
    });

    it("needs read on both sides for diffs", async () => {
        const left = join(rootA, "diff-left.txt");
        const right = join(rootB, "diff-right.txt");
        writeFileSync(left, "left\n");
        writeFileSync(right, "right\n");

        const json = JSON.stringify({
            left: { agent: agentA, path: left },
            right: { agent: agentB, path: right },
        });

        const onlyA = await token(["files:read"], {
            kind: "only",
            device_ids: [agentA],
        });

        // Reading one side is not enough to diff against the other.
        expect(
            await rawStatus({
                bearer: onlyA,
                method: "POST",
                path: "/api/v1/diff",
                json,
            }),
        ).toBe(403);
        // With read on both devices the diff works.
        expect(
            await rawStatus({
                bearer: await token(["files:read"]),
                method: "POST",
                path: "/api/v1/diff",
                json,
            }),
        ).toBe(200);
    });
});

/** An empty JSON body for methods that may carry one; denied requests never parse it. */
function bodyFor(method: string): string | undefined {
    return method === "GET" ? undefined : "{}";
}

describe("Route access table", () => {
    /** One token-reachable device route and the permissions it needs on `{agent}`. */
    type DeviceRoute = {
        method: string;
        path: string;
        permissions: Permission[];
    };

    /** Builds one table row; the rest parameter keeps permission literals typed. */
    function route(
        method: string,
        path: string,
        ...permissions: Permission[]
    ): DeviceRoute {
        return { method, path, permissions };
    }

    /** Every device route reachable by a token, mirroring `access/routes.rs`. */
    function deviceRoutes(agent: string): DeviceRoute[] {
        const base = `/api/v1/agents/${agent}`;
        const file = `${rootA}/route-matrix.txt`;
        const directory = `${rootA}/route-matrix-dir`;

        return [
            route("GET", `${base}/ls`, "files:read"),
            route("GET", `${base}/ls${rootA}`, "files:read"),
            route("GET", `${base}/metadata${file}`, "files:read"),
            route("GET", `${base}/git/context${rootA}`, "files:read"),
            route("GET", `${base}/git/status${rootA}`, "files:read"),
            route("POST", `${base}/git/diff`, "files:read"),
            route("GET", `${base}/raw${file}`, "files:read"),
            route("GET", `${base}/accounts`, "files:read"),
            route("GET", `${base}/trash`, "files:read"),
            route("POST", `${base}/find${rootA}`, "files:read"),
            route("POST", `${base}/grep${rootA}`, "files:read"),
            route("POST", `${base}/directory-size${rootA}`, "files:read"),
            route("POST", `${base}/one-time-token${file}`, "files:read"),
            route("PUT", `${base}/raw${file}`, "files:write"),
            route("PUT", `${base}/archive${directory}`, "files:write"),
            route("PUT", `${base}/edit${file}`, "files:write"),
            route("POST", `${base}/mkdir${directory}`, "files:write"),
            route("POST", `${base}/chmod${file}`, "files:write"),
            route("POST", `${base}/chown${file}`, "files:write"),
            route("POST", `${base}/trash/restore`, "files:write"),
            route("POST", `${base}/rename`, "files:write", "files:delete"),
            route("DELETE", `${base}/raw${file}`, "files:delete"),
            route("DELETE", `${base}/raw${file}?trash=true`, "files:delete"),
            route("DELETE", `${base}/trash`, "files:delete"),
            route("POST", `${base}/exec`, "commands:execute"),
            route("DELETE", `${base}/exec/1`, "commands:execute"),
            route("POST", `${base}/open${file}`, "commands:execute"),
            route("POST", `${base}/start`, "agents:manage"),
            route("POST", `${base}/shutdown`, "agents:manage"),
            route("POST", `${base}/retry-start`, "agents:manage"),
            route("POST", `${base}/restart`, "agents:manage"),
            route("POST", `${base}/upgrade`, "agents:manage"),
            route("GET", base),
        ];
    }

    it("refuses every device route without its permission or outside the device scope", async () => {
        const file = join(rootA, "route-matrix.txt");
        writeFileSync(file, "untouched");
        const lacking = new Map<Permission, string>();

        for (const missing of ALL_PERMISSIONS) {
            lacking.set(
                missing,
                await token(
                    ALL_PERMISSIONS.filter(
                        (permission) => permission !== missing,
                    ),
                ),
            );
        }

        const outside = await token(ALL_PERMISSIONS, {
            kind: "only",
            device_ids: [agentB],
        });

        for (const route of deviceRoutes(agentA)) {
            for (const missing of route.permissions) {
                const bearer = lacking.get(missing);

                if (bearer === undefined)
                    throw new Error(`No ${missing} token`);
                // The access table refuses the route before the handler runs.
                expect(
                    await rawStatus({
                        bearer,
                        ...route,
                        json: bodyFor(route.method),
                    }),
                    `${route.method} ${route.path} without ${missing}`,
                ).toBe(403);
            }

            // Every permission on another device does not reach this one.
            expect(
                await rawStatus({
                    bearer: outside,
                    ...route,
                    json: bodyFor(route.method),
                }),
                `${route.method} ${route.path} outside the scope`,
            ).toBe(403);
        }

        // None of the refused requests reached the agent: the file is unchanged and present.
        expect(readFileSync(file, "utf8")).toBe("untouched");
        expect(existsSync(join(rootA, "route-matrix-dir"))).toBe(false);
    });

    it("refuses body-addressed transfer routes for devices outside the scope", async () => {
        const onlyA = await token(ALL_PERMISSIONS, {
            kind: "only",
            device_ids: [agentA],
        });

        const source = { agent: agentA, path: join(rootA, "route-copy.txt") };

        const destination = {
            agent: agentB,
            path: join(rootB, "route-copy.txt"),
        };

        writeFileSync(source.path, "copy");

        const routes = [
            {
                path: "/api/v1/copy",
                json: { source, dest: destination },
            },
            {
                path: "/api/v1/copy/preflight",
                json: { source, dest: destination },
            },
            { path: "/api/v1/move", json: { source, dest: destination } },
            {
                path: "/api/v1/partials/resume",
                json: { dest_agent_id: agentB, key: "route-matrix" },
            },
            {
                path: "/api/v1/partials/discard",
                json: { dest_agent_id: agentB, key: "route-matrix" },
            },
        ];

        for (const route of routes) {
            // The handler checks the devices named in the body against the scope.
            expect(
                await rawStatus({
                    bearer: onlyA,
                    method: "POST",
                    path: route.path,
                    json: JSON.stringify(route.json),
                }),
                route.path,
            ).toBe(403);
        }

        // Discarding a partial changes the destination, so it needs files:write there.
        expect(
            await rawStatus({
                bearer: await token(["files:read", "files:delete"]),
                method: "POST",
                path: "/api/v1/partials/discard",
                json: JSON.stringify({
                    dest_agent_id: agentA,
                    key: "route-matrix",
                }),
            }),
        ).toBe(403);
        // Nothing reached the destination device.
        expect(existsSync(destination.path)).toBe(false);
    });

    it("refuses every session-only route to a full-permission token", async () => {
        const bearer = await token(ALL_PERMISSIONS);
        const someId = "00000000-0000-4000-8000-000000000000";

        const routes: [string, string][] = [
            ["GET", "/api/v1/protocol-mismatches"],
            ["GET", "/api/v1/server"],
            ["GET", "/api/v1/server/logging-level"],
            ["PUT", "/api/v1/server/logging-level"],
            ["POST", "/api/v1/server/restart"],
            ["GET", "/api/v1/user/state"],
            ["PUT", "/api/v1/user/state"],
            ["POST", "/api/v1/agents"],
            ["PUT", `/api/v1/agents/${agentA}`],
            ["DELETE", `/api/v1/agents/${agentA}`],
            ["GET", `/api/v1/agents/${agentA}/configuration`],
            ["POST", "/api/v1/local-agents"],
            ["PUT", `/api/v1/local-agents/${managedAgent}`],
            ["DELETE", `/api/v1/local-agents/${managedAgent}`],
            ["GET", `/api/v1/local-agents/${managedAgent}/configuration`],
            ["GET", `/api/v1/agents/${agentA}/logging-level`],
            ["PUT", `/api/v1/agents/${agentA}/logging-level`],
            ["POST", `/api/v1/agents/${agentA}/echo`],
            ["GET", "/api/v1/tokens"],
            ["POST", "/api/v1/tokens"],
            ["PUT", `/api/v1/tokens/${someId}`],
            ["DELETE", `/api/v1/tokens/${someId}`],
            ["POST", `/api/v1/tokens/${someId}/rotate`],
            ["GET", "/api/v1/ui/ws"],
            ["GET", "/api/v1/server/logs/ws"],
            ["GET", `/api/v1/agents/${agentA}/logs/ws`],
            ["GET", "/api/v1/terminals"],
            ["POST", `/api/v1/agents/${agentA}/terminals`],
            ["DELETE", `/api/v1/terminals/${someId}`],
            ["GET", `/api/v1/terminals/${someId}/ws`],
        ];

        for (const [method, path] of routes) {
            // Configuration, live sockets and token management are never grantable.
            expect(
                await rawStatus({
                    bearer,
                    method,
                    path,
                    json: bodyFor(method),
                }),
                `${method} ${path}`,
            ).toBe(403);
        }

        // The managed agent's configuration survived the refused delete.
        expect(
            (await api.listAgents()).some(
                (agent) => agent.name === managedAgent,
            ),
        ).toBe(true);
    });
});

/** One MCP device tool, the permissions it needs and its arguments for one device. */
type ToolCase = {
    tool: string;
    permissions: Permission[];
    args: (device: string) => JsonObject;
};

/** Every MCP device tool, mirroring the declarative tool table in `mcp/tools.rs`. */
function toolCases(kept: string, denied: string): ToolCase[] {
    const readPermissions: Permission[] = ["files:read"];

    const pathTool = (tool: string, path: string): ToolCase => ({
        tool,
        permissions: readPermissions,
        args: (device) => ({ device_id: device, path }),
    });

    const searchTool = (tool: string): ToolCase => ({
        tool,
        permissions: readPermissions,
        args: (device) => ({ device_id: device, root: rootA, query: "kept" }),
    });

    const transferTool = (
        tool: string,
        permissions: Permission[],
    ): ToolCase => ({
        tool,
        permissions,
        args: (device) => ({
            source: { device_id: device, path: kept },
            destination: { device_id: device, path: denied },
            on_existing: "replace",
        }),
    });

    const lifecycleTool = (tool: string): ToolCase => ({
        tool,
        permissions: ["agents:manage"],
        args: (device) => ({ device_id: device }),
    });

    return [
        {
            tool: "run_command",
            permissions: ["commands:execute"],
            args: (device) => ({
                device_id: device,
                argv: ["touch", denied],
                cwd: rootA,
            }),
        },
        pathTool("list_directory", rootA),
        pathTool("stat_path", kept),
        pathTool("read_file", kept),
        searchTool("search_paths"),
        searchTool("search_contents"),
        {
            tool: "write_file",
            permissions: ["files:write"],
            args: (device) => ({
                device_id: device,
                path: denied,
                content: "denied",
                on_existing: "replace",
            }),
        },
        {
            tool: "create_directory",
            permissions: ["files:write"],
            args: (device) => ({ device_id: device, path: denied }),
        },
        {
            tool: "delete_path",
            permissions: ["files:delete"],
            args: (device) => ({
                device_id: device,
                path: kept,
                mode: "permanent",
                recursive: false,
            }),
        },
        transferTool("copy_path", ["files:read", "files:write"]),
        transferTool("move_path", [
            "files:read",
            "files:write",
            "files:delete",
        ]),
        lifecycleTool("start_managed_agent"),
        lifecycleTool("stop_managed_agent"),
    ];
}

describe("MCP tool access", () => {
    it("hides and refuses every device tool without its permission or outside the scope", async () => {
        const kept = join(rootA, "mcp-matrix-kept.txt");
        const denied = join(rootA, "mcp-matrix-denied.txt");
        writeFileSync(kept, "kept");

        const lacking = new Map<Permission, McpTestClient>();

        for (const missing of ALL_PERMISSIONS) {
            const bearer = await token(
                ALL_PERMISSIONS.filter((permission) => permission !== missing),
            );

            lacking.set(
                missing,
                createMcpTestClient({ endpoint, token: bearer }),
            );
        }

        const outside = createMcpTestClient({
            endpoint,
            token: await token(ALL_PERMISSIONS, {
                kind: "only",
                device_ids: [agentB],
            }),
        });

        for (const testCase of toolCases(kept, denied)) {
            for (const missing of testCase.permissions) {
                const client = lacking.get(missing);

                if (client === undefined)
                    throw new Error(`No ${missing} client`);

                const listed = (await client.listTools()).result.tools.map(
                    (tool) => tool.name,
                );

                // A token that can never use the tool does not see it in the catalog.
                expect(listed, testCase.tool).not.toContain(testCase.tool);
                // Calling it anyway is refused for the missing permission.
                await expect(
                    client.callTool(testCase.tool, testCase.args(agentA)),
                    `${testCase.tool} without ${missing}`,
                ).rejects.toThrow("(403)");
            }

            // Holding every permission on another device does not reach this one.
            await expect(
                outside.callTool(testCase.tool, testCase.args(agentA)),
                `${testCase.tool} outside the scope`,
            ).rejects.toThrow("(403)");
        }

        // No refused call touched the device: the kept file is intact and nothing was created.
        expect(readFileSync(kept, "utf8")).toBe("kept");
        expect(existsSync(denied)).toBe(false);
    });
});

describe("Session-only routes and authentication", () => {
    it("refuses server, agent and account management to any token", async () => {
        const bearer = await token(ALL_PERMISSIONS);

        // Creating agents could add a local agent and widen access, so it is session-only.
        expect(
            await rawStatus({
                bearer,
                method: "POST",
                path: "/api/v1/agents",
                json: JSON.stringify({ name: "x", target: "x" }),
            }),
        ).toBe(403);
        // Restarting the server is session-only and must not happen.
        expect(
            await rawStatus({
                bearer,
                method: "POST",
                path: "/api/v1/server/restart",
            }),
        ).toBe(403);
        // Server logging and the account's UI state are session-only.
        expect(
            await rawStatus({
                bearer,
                method: "PUT",
                path: "/api/v1/server/logging-level",
                json: JSON.stringify({ level: "debug" }),
            }),
        ).toBe(403);
        expect(
            await rawStatus({
                bearer,
                method: "GET",
                path: "/api/v1/user/state",
            }),
        ).toBe(403);
        // The server is still the same process: the session sees it running.
        expect(await statusOf(api.getServerInfo())).toBe(200);

        const statusCode = await new Promise<number>((resolve, reject) => {
            const socket = new WebSocket(
                `ws://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/terminals/00000000-0000-4000-8000-000000000000/ws?rows=24&cols=80`,
                { headers: { Authorization: `Bearer ${bearer}` } },
            );

            socket.on("unexpected-response", (_request, response) => {
                resolve(response.statusCode ?? 0);
                socket.terminate();
            });
            socket.on("open", () => {
                socket.close();
                reject(new Error("Terminal websocket accepted a token"));
            });
            socket.on("error", () => {});
        });

        // Terminals are session-only even for a token with commands:execute.
        expect(statusCode).toBe(403);
    });

    it("lets a bearer token decide over a valid cookie", async () => {
        const response = await fetch(`${baseUrl}/api/v1/agents`, {
            headers: {
                ...api.getAuthHeaders(),
                Authorization: "Bearer redoor_at_invalid",
            },
        });

        // An invalid token is rejected even when a valid session cookie is also sent.
        expect(response.status).toBe(401);
    });

    it("requires a credential and denies unclassified routes to tokens", async () => {
        // No credential at all is rejected.
        expect((await fetch(`${baseUrl}/api/v1/agents`)).status).toBe(401);
        // Protocol mismatches are not part of any token permission.
        expect(
            await rawStatus({
                bearer: await token(ALL_PERMISSIONS),
                method: "GET",
                path: "/api/v1/protocol-mismatches",
            }),
        ).toBe(403);
    });
});
