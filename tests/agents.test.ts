import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    afterEach,
    onTestFinished,
} from "vitest";
import { z } from "zod";
import {
    ApiClient,
    Agent,
    encodeFilesystemPath,
    isLsDirectoryResponse,
    isLsFileResponse,
} from "#ui/api-client";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
    ProcessManager,
    TEST_AGENT_TOKEN,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";
const AGENT_NAME = "test-agent";

const fileSearchResponseSchema: z.ZodType<FileSearchResponse> = z.object({
    results: z.array(
        z.object({
            name: z.string(),
            path: z.string(),
            type: z.string(),
        }),
    ),
    timed_out: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
});

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
const agentCwd = tempFiles.tempDirectory({ suffix: "-agent-cwd" });

let serverPid: number;
let apiClient: ApiClient;
let wsUrl: string;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: AGENT_NAME,
        agentCwd,
    });

    serverPid = started.serverPid;
    apiClient = started.apiClient;
    wsUrl = started.wsUrl;
}, 30000);

afterEach(() => {
    tempFiles.emptyDirs();
});

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** Narrows retained inventory to the live test socket before issuing commands. */
async function getConnectedTestAgent(): Promise<Agent> {
    const agent = (await apiClient.listAgents()).find(
        (entry) => entry.name === AGENT_NAME && entry.status === "connected",
    );
    if (!agent) {
        throw new Error(`Connected agent ${AGENT_NAME} not found`);
    }
    return agent;
}

/** Calls the search route directly so backend coverage does not require adding the UI client yet. */
async function searchAgentFiles(
    agent: Agent,
    root: string,
    search: {
        query: string;
        timeout?: number;
        includeHidden?: boolean;
        respectGitignore?: boolean;
    },
): Promise<FileSearchResponse> {
    const encodedRoot = encodeFilesystemPath(root);
    const rootSuffix = encodedRoot ? `/${encodedRoot}` : "";
    const url = new URL(
        `/api/v1/agents/${encodeURIComponent(agent.id)}/search${rootSuffix}`,
        apiClient.baseUrl,
    );
    url.searchParams.set("query", search.query);
    if (search.timeout !== undefined) {
        url.searchParams.set("timeout", search.timeout.toString());
    }
    if (search.includeHidden !== undefined) {
        url.searchParams.set("include_hidden", search.includeHidden.toString());
    }
    if (search.respectGitignore !== undefined) {
        url.searchParams.set(
            "respect_gitignore",
            search.respectGitignore.toString(),
        );
    }
    const response = await fetch(url, { headers: agent.getAuthHeaders() });
    // Successful transport proves the REST route relayed the command to the connected agent.
    expect(response.status).toBe(200);
    return fileSearchResponseSchema.parse(await response.json());
}

/** Builds a search URL for validation cases that intentionally do not return a search response. */
function getAgentSearchUrl(agent: Agent, root: string, query: string): URL {
    const encodedRoot = encodeFilesystemPath(root);
    const rootSuffix = encodedRoot ? `/${encodedRoot}` : "";
    const url = new URL(
        `/api/v1/agents/${encodeURIComponent(agent.id)}/search${rootSuffix}`,
        apiClient.baseUrl,
    );
    url.searchParams.set("query", query);
    return url;
}

describe("Agents API", () => {
    it("uses the computer hostname when the agent name is omitted", async () => {
        const agentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            cwd: agentCwd,
        });
        onTestFinished(() => processManager.kill(agentPid));

        const registeredAgent = await waitForValue({
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find(
                    (agent) =>
                        agent.name === hostname() &&
                        agent.status === "connected",
                );
            },
            description: "hostname-defaulted agent registration",
        });

        // A connected hostname entry proves omission reaches runtime fallback instead of failing startup.
        expect(registeredAgent?.name).toBe(hostname());
    });

    it("uses the process user home when --home is omitted", async () => {
        const processHome = tempFiles.tempDirectory({
            suffix: "-process-home",
        });
        const agentName = "process-home-agent";
        const agentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: agentName,
            cwd: agentCwd,
            env: { HOME: processHome },
        });
        onTestFinished(() => processManager.kill(agentPid));

        const registeredAgent = await waitForValue({
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((agent) => agent.name === agentName);
            },
            description: "process-home-defaulted agent registration",
        });

        // The published browser location must follow the active process user's HOME, not its cwd.
        expect(registeredAgent?.cwd).toBe(processHome);
    });

    it("accepts the hidden legacy --dir alias", async () => {
        const agentName = "legacy-dir-agent";
        const agentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: agentName,
            cwd: agentCwd,
            legacyDir: agentCwd,
        });
        onTestFinished(() => processManager.kill(agentPid));

        const registeredAgent = await waitForValue({
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((agent) => agent.name === agentName);
            },
            description: "legacy-dir agent registration",
        });

        // Existing invocations must retain their configured browser location during migration.
        expect(registeredAgent?.cwd).toBe(agentCwd);
    });

    it("publishes a relative --home without changing the launch cwd", async () => {
        const launchDirectory = tempFiles.tempDirectory({
            suffix: "-launch-directory",
        });
        const relativeDefault = "browser-default";
        const expectedDefault = path.join(launchDirectory, relativeDefault);
        await fs.mkdir(expectedDefault);
        const agentName = "relative-default-agent";
        const agentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: agentName,
            cwd: launchDirectory,
            home: relativeDefault,
            log: "relative-agent.log",
        });
        onTestFinished(() => processManager.kill(agentPid));

        const registeredAgent = await waitForValue({
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((agent) => agent.name === agentName);
            },
            description: "relative default directory agent registration",
        });

        // Relative --home is resolved once against the process launch directory.
        expect(registeredAgent?.cwd).toBe(expectedDefault);
        // A relative log remains launch-cwd-relative, proving --home did not mutate process cwd.
        await expect(
            fs.stat(path.join(launchDirectory, "relative-agent.log")),
        ).resolves.toBeDefined();
        // The default directory must not become an ambient base for unrelated relative options.
        await expect(
            fs.stat(path.join(expectedDefault, "relative-agent.log")),
        ).rejects.toThrow();
    });

    it("should get agent details", async () => {
        const testAgent = await getConnectedTestAgent();

        const result = await testAgent.getDetails();
        // Verify agent ID matches
        expect(result.id).toBe(testAgent.id);
        // Verify agent name matches
        expect(result.name).toBe(AGENT_NAME);
        // Verify PID is positive
        expect(result.pid).toBeGreaterThan(0);
        // List and details must publish the same immutable startup default directory.
        expect(testAgent.cwd).toBe(agentCwd);
        expect(result.cwd).toBe(agentCwd);
        // Absolute binary path lets operators confirm which agent binary is running.
        expect(result.exe_path.startsWith("/")).toBe(true);
        // Config path is empty without TOML, otherwise it must identify an absolute file.
        expect(result.config_path).toMatch(/^$|^\//);
        // Verify OS, arch, hostname are non-empty strings
        expect(result.os).toBeDefined();
        expect(result.os.length).toBeGreaterThan(0);
        expect(result.arch).toBeDefined();
        expect(result.arch.length).toBeGreaterThan(0);
        expect(result.hostname).toBeDefined();
        expect(result.hostname.length).toBeGreaterThan(0);
        // When routing discovers an external address, it must not return an empty value.
        expect(
            result.external_ip === null || result.external_ip.length > 0,
        ).toBe(true);
        // Load averages must be finite so clients can safely format and chart them.
        expect(Number.isFinite(result.load_average_one)).toBe(true);
        expect(Number.isFinite(result.load_average_five)).toBe(true);
        expect(Number.isFinite(result.load_average_fifteen)).toBe(true);
        // Verify system uptime is a positive number
        expect(Number.isFinite(result.system_uptime)).toBe(true);
        expect(result.system_uptime).toBeGreaterThan(0);
        // Verify connected_at is a positive number
        expect(Number.isFinite(result.connected_at)).toBe(true);
        expect(result.connected_at).toBeGreaterThan(0);
        // Agent and server share one binary in tests, so list/details identity must match server info.
        const serverInfo = await apiClient.getServerInfo();
        expect(result.binary).toEqual({
            version: serverInfo.version,
            git_rev: serverInfo.git_rev,
            git_dirty: serverInfo.git_dirty,
            version_dirty: serverInfo.version_dirty,
            build_mode: serverInfo.build_mode,
            build_date: serverInfo.build_date,
        });
        expect(testAgent.binary).toEqual(result.binary);
        // Mount inventory must include the root needed for direct filesystem navigation.
        expect(result.mount_points.some((mount) => mount.path === "/")).toBe(
            true,
        );
        // Every reported capacity pair must remain physically valid after transport.
        expect(
            result.mount_points.every(
                (mount) =>
                    mount.available_bytes === null ||
                    mount.total_bytes === null ||
                    mount.available_bytes <= mount.total_bytes,
            ),
        ).toBe(true);
        // Filesystem formats are either unavailable or useful non-empty labels.
        expect(
            result.mount_points.every(
                (mount) =>
                    mount.mount_type === null || mount.mount_type.length > 0,
            ),
        ).toBe(true);
        // Kernel and container pseudo-filesystems are noise on the operator overview.
        expect(
            result.mount_points.every(
                (mount) =>
                    mount.mount_type === null ||
                    ![
                        "devpts",
                        "devtmpfs",
                        "proc",
                        "fuse.lxcfs",
                        "sysfs",
                        "efivarfs",
                        "cgroup2",
                        "fusectl",
                        "pstore",
                        "debugfs",
                        "securityfs",
                        "tmpfs",
                        "mqueue",
                        "binfmt_misc",
                    ].includes(mount.mount_type),
            ),
        ).toBe(true);
    });

    it("should list directory contents on connected agent", async () => {
        const testAgent = await getConnectedTestAgent();

        const agentDetails = await testAgent.getDetails();
        const listedFileName = "directory-listing-test-file.txt";
        const listedFilePath = path.join(agentDetails.cwd, listedFileName);

        await fs.writeFile(
            listedFilePath,
            "directory listing test content",
            "utf-8",
        );

        const result = await testAgent.ls(agentDetails.cwd);
        // Verify result is a directory response
        expect(isLsDirectoryResponse(result)).toBe(true);
        // Verify result contains an array of files
        if (isLsDirectoryResponse(result)) {
            // Directory details need the resolved path to identify the object represented by the listing.
            expect(result.path).toBe(agentDetails.cwd);
            // The mode is numeric so the UI can share its Unix permissions view with file details.
            expect(result.permissions).toBeGreaterThan(0);
            // Directory permission responses must contain only the standard rwx bits.
            expect(result.permissions).toBeLessThanOrEqual(0o777);
            // Verify result contains an array of files.
            expect(result.files).toBeInstanceOf(Array);
            // Creating a file in the isolated agent cwd ensures the listing has a deterministic entry.
            expect(result.files.length).toBeGreaterThan(0);
            const firstFile = result.files.find(
                (file) => file.name === listedFileName,
            );

            if (!firstFile) {
                throw new Error(
                    `Test file ${listedFileName} not found in agent directory listing`,
                );
            }

            // Looking up the created file proves the agent listed the cwd we prepared for this test.
            expect(firstFile).toBeDefined();
            // The deterministic fixture name proves file names survive transport unchanged.
            expect(firstFile.name).toBe(listedFileName);
            // File kinds must remain within the variants understood by browser clients.
            expect(firstFile.type).toMatch(/^(file|directory)$/);
            // Sizes must be finite and non-negative for safe display and sorting.
            expect(Number.isFinite(firstFile.size)).toBe(true);
            expect(firstFile.size).toBeGreaterThanOrEqual(0);
            // Numeric ownership IDs must be finite positive Unix identifiers.
            expect(Number.isFinite(firstFile.uid)).toBe(true);
            expect(firstFile.uid).toBeGreaterThan(0);
            expect(Number.isFinite(firstFile.gid)).toBe(true);
            expect(firstFile.gid).toBeGreaterThan(0);
            // Modification time must travel with the listing so clients do not issue one request per row.
            expect(Number.isFinite(firstFile.modified_at)).toBe(true);
            // A real filesystem timestamp should be a positive Unix epoch value.
            expect(firstFile.modified_at).toBeGreaterThan(0);
            // Resolved owner names are non-empty while unknown numeric owners remain null.
            expect(firstFile.owner === null || firstFile.owner.length > 0).toBe(
                true,
            );
            // Resolved group names follow the same nullable contract as owners.
            expect(firstFile.group === null || firstFile.group.length > 0).toBe(
                true,
            );
        }

        const fileResult = await testAgent.ls(listedFilePath);
        // A direct file lookup must expose permission bits so clients can explain who may access it.
        expect(isLsFileResponse(fileResult)).toBe(true);
        if (isLsFileResponse(fileResult)) {
            // The mode must be finite so clients can derive symbolic and octal permission displays.
            expect(Number.isFinite(fileResult.permissions)).toBe(true);
            // A newly created test file should expose at least one standard Unix permission bit.
            expect(fileResult.permissions).toBeGreaterThan(0);
            // Masking special and file-type bits keeps the API value limited to rwx permissions.
            expect(fileResult.permissions).toBeLessThanOrEqual(0o777);
        }
    });

    it("should recursively fuzzy search paths on connected agent", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({ suffix: "-file-search" });
        const nestedDirectory = path.join(searchRoot, "nested-source");
        const exactMatch = path.join(nestedDirectory, "file-search-target.txt");
        await fs.mkdir(nestedDirectory);
        await fs.writeFile(exactMatch, "target", "utf-8");
        await fs.writeFile(
            path.join(searchRoot, "unrelated-document.txt"),
            "other",
            "utf-8",
        );

        const result = await searchAgentFiles(testAgent, searchRoot, {
            query: "nestedsourcetarget",
        });
        // A small local tree must complete without consuming the three-second allowance.
        expect(result.timed_out).toBe(false);
        // Search timing comes from the agent that performed the filesystem traversal.
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
        // Matching a separator-free query proves path components and filenames are fuzzy scored.
        expect(result.results[0]).toEqual({
            name: "file-search-target.txt",
            path: exactMatch,
            type: "file",
        });
        // Nonmatching paths must not leak into a fuzzy result set.
        expect(
            result.results.some(
                (entry) => entry.name === "unrelated-document.txt",
            ),
        ).toBe(false);
    });

    it("should exclude unquoted minus terms and search quoted minus terms", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({
            suffix: "-excluded-file-search",
        });
        const includedTarget = path.join(searchRoot, "src", "test-target.txt");
        const excludedTarget = path.join(
            searchRoot,
            "node_modules",
            "test-target.txt",
        );
        const quotedTarget = path.join(searchRoot, "contains-node_modules.txt");
        await fs.mkdir(path.dirname(includedTarget));
        await fs.mkdir(path.dirname(excludedTarget));
        await fs.writeFile(includedTarget, "included", "utf-8");
        await fs.writeFile(excludedTarget, "excluded", "utf-8");
        await fs.writeFile(quotedTarget, "quoted", "utf-8");

        const excludedResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "-node_modules testtarget",
        });
        // The positive term still finds files outside the excluded subtree.
        expect(excludedResult.results.map((entry) => entry.path)).toEqual([
            includedTarget,
        ]);
        const quotedResult = await searchAgentFiles(testAgent, searchRoot, {
            query: '"-node_modules"',
        });
        // Double quotes make a leading minus literal rather than exclusion syntax.
        expect(quotedResult.results.map((entry) => entry.path)).toEqual([
            quotedTarget,
        ]);
    });

    it("should reject file search timeouts above 60 seconds", async () => {
        const testAgent = await getConnectedTestAgent();
        const url = getAgentSearchUrl(testAgent, agentCwd, "target");
        url.searchParams.set("timeout", "61");

        const response = await fetch(url, {
            headers: testAgent.getAuthHeaders(),
        });

        // Rejecting before command dispatch enforces the API's resource ceiling.
        expect(response.status).toBe(400);
        // A useful validation message lets API clients correct the supplied value.
        await expect(response.json()).resolves.toEqual({
            error: "File search timeout must be between 1 and 60 seconds",
        });
    });

    it("should search hidden directories only when requested", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({
            suffix: "-hidden-directory-search",
        });
        const hiddenTarget = path.join(
            searchRoot,
            ".cache",
            "hidden-target.txt",
        );
        await fs.mkdir(path.dirname(hiddenTarget));
        await fs.writeFile(hiddenTarget, "hidden", "utf-8");

        const defaultResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "hiddentarget",
        });
        // Omission preserves the safe default and avoids traversing hidden directories.
        expect(defaultResult.results).toEqual([]);
        const includedResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "hiddentarget",
            includeHidden: true,
        });
        // Explicit opt-in proves the REST option reaches agent traversal.
        expect(includedResult.results.map((entry) => entry.path)).toEqual([
            hiddenTarget,
        ]);
    });

    it("should respect gitignore files at every recursion depth by default", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({
            suffix: "-gitignore-file-search",
        });
        const nestedDirectory = path.join(searchRoot, "nested");
        const ignoredTarget = path.join(nestedDirectory, "ignored-target.txt");
        await fs.mkdir(nestedDirectory);
        await fs.writeFile(
            path.join(nestedDirectory, ".gitignore"),
            "ignored-target.txt\n",
            "utf-8",
        );
        await fs.writeFile(ignoredTarget, "ignored", "utf-8");

        const defaultResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "ignoredtarget",
        });
        // Omission must activate nested ignore rules so callers get repository-like results.
        expect(defaultResult.results).toEqual([]);
        const disabledResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "ignoredtarget",
            respectGitignore: false,
        });
        // Explicitly disabling the check proves the REST option reaches agent traversal.
        expect(disabledResult.results.map((entry) => entry.path)).toEqual([
            ignoredTarget,
        ]);
    });

    it("should bound file search results", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({
            suffix: "-bounded-file-search",
        });
        await Promise.all(
            Array.from({ length: 125 }, (_, index) =>
                fs.writeFile(
                    path.join(
                        searchRoot,
                        `bounded-search-result-${index.toString().padStart(3, "0")}.txt`,
                    ),
                    "match",
                    "utf-8",
                ),
            ),
        );

        const result = await searchAgentFiles(testAgent, searchRoot, {
            query: "boundedsearchresult",
        });
        // The fixed cap keeps one control-socket JSON response memory-safe on broad searches.
        expect(result.results).toHaveLength(100);
        // Reaching the result cap alone is not a timeout; traversal still considered every entry.
        expect(result.timed_out).toBe(false);
        // Every retained entry must satisfy the query rather than merely filling the cap.
        expect(
            result.results.every((entry) =>
                entry.name.startsWith("bounded-search-result-"),
            ),
        ).toBe(true);
    });

    it("should replace existing agent when same name reconnects", async () => {
        const DUPLICATE_AGENT_NAME = "duplicate-test-agent";

        const firstAgentCwd = tempFiles.tempDirectory({
            suffix: "-duplicate-agent-first-cwd",
        });

        const firstAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: DUPLICATE_AGENT_NAME,
            cwd: firstAgentCwd,
        });
        const firstAgent = processManager.getProcess(firstAgentPid);
        // Verify first agent was spawned successfully
        expect(firstAgent).toBeDefined();

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        await waitForLogMessage(
            serverProcess,
            /Transfer socket registered: agent_id=duplicate-test-agent,/,
        );

        const agentsAfterFirst = await apiClient.listAgents();
        // Verify first agent was registered on server
        expect(
            agentsAfterFirst.some((a) => a.name === DUPLICATE_AGENT_NAME),
        ).toBe(true);

        const secondAgentCwd = tempFiles.tempDirectory({
            suffix: "-duplicate-agent-second-cwd",
        });

        const secondAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: DUPLICATE_AGENT_NAME,
            cwd: secondAgentCwd,
        });

        onTestFinished(() => {
            processManager.kill(secondAgentPid);
        });

        // Wait for the server to log the replacement of the old connection
        await waitForLogMessage(
            serverProcess,
            /Replacing stale agent connection.*duplicate-test-agent/,
        );

        // The first agent should exit because the server sent it an Error
        // message telling it was replaced by a new connection.
        const firstExitCode = await processManager.waitForExit(firstAgentPid);
        // A non-zero exit code confirms the old agent received the replacement
        // error and terminated instead of lingering as a zombie.
        expect(firstExitCode).not.toBe(0);

        // The replacement agent should be listed and functional
        const replacementAgent = await waitForValue({
            predicate: async () => {
                const agents = await apiClient.listAgents();
                return agents.find((a) => a.name === DUPLICATE_AGENT_NAME);
            },
            description: "replacement agent to be listed",
        });
        // Verify the replacement agent is registered with the expected name
        // The polling helper returns only after the replacement inventory entry exists.
        expect(replacementAgent.name).toBe(DUPLICATE_AGENT_NAME);

        // Verify original test agent is still connected
        const agentsAfterReplacement = await apiClient.listAgents();
        expect(agentsAfterReplacement.some((a) => a.name === AGENT_NAME)).toBe(
            true,
        );
    });

    it("disconnects a stale unmanaged agent", async () => {
        const unmanagedAgentName = "stale-unmanaged-test-agent";
        const control = new WebSocket(wsUrl, { autoPong: false });
        onTestFinished(() => control.close());
        await new Promise<void>((resolve, reject) => {
            control.once("open", resolve);
            control.once("error", reject);
        });
        control.send(
            JSON.stringify({
                type: "agent_register",
                agent_id: unmanagedAgentName,
                agent_name: unmanagedAgentName,
                os: "linux",
                arch: "x86_64",
                hostname: "stale-host",
                username: "stale-user",
                cwd: "/tmp",
                token: TEST_AGENT_TOKEN,
                binary: {
                    version: "0.0.0",
                    git_rev: "test",
                    git_dirty: false,
                    version_dirty: false,
                    build_mode: "debug",
                    build_date: "unknown",
                },
                supports_self_exec: false,
                supports_native_open: false,
                supports_trash: false,
            }),
        );

        const connected = await waitForValue({
            timeoutMs: 4000,
            description: "unmanaged fixture to connect",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === unmanagedAgentName &&
                        agent.connectionId !== null,
                ),
        });
        // A control connection id proves the fixture was accepted without requiring a transfer socket.
        expect(connected.managed).toBe(false);

        const disconnected = await waitForValue({
            timeoutMs: 4000,
            description: "stale unmanaged fixture to disconnect",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === unmanagedAgentName &&
                        agent.status === "disconnected" &&
                        agent.connectionId === null,
                ),
        });
        // Stale teardown must clear the authoritative socket even without a watchdog.
        expect(disconnected.status).toBe("disconnected");
    });

    it("should echo message back from connected agent", async () => {
        const testAgent = await getConnectedTestAgent();

        const testMessage = "Hello, World!";
        const result = await testAgent.echo(testMessage);
        // Verify message is echoed back correctly
        expect(result.message).toBe(testMessage);
    });

    it("should handle concurrent echo requests with random sleep", async () => {
        const testAgent = await getConnectedTestAgent();

        const CONCURRENT_REQUESTS = 20;
        const uniqueMessages = Array.from(
            { length: CONCURRENT_REQUESTS },
            (_, i) => `concurrent-test-${i}`,
        );

        const promises = uniqueMessages.map((message) =>
            testAgent.echo(message, true),
        );

        const results = await Promise.all(promises);

        expect(results.length).toBe(CONCURRENT_REQUESTS);

        for (const [index, result] of results.entries()) {
            // Each response must retain its matching request payload despite completion reordering.
            expect(result.message).toBe(uniqueMessages[index]);
        }
    });

    it("should return 404 for non-existent agent details", async () => {
        const nonExistentAgentId = "non-existent-agent-id";
        const agent = new Agent(
            apiClient.baseUrl,
            {
                id: nonExistentAgentId,
                name: "non-existent",
                cwd: "/tmp",
                managed: false,
                configuration_editable: false,
                ssh_target: null,
                status: "disconnected",
                connected_at: null,
                connection_id: null,
                last_seen_at: null,
                connection_issue: null,
                provisioning_status: [],
                binary: null,
                supports_self_exec: false,
                supports_native_open: false,
                supports_move_to_trash: false,
                supports_trash: false,
            },
            {
                getSessionCookie: () =>
                    apiClient.getAuthHeaders().Cookie ?? null,
            },
        );
        // Verify that requesting details for non-existent agent throws an error
        await expect(agent.getDetails()).rejects.toThrow("Agent not found");
    });
});
