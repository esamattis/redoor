/* oxlint-disable max-lines */
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
    isLsDirectoryResponse,
    isLsFileResponse,
} from "#ui/api-client";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { CaseSensitivity } from "#bindings/CaseSensitivity";
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

const contentGrepResponseSchema: z.ZodType<ContentGrepResponse> = z.object({
    results: z.array(
        z.object({
            path: z.string(),
            line_number: z.number().int().positive(),
            line: z.string(),
            line_truncated: z.boolean(),
            before_context: z.array(
                z.object({
                    line_number: z.number().int().positive(),
                    line: z.string(),
                    line_truncated: z.boolean(),
                }),
            ),
            after_context: z.array(
                z.object({
                    line_number: z.number().int().positive(),
                    line: z.string(),
                    line_truncated: z.boolean(),
                }),
            ),
        }),
    ),
    context_supported: z.boolean(),
    timed_out: z.boolean(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    omitted_long_lines: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
});

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
const agentCwd = tempFiles.tempDirectory({ suffix: "-agent-cwd" });

let serverPid: number;
let agentPid: number;
let apiClient: ApiClient;
let wsUrl: string;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: AGENT_NAME,
        agentCwd,
    });

    serverPid = started.serverPid;
    agentPid = started.agentPid;
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

/** Calls the search route directly to verify omitted JSON fields retain server defaults. */
async function searchAgentFiles(
    agent: Agent,
    root: string,
    search: {
        query: string;
        timeout?: number;
        includeHidden?: boolean;
        respectGitignore?: boolean;
        caseSensitivity?: CaseSensitivity;
    },
): Promise<FileSearchResponse> {
    const url = new URL("/api/v1/find", apiClient.baseUrl);
    const response = await fetch(url, {
        method: "POST",
        headers: {
            ...agent.getAuthHeaders(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            agent: agent.id,
            path: root,
            query: search.query,
            timeout: search.timeout,
            include_hidden: search.includeHidden,
            respect_gitignore: search.respectGitignore,
            case_sensitivity: search.caseSensitivity,
        }),
    });
    // Successful transport proves the REST route relayed the command to the connected agent.
    expect(response.status).toBe(200);
    return fileSearchResponseSchema.parse(await response.json());
}

/** Builds the top-level find URL for direct POST validation requests. */
function getAgentSearchUrl(): URL {
    return new URL("/api/v1/find", apiClient.baseUrl);
}

/** Builds the top-level grep URL for direct POST requests that need the raw response. */
function getAgentGrepUrl(): URL {
    return new URL("/api/v1/grep", apiClient.baseUrl);
}

describe("Agents API", () => {
    it("rejects startup retry for external and unknown agents", async () => {
        const external = await getConnectedTestAgent();
        const externalResponse = await fetch(
            `${apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(external.id)}/retry-start`,
            { method: "POST", headers: external.getAuthHeaders() },
        );
        // Connected external processes have no supervisor-owned attempt to replace.
        expect(externalResponse.status).toBe(409);

        const missingResponse = await fetch(
            `${apiClient.baseUrl}/api/v1/agents/missing-retry-agent/retry-start`,
            { method: "POST", headers: external.getAuthHeaders() },
        );
        // Unknown inventory identities retain the lifecycle API's not-found distinction.
        expect(missingResponse.status).toBe(404);
    });

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

    it("should apply every case sensitivity mode to path and content search", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({ suffix: "-case-search" });
        const target = path.join(searchRoot, "MixedCaseTarget.txt");
        await fs.writeFile(target, "MixedCaseNeedle", "utf-8");

        const smartLowerPath = await searchAgentFiles(testAgent, searchRoot, {
            query: "mixedcasetarget",
            caseSensitivity: "smart",
        });
        // A lowercase smart-case query remains forgiving for path names.
        expect(smartLowerPath.results.map((entry) => entry.path)).toEqual([
            target,
        ]);
        const smartUpperPath = await searchAgentFiles(testAgent, searchRoot, {
            query: "mixedCaseTarget",
            caseSensitivity: "smart",
        });
        // Any uppercase query letter makes smart path matching respect the whole query's case.
        expect(smartUpperPath.results).toEqual([]);
        const sensitivePath = await searchAgentFiles(testAgent, searchRoot, {
            query: "mixedcasetarget",
            caseSensitivity: "sensitive",
        });
        // Sensitive mode rejects a lowercase query for the mixed-case filename.
        expect(sensitivePath.results).toEqual([]);
        const insensitivePath = await searchAgentFiles(testAgent, searchRoot, {
            query: "mixedcasetarget",
            caseSensitivity: "insensitive",
        });
        // Insensitive mode always accepts equivalent letters regardless of case.
        expect(insensitivePath.results.map((entry) => entry.path)).toEqual([
            target,
        ]);

        const grep = (query: string, caseSensitivity: CaseSensitivity) =>
            testAgent.grepContent(searchRoot, query, {
                timeoutSeconds: 5,
                includeHidden: false,
                respectGitignore: true,
                fixedString: true,
                caseSensitivity,
            });
        const smartLowerContent = await grep("mixedcaseneedle", "smart");
        // Content smart case has the same lowercase-insensitive default as path search.
        expect(smartLowerContent.results).toHaveLength(1);
        const smartUpperContent = await grep("mixedCaseNeedle", "smart");
        // Uppercase content queries activate exact-case matching in smart mode.
        expect(smartUpperContent.results).toEqual([]);
        const sensitiveContent = await grep("mixedcaseneedle", "sensitive");
        // Explicit sensitive mode does not depend on query capitalization.
        expect(sensitiveContent.results).toEqual([]);
        const insensitiveContent = await grep("mixedcaseneedle", "insensitive");
        // Explicit insensitive mode finds the mixed-case physical line.
        expect(insensitiveContent.results).toHaveLength(1);
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
        const url = getAgentSearchUrl();

        const response = await fetch(url, {
            method: "POST",
            headers: {
                ...testAgent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent: testAgent.id,
                path: agentCwd,
                query: "target",
                timeout: 61,
            }),
        });

        // Rejecting before command dispatch enforces the API's resource ceiling.
        expect(response.status).toBe(400);
        // A useful validation message lets API clients correct the supplied value.
        await expect(response.json()).resolves.toEqual({
            error: "File search timeout must be between 1 and 60 seconds",
        });
    });

    it("should search hidden directories only when requested and always skip .git", async () => {
        const testAgent = await getConnectedTestAgent();
        const searchRoot = tempFiles.tempDirectory({
            suffix: "-hidden-directory-search",
        });
        const hiddenTarget = path.join(
            searchRoot,
            ".cache",
            "hidden-target.txt",
        );
        const gitTarget = path.join(searchRoot, ".git", "hidden-target.txt");
        await fs.mkdir(path.dirname(hiddenTarget));
        await fs.mkdir(path.dirname(gitTarget));
        await fs.writeFile(hiddenTarget, "hidden", "utf-8");
        await fs.writeFile(gitTarget, "git internals", "utf-8");

        const defaultResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "hiddentarget",
        });
        // Omission preserves the safe default and avoids traversing hidden directories.
        expect(defaultResult.results).toEqual([]);
        const includedResult = await searchAgentFiles(testAgent, searchRoot, {
            query: "hiddentarget",
            includeHidden: true,
            respectGitignore: false,
        });
        // Hidden opt-in reaches ordinary dot-directories while `.git` remains excluded unconditionally.
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

    it("should recursively grep physical lines with bounded text and traversal options", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-content-grep" });
        const visible = path.join(grepRoot, "visible.txt");
        const hidden = path.join(grepRoot, ".cache", "hidden.txt");
        const ignored = path.join(grepRoot, "ignored.txt");
        const binary = path.join(grepRoot, "binary.bin");
        const magicBinary = path.join(grepRoot, "binary.pdf");
        const oversized = path.join(grepRoot, "oversized.txt");
        await fs.mkdir(path.dirname(hidden));
        await fs.writeFile(
            visible,
            `first Needle\r\n${"x".repeat(600)} Needle\nfinal`,
        );
        await fs.writeFile(hidden, "hidden Needle");
        await fs.writeFile(ignored, "ignored Needle");
        await fs.writeFile(binary, Buffer.from("early Needle\nlate\0binary"));
        await fs.writeFile(magicBinary, "%PDF-1.7 early Needle without nul");
        await fs.writeFile(
            oversized,
            `oversized Needle\n${"x".repeat(8 * 1024 * 1024)}`,
        );
        await fs.writeFile(path.join(grepRoot, ".gitignore"), "ignored.txt\n");

        const defaultResult = contentGrepResponseSchema.parse(
            await testAgent.grepContent(grepRoot, "(?i)needle", {
                timeoutSeconds: 5,
                includeHidden: false,
                respectGitignore: true,
                fixedString: false,
            }),
        );
        // Defaults must skip ignored, hidden-directory, and binary content while retaining visible matches.
        expect(defaultResult.results.map((entry) => entry.path)).toEqual([
            visible,
            visible,
        ]);
        // CRLF is normalized and physical line numbers remain one-based.
        expect(defaultResult.results[0]).toMatchObject({
            line_number: 1,
            line: "first Needle",
            line_truncated: false,
        });
        const truncatedLine = defaultResult.results.find(
            (entry) => entry.line_number === 2,
        );
        // Long response text is capped without omitting a still-bounded physical line.
        expect(truncatedLine?.line.length).toBe(500);
        expect(truncatedLine?.line_truncated).toBe(true);
        // Completing the small tree proves the response is final rather than deadline-partial.
        expect(defaultResult).toMatchObject({
            timed_out: false,
            cancelled: false,
            truncated: false,
        });

        const inclusiveResult = await testAgent.grepContent(
            grepRoot,
            "Needle",
            {
                timeoutSeconds: 5,
                includeHidden: true,
                respectGitignore: false,
                fixedString: false,
            },
        );
        // Explicit options expose ordinary hidden and ignored files but `.git` and binary files remain excluded.
        expect(
            new Set(inclusiveResult.results.map((entry) => entry.path)),
        ).toEqual(new Set([visible, hidden, ignored]));
    });

    it("should report grep result and oversized-line caps", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-bounded-grep" });
        const target = path.join(grepRoot, "many.txt");
        await fs.writeFile(
            target,
            `${Array.from({ length: 101 }, (_, index) => `match ${index}`).join("\n")}\n${"x".repeat(1024 * 1024 + 1)}\n`,
        );

        const result = await testAgent.grepContent(grepRoot, "match", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: false,
        });
        // The hard result ceiling bounds retained and serialized match state.
        expect(result.results).toHaveLength(100);
        // A discovered 101st match tells callers the otherwise complete response was clipped.
        expect(result.truncated).toBe(true);
        // Oversized physical lines are drained and counted rather than allocated or matched.
        expect(result.omitted_long_lines).toBe(1);
    });

    it("should return before and after context for each grep match", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-context-grep" });
        const target = path.join(grepRoot, "context.txt");
        await fs.writeFile(
            target,
            "zero\none\nfirst match\nbetween\nsecond match\nfive\n",
        );

        const result = await testAgent.grepContent(grepRoot, "match", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: true,
            beforeContext: 2,
            afterContext: 20,
        });
        const [firstMatch, secondMatch] = result.results;
        if (firstMatch === undefined || secondMatch === undefined) {
            throw new Error("Expected both context grep matches");
        }
        // Context is attached independently to each match rather than merged into shared blocks.
        expect(firstMatch.before_context).toEqual([
            { line_number: 1, line: "zero", line_truncated: false },
            { line_number: 2, line: "one", line_truncated: false },
        ]);
        // A matching line can also appear as context when it falls inside another match's window.
        expect(firstMatch.after_context).toEqual([
            { line_number: 4, line: "between", line_truncated: false },
            {
                line_number: 5,
                line: "second match",
                line_truncated: false,
            },
            { line_number: 6, line: "five", line_truncated: false },
        ]);
        // The second match gets its own preceding context, including the first match.
        expect(secondMatch.before_context.map((line) => line.line_number)).toEqual([3, 4]);
        // The file boundary naturally clips the maximum accepted context window.
        expect(secondMatch.after_context.map((line) => line.line)).toEqual(["five"]);
    });

    it("should validate grep timeout, context, and regular expressions", async () => {
        const testAgent = await getConnectedTestAgent();
        const timeoutUrl = getAgentGrepUrl();
        const timeoutResponse = await fetch(timeoutUrl, {
            method: "POST",
            headers: {
                ...testAgent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent: testAgent.id,
                path: agentCwd,
                query: "target",
                timeout: 61,
            }),
        });
        // REST validation rejects deadlines outside the documented caller-selected range.
        expect(timeoutResponse.status).toBe(400);

        const contextResponse = await fetch(getAgentGrepUrl(), {
            method: "POST",
            headers: {
                ...testAgent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent: testAgent.id,
                path: agentCwd,
                query: "target",
                before_context: 21,
            }),
        });
        // Context limits prevent one match from expanding into an unbounded response.
        expect(contextResponse.status).toBe(400);

        const afterContextResponse = await fetch(getAgentGrepUrl(), {
            method: "POST",
            headers: {
                ...testAgent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent: testAgent.id,
                path: agentCwd,
                query: "target",
                after_context: 21,
            }),
        });
        // Both context directions enforce the same response-size bound.
        expect(afterContextResponse.status).toBe(400);

        const regexResponse = await fetch(
            getAgentGrepUrl(),
            {
                method: "POST",
                headers: {
                    ...testAgent.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    agent: testAgent.id,
                    path: agentCwd,
                    query: "(",
                }),
            },
        );
        // Regex compilation errors are stable invalid-input responses rather than agent failures.
        expect(regexResponse.status).toBe(400);
        // The error body should identify the expression problem for API consumers.
        await expect(regexResponse.json()).resolves.toMatchObject({
            error: expect.stringContaining(
                "Invalid content grep regular expression",
            ),
        });
    });

    it("should grep a query as a literal string when requested", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-literal-grep" });
        const target = path.join(grepRoot, "text.txt");
        await fs.writeFile(target, "needle\nfoo(bar\n");

        const regexResult = await testAgent.grepContent(grepRoot, "nee.le", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: false,
        });
        // Default regex mode still treats `.` as any character.
        expect(regexResult.results.map((entry) => entry.line)).toEqual([
            "needle",
        ]);

        const literalDot = await testAgent.grepContent(grepRoot, "nee.le", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: true,
        });
        // The same query must not match when the period is required in the file.
        expect(literalDot.results).toEqual([]);

        const literalParens = await testAgent.grepContent(grepRoot, "foo(bar", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: true,
        });
        // Unbalanced parentheses are a valid needle once regex compilation is skipped.
        expect(literalParens.results.map((entry) => entry.line)).toEqual([
            "foo(bar",
        ]);
    });

    it("should return a deadline-partial grep response", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-timed-grep" });
        const chunk = "x".repeat(1024 * 1024 + 1);
        for (let index = 0; index < 128; index += 1) {
            await fs.writeFile(
                path.join(grepRoot, `large-${index}.txt`),
                chunk,
            );
        }

        const result = await testAgent.grepContent(grepRoot, "no-match", {
            timeoutSeconds: 1,
            includeHidden: false,
            respectGitignore: true,
            fixedString: false,
        });
        // The agent deadline returns bounded state rather than turning a long scan into an HTTP error.
        expect(result).toMatchObject({
            timed_out: true,
            cancelled: false,
        });
        // No-match input confirms any retained result still satisfies the expression after interruption.
        expect(result.results).toEqual([]);
    });

    it("should cancel an older grep while unrelated control commands remain responsive", async () => {
        const testAgent = await getConnectedTestAgent();
        const grepRoot = tempFiles.tempDirectory({ suffix: "-latest-grep" });
        const chunk = "x".repeat(1024 * 1024 + 1);
        await Promise.all(
            Array.from({ length: 64 }, (_, index) =>
                fs.writeFile(path.join(grepRoot, `large-${index}.txt`), chunk),
            ),
        );
        const agentProcess = processManager.getProcess(agentPid);
        if (!agentProcess) {
            throw new Error("Agent process not found");
        }
        const firstUrl = getAgentGrepUrl();
        const firstRequest = fetch(firstUrl, {
            method: "POST",
            headers: {
                ...testAgent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent: testAgent.id,
                path: grepRoot,
                query: "first-query-with-no-match",
            }),
        });
        await waitForLogMessage(
            agentProcess,
            new RegExp(
                `Content grep scan started: path=${grepRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            ),
        );

        const detailsResult = await Promise.race([
            testAgent.getDetails().then((details) => ({ details })),
            new Promise<{ timedOut: true }>((resolve) => {
                setTimeout(() => resolve({ timedOut: true }), 3000);
            }),
        ]);
        // A details command completing before grep termination proves control handling is not serialized behind scanning.
        expect(detailsResult).toMatchObject({ details: { id: testAgent.id } });

        const filenameSearch = searchAgentFiles(testAgent, grepRoot, {
            query: "large",
        });
        const firstCompletion = await Promise.race([
            firstRequest.then(() => "grep" as const),
            filenameSearch.then(() => "filename-search" as const),
        ]);
        // Independent cancellation state lets filename search finish without superseding the active content grep.
        expect(firstCompletion).toBe("filename-search");

        const replacement = await testAgent.grepContent(
            grepRoot,
            "replacement",
            {
                timeoutSeconds: 5,
                includeHidden: false,
                respectGitignore: true,
                fixedString: false,
            },
        );
        const firstResponse = contentGrepResponseSchema.parse(
            await (await firstRequest).json(),
        );
        // Latest-grep-wins returns a bounded terminal response to the superseded caller.
        expect(firstResponse).toMatchObject({
            cancelled: true,
            timed_out: false,
        });
        // The newest request acquires the one grep slot after its predecessor releases it.
        expect(replacement.cancelled).toBe(false);
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
