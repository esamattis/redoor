import { spawn, ChildProcess } from "node:child_process";
import {
    mkdtempSync,
    writeFileSync,
    rmSync,
    mkdirSync,
    realpathSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ApiClient, Agent } from "#ui/api-client";
import type { AccessTokenResponse } from "#bindings/AccessTokenResponse";
import type { DeviceScope } from "#bindings/DeviceScope";
import type { Permission } from "#bindings/Permission";
import { ApiError } from "#ui/api-transport";
import { onTestFinished } from "vitest";
import { Toxiproxy } from "toxiproxy-node-client";
import type Proxy from "toxiproxy-node-client/dist/Proxy";
import { testPorts } from "#test-ports";
import { isErrorCode } from "#error-utils";
import type WebSocket from "ws";
import { z } from "zod";

const tcpAddressSchema = z.object({ port: z.number().int().positive() });

/** Normalizes every WebSocket payload representation before tests decode its contents. */
export function webSocketDataToString(data: WebSocket.RawData): string {
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString();
    }

    return data instanceof ArrayBuffer
        ? Buffer.from(data).toString()
        : data.toString();
}

export async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = tcpAddressSchema.safeParse(server.address());

            if (!address.success) {
                reject(new Error("Failed to get ephemeral port"));

                return;
            }

            server.close(() => resolve(address.data.port));
        });
        server.on("error", reject);
    });
}

export async function createToxiproxyAgent(options: {
    serverPort: number;
    agent: Agent;
    proxyNamePrefix: string;
}): Promise<{
    toxiproxy: Toxiproxy;
    proxy: Proxy;
    proxiedAgent: Agent;
}> {
    const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
    const proxyPort = await getAvailablePort();

    const proxy = await toxiproxy.createProxy({
        name: `${options.proxyNamePrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        listen: `127.0.0.1:${proxyPort}`,
        upstream: `127.0.0.1:${options.serverPort}`,
    });

    const proxiedAgent = new Agent(
        `http://${proxy.listen}`,
        {
            id: options.agent.id,
            name: options.agent.name,
            cwd: options.agent.cwd,
            managed: options.agent.managed,
            configuration_editable: options.agent.configurationEditable,
            ssh_target: options.agent.sshTarget,
            status: options.agent.status,
            connected_at: options.agent.connectedAt,
            connection_id: options.agent.connectionId,
            last_seen_at: options.agent.lastSeenAt,
            connection_issue: options.agent.connectionIssue,
            provisioning_status: options.agent.provisioningStatus,
            binary: options.agent.binary,
            supports_native_open: options.agent.supportsNativeOpen,
            supports_move_to_trash: options.agent.supportsMoveToTrash,
            supports_trash: options.agent.supportsTrash,
            supports_upload_preconditions:
                options.agent.supportsUploadPreconditions,
            uid: options.agent.uid,
            is_root: options.agent.isRoot,
            // The proxy only reroutes traffic; clone warnings are irrelevant to it.
            duplicate_id: null,
        },
        {
            getSessionCookie: () =>
                options.agent.getAuthHeaders().Cookie ?? null,
        },
    );

    return {
        toxiproxy,
        proxy,
        proxiedAgent,
    };
}

/**
 * Manages temporary files for tests. Files are automatically cleaned up
 * when cleanup() is called (typically in afterEach).
 */
export class TempFileManager {
    private files: string[] = [];
    private dirs: string[] = [];
    private tempDir: string | null = null;

    /**
     * Get a temporary file path. The file will be tracked for automatic cleanup.
     * If create is true, the file will be created with the given content.
     */
    tempFile(options?: {
        suffix?: string;
        content?: string | Buffer;
        encoding?: BufferEncoding;
    }): string {
        if (!this.tempDir) {
            this.tempDir = realpathSync(
                mkdtempSync(join(tmpdir(), "redoor-test-")),
            );
        }

        const suffix = options?.suffix ?? ".tmp";

        const filePath = join(
            this.tempDir,
            `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
        );

        this.files.push(filePath);

        if (options?.content !== undefined) {
            writeFileSync(filePath, options.content, options.encoding);
        }

        return filePath;
    }

    /**
     * Create a temporary file with the given content.
     * Shorthand for tempFile with content option.
     */
    create(
        content: string | Buffer,
        options?: { suffix?: string; encoding?: BufferEncoding },
    ): string {
        return this.tempFile({ ...options, content });
    }

    /**
     * Create and track a temporary directory.
     */
    tempDirectory(options?: { suffix?: string }): string {
        if (!this.tempDir) {
            this.tempDir = realpathSync(
                mkdtempSync(join(tmpdir(), "redoor-test-")),
            );
        }

        const suffix = options?.suffix ?? "";

        const directoryPath = join(
            this.tempDir,
            `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
        );

        mkdirSync(directoryPath, { recursive: true });
        this.dirs.push(directoryPath);

        return directoryPath;
    }

    /**
     * Clean up all temporary files created by this manager.
     */
    cleanup(): void {
        for (const filePath of this.dirs) {
            try {
                rmSync(filePath, { recursive: true, force: true });
            } catch {
                // File or directory may not exist, ignore
            }
        }

        this.files = [];

        if (this.tempDir) {
            try {
                rmSync(this.tempDir, { recursive: true, force: true });
            } catch {
                // Directory may not exist, ignore
            }

            this.tempDir = null;
        }
    }

    /**
     * Empty the directory of all files and subdirectories, but keep the directory itself.
     */
    emptyDirs(): void {
        for (const filePath of this.files) {
            try {
                rmSync(filePath, { recursive: true, force: true });
                mkdirSync(filePath, { recursive: true });
            } catch {
                // Directory may not exist, ignore
            }
        }
    }
}

const TESTS_DIRECTORY = dirname(import.meta.filename);

const PROJECT_ROOT = join(TESTS_DIRECTORY, "..");

export const SERVER_PATH =
    process.env.REDOOR_TEST_BINARY ??
    join(TESTS_DIRECTORY, "../target/debug/redoor");

export const AGENT_PATH = SERVER_PATH;

// A per-worktree port lets Vitest run alongside development and other worktrees.
export const VITEST_SERVER_PORT = testPorts.vitest;

export const TEST_USERNAME = "test-user";

export const TEST_PASSWORD = "test-password";

export const TEST_AGENT_TOKEN = "test-agent-token";

const DEFAULT_TEST_CONFIG = join(
    tmpdir(),
    `redoor-vitest-${VITEST_SERVER_PORT}.toml`,
);

export const TEST_SERVER_HOME = join(
    tmpdir(),
    `redoor-vitest-home-${VITEST_SERVER_PORT}`,
);

export const TEST_APP_NAME = `redoor-vitest-${VITEST_SERVER_PORT}`;

export type SpawnAgentArgs = {
    wsAddress: string;
    executablePath?: string;
    name?: string;
    cwd: string;
    home?: string;
    log?: string;
    token?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Fixed `--agent-id`, for tests that restart an agent and keep addressing it by id.
     * Without it the agent creates its own id in its data directory, like a real standalone
     * agent.
     */
    agentId?: string;
    /**
     * `REDOOR_APP_NAME` whose data directory holds the agent's `agent-id` file. A caller-chosen
     * name survives `kill()`, so restarting with the same name keeps the device id; the caller
     * removes it with `removeAgentDataDir`. Without it every spawn gets a fresh, private data
     * directory and therefore a fresh id.
     */
    appName?: string;
};

export type SpawnServerArgs = {
    log?: string;
    config?: string;
    /** Isolates durable server state while allowing restart tests to reuse the same home. */
    home?: string;
};

/** Groups optional process settings so callers cannot confuse cwd and environment. */
type SpawnOptions = {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
};

/**
 * Data directory of a standalone test agent started with `REDOOR_APP_NAME=appName`; it holds
 * the agent's `agent-id` file. Test agents inherit the runner's `HOME`.
 */
export function agentDataDir(appName: string): string {
    const home = process.env.HOME;

    if (home === undefined) {
        throw new Error("HOME is not set");
    }

    return join(home, ".local", "share", appName);
}

/** Deletes a test agent's data directory, and with it the device id it remembers. */
export function removeAgentDataDir(appName: string): void {
    rmSync(agentDataDir(appName), { recursive: true, force: true });
}

export class ProcessManager {
    private processes: Map<number, ChildProcess> = new Map();
    private stdoutBuffers: Map<number, OutputBuffer> = new Map();
    private agentAppNames: Map<number, string> = new Map();
    private agentNamespace = 0;

    spawn(command: string, args: string[], options: SpawnOptions = {}): number {
        const proc = spawn(command, args, {
            detached: true,
            stdio: ["ignore", "pipe", "inherit"],
            cwd: options.cwd ?? PROJECT_ROOT,
            env: {
                ...process.env,
                RUST_BACKTRACE: "1",
                // Integration agents must not flash desktop notifications during development.
                REDOOR_AGENT_NOTIFICATION: "off",
                ...options.env,
            },
        });

        const pid = proc.pid;

        if (pid === undefined) {
            throw new Error("Failed to get process PID");
        }

        this.processes.set(pid, proc);

        if (proc.stdout) {
            const stdoutBuffer = new OutputBuffer(5000);
            proc.stdout.on("data", (chunk: Buffer) => {
                stdoutBuffer.add(chunk.toString());
            });
            this.stdoutBuffers.set(pid, stdoutBuffer);
        }

        return pid;
    }

    spawnAgent(args: SpawnAgentArgs): number {
        const cliArgs = [
            "agent",
            args.wsAddress,
            "--token",
            args.token ?? TEST_AGENT_TOKEN,
        ];

        if (args.name !== undefined) {
            cliArgs.push("--name", args.name);
        }

        if (args.agentId !== undefined) {
            cliArgs.push("--agent-id", args.agentId);
        }

        if (args.home !== undefined) {
            cliArgs.push("--home", args.home);
        }

        if (args.log !== undefined) {
            rmSync(args.log, { force: true });
            cliArgs.push("--log", args.log);
        } else {
            const logPath = join(
                PROJECT_ROOT,
                "log",
                `${args.name ?? "hostname-agent"}.log`,
            );

            rmSync(logPath, { force: true });
            cliArgs.push("--log", logPath);
        }

        const appName =
            args.appName ?? `${TEST_APP_NAME}-agent-${this.agentNamespace++}`;

        if (args.appName === undefined) {
            // Namespaces restart at 0 in every test file, so a data directory left behind by a
            // crashed run would otherwise hand its device id to an unrelated agent.
            removeAgentDataDir(appName);
        }

        const pid = this.spawn(args.executablePath ?? AGENT_PATH, cliArgs, {
            cwd: args.cwd,
            env: {
                REDOOR_APP_NAME: appName,
                ...args.env,
            },
        });

        if (args.appName === undefined) {
            this.agentAppNames.set(pid, appName);
        }

        return pid;
    }

    spawnServer(args: SpawnServerArgs): number {
        const cliArgs: string[] = ["server"];
        const configPath = args.config ?? DEFAULT_TEST_CONFIG;

        if (args.config === undefined) {
            writeFileSync(
                configPath,
                `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
`,
            );
        }

        cliArgs.push("--config", configPath);

        if (args.log !== undefined) {
            rmSync(args.log, { force: true });
            cliArgs.push("--log", args.log);
        }

        const serverHome = args.home ?? TEST_SERVER_HOME;

        mkdirSync(serverHome, { recursive: true });

        return this.spawn(SERVER_PATH, cliArgs, {
            cwd: PROJECT_ROOT,
            env: {
                HOME: serverHome,
                REDOOR_APP_NAME: TEST_APP_NAME,
            },
        });
    }

    kill(pid: number): void {
        try {
            // Spawned processes are detached group leaders, so kill the group
            // to prevent server-managed child agents surviving between runs.
            process.kill(-pid, "SIGKILL");
        } catch (error) {
            if (!isErrorCode(error, "ESRCH")) {
                throw error;
            }
        }

        this.processes.delete(pid);
        this.stdoutBuffers.delete(pid);
        const appName = this.agentAppNames.get(pid);

        if (appName !== undefined) {
            removeAgentDataDir(appName);
        }

        this.agentAppNames.delete(pid);
    }

    /** Terminates one owned process and waits for its resources to be released. */
    async killAndWait(pid: number): Promise<void> {
        const child = this.processes.get(pid);

        if (child === undefined) {
            return;
        }

        const exit = this.waitForChildExit(pid, child);
        this.kill(pid);
        await exit;
    }

    /** Reaps every owned process before the next serial test file can reuse its port. */
    async killAll(): Promise<void> {
        const processes = [...this.processes.entries()];

        const exits = processes.map(([pid, child]) =>
            this.waitForChildExit(pid, child),
        );

        for (const [pid] of processes) {
            this.kill(pid);
        }

        await Promise.all(exits);
    }

    getProcess(pid: number): ChildProcess | undefined {
        return this.processes.get(pid);
    }

    getStdout(pid: number): string {
        return this.stdoutBuffers.get(pid)?.getContent() ?? "";
    }

    async waitForExit(
        pid: number,
        timeoutMs: number = 10000,
    ): Promise<number | null> {
        const process = this.processes.get(pid);

        if (!process) {
            throw new Error(`Process not found: ${pid}`);
        }

        return this.waitForChildExit(pid, process, timeoutMs);
    }

    /** Handles already-finished children as well as exits observed after teardown starts. */
    private async waitForChildExit(
        pid: number,
        child: ChildProcess,
        timeoutMs: number = 10000,
    ): Promise<number | null> {
        if (child.exitCode !== null || child.signalCode !== null) {
            return child.exitCode;
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for process ${pid} to exit`));
            }, timeoutMs);

            child.once("exit", (code) => {
                clearTimeout(timeout);
                resolve(code);
            });
        });
    }
}

export async function startServerAndAgent(options: {
    processManager: ProcessManager;
    agentName: string;
    agentCwd: string;
    agentExecutablePath?: string;
    agentEnv?: NodeJS.ProcessEnv;
}): Promise<{
    serverPort: number;
    serverPid: number;
    agentPid: number;
    apiClient: ApiClient;
    testAgent: Agent;
    wsUrl: string;
}> {
    const serverPort = VITEST_SERVER_PORT;
    const apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);
    const wsUrl = `ws://127.0.0.1:${serverPort}/api/v1/agent/ws`;

    process.env.REDOOR_PORT = serverPort.toString();
    const serverPid = options.processManager.spawnServer({});

    await waitForPort(serverPort);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    const serverProcess = options.processManager.getProcess(serverPid);

    if (!serverProcess) {
        throw new Error("Server process not found");
    }

    const waitForAgentPromise = waitForAgentReady(
        serverProcess,
        options.agentName,
    );

    const agentPid = options.processManager.spawnAgent({
        wsAddress: wsUrl,
        name: options.agentName,
        cwd: options.agentCwd,
        home: options.agentCwd,
        executablePath: options.agentExecutablePath,
        env: options.agentEnv,
    });

    await waitForAgentPromise;

    const agents = await apiClient.listAgents();
    const testAgent = agents.find((agent) => agent.name === options.agentName);

    if (!testAgent) {
        throw new Error(`Agent ${options.agentName} was not registered`);
    }

    return {
        serverPort,
        serverPid,
        agentPid,
        apiClient,
        testAgent,
        wsUrl,
    };
}

/** RFC 4648 base32 alphabet in lowercase, the character set of device ids. */
const DEVICE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Pattern of a device id, for matching ids in log lines and API responses. */
export const DEVICE_ID_PATTERN = "dev_[a-z2-7]{20}";

/** Matches a whole value that is a device id. */
export const DEVICE_ID_REGEXP = new RegExp(`^${DEVICE_ID_PATTERN}$`);

/**
 * Creates a fresh device id in the format the router requires in `hello`.
 *
 * Every test that needs an id it controls (fake agents, `--agent-id`, config entries) uses
 * this, so a change of the id format only has to be made here.
 */
export function generateDeviceId(): string {
    const random = [...randomBytes(20)]
        .map((byte) => DEVICE_ID_ALPHABET[byte % 32])
        .join("");

    return `dev_${random}`;
}

/** Escapes a literal for use inside a `RegExp`, since device names may contain metacharacters. */
export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the router's registration log line for the device called `agentName`.
 *
 * The line logs the opaque id first and the name second, so tests that only know the name
 * they started the agent with match on the name and capture the id.
 */
export function agentRegisteredPattern(agentName: string): RegExp {
    return new RegExp(
        `Agent registered: agent_id=(${DEVICE_ID_PATTERN}), agent_name=${escapeRegExp(agentName)},`,
    );
}

/** Waits until the router accepted the agent's connection, which carries all of its streams. */
export async function waitForAgentReady(
    serverProcess: ChildProcess,
    agentName: string,
    timeoutMs = 10000,
): Promise<void> {
    await waitForLogMessage(
        serverProcess,
        agentRegisteredPattern(agentName),
        timeoutMs,
    );
}

/**
 * Waits until a server answers its API on `port`.
 *
 * The budget is time-based and generous because a debug server can take well over five
 * seconds to start while the integration and Playwright suites run in parallel.
 */
export async function waitForPort(
    port: number,
    timeoutMs = 30_000,
): Promise<void> {
    await waitForValue({
        timeoutMs,
        intervalMs: 100,
        description: `server API on port ${port}`,
        predicate: async () => {
            const response = await fetch(
                `http://127.0.0.1:${port}/api/v1/agents`,
            );

            return response.ok || response.status === 401;
        },
    });
}

/**
 * Accumulates output from a stream for later inspection.
 * Helps avoid race conditions where output is emitted before listeners are attached.
 */
class OutputBuffer {
    private chunks: string[] = [];
    private maxSize: number;

    constructor(maxSize: number = 1000) {
        this.maxSize = maxSize;
    }

    add(chunk: string): void {
        this.chunks.push(chunk);

        if (this.chunks.length > this.maxSize) {
            this.chunks.shift();
        }
    }

    getContent(): string {
        return this.chunks.join("");
    }

    matches(pattern: RegExp): boolean {
        return pattern.test(this.getContent());
    }
}

/**
 * Waits for a log pattern to appear in the process output.
 * Uses an OutputBuffer to capture all output from the start, avoiding race conditions
 * where the pattern is emitted before this function is called.
 */
export async function waitForLogMessage(
    process: ChildProcess,
    pattern: RegExp,
    timeoutMs: number = 10000,
): Promise<void> {
    const stdout = process.stdout;

    if (!stdout) {
        throw new Error("No stdout stream available");
    }

    const stdoutBuffer = new OutputBuffer();

    let resolve: () => void;
    let reject: (error: Error) => void;

    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const checkPattern = () => {
        if (stdoutBuffer.matches(pattern)) {
            clearTimeout(timeout);
            cleanup();
            resolve();
        }
    };

    const onStdoutData = (chunk: Buffer) => {
        stdoutBuffer.add(chunk.toString());
        checkPattern();
    };

    const cleanup = () => {
        stdout.off("data", onStdoutData);
    };

    stdout.on("data", onStdoutData);

    // Check immediately in case the pattern was already emitted
    checkPattern();

    const timeout = setTimeout(() => {
        cleanup();
        const stdoutContent = stdoutBuffer.getContent().slice(-2000);
        reject(
            new Error(
                `Timeout waiting for log pattern: ${pattern}\n\n` +
                    `Last stdout (up to 2000 chars):\n${stdoutContent}`,
            ),
        );
    }, timeoutMs);

    return promise;
}

/** Polls until a value or successful boolean condition is available instead of racing async cleanup. */
export async function waitForValue<T>(options: {
    predicate: () => Promise<T | undefined>;
    timeoutMs?: number;
    intervalMs?: number;
    description: string;
}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const intervalMs = options.intervalMs ?? 50;
    const start = Date.now();
    let lastError: Error | undefined;

    while (Date.now() - start < timeoutMs) {
        try {
            const value = await options.predicate();

            if (value !== undefined && value !== false) {
                return value;
            }

            lastError = undefined;
        } catch (error) {
            lastError =
                error instanceof Error ? error : new Error(String(error));
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const errorSuffix = lastError ? `: ${lastError.message}` : "";
    throw new Error(`Timeout waiting for ${options.description}${errorSuffix}`);
}

/** Counts startups recorded in a server log; a restart re-executes startup and appends one. */
async function countServerStartups(serverLog: string): Promise<number> {
    try {
        const log = await readFile(serverLog, "utf8");

        return log.match(/Loaded server config/g)?.length ?? 0;
    } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
            return 0;
        }

        throw error;
    }
}

/**
 * Restarts the server and waits until the re-executed process answers API requests.
 *
 * The restart endpoint replies before the old process shuts down, so polling the API alone
 * can be answered by the old process, and the next request then finds nothing listening on
 * the port. Waiting for the new startup in the log first rules that out.
 */
export async function restartServerAndWait(options: {
    apiClient: ApiClient;
    serverLog: string;
    timeoutMs?: number;
}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const startups = await countServerStartups(options.serverLog);
    await options.apiClient.restartServer();
    await waitForValue({
        timeoutMs,
        description: "restarted server startup in its log",
        predicate: async () =>
            (await countServerStartups(options.serverLog)) > startups,
    });
    await waitForValue({
        timeoutMs,
        description: "restarted server to serve API requests",
        predicate: async () => {
            await options.apiClient.listAgents();

            return true;
        },
    });
}

/** Every grantable permission, for tokens that should behave like the old full-access CLI. */
export const ALL_PERMISSIONS: Permission[] = [
    "files:read",
    "files:write",
    "files:delete",
    "commands:execute",
    "agents:manage",
];

/**
 * Mints an access token through the session-authenticated REST API. Inside a test the token is
 * deleted when the test finishes, so tests cannot leak credentials into later tests.
 */
export async function createAccessToken(
    apiClient: ApiClient,
    options: {
        name?: string;
        permissions: Permission[];
        devices?: DeviceScope;
        expiresAt?: string | null;
    },
): Promise<{ token: string; metadata: AccessTokenResponse }> {
    const created = await apiClient.createAccessToken({
        name: options.name ?? "integration test token",
        permissions: options.permissions,
        devices: options.devices ?? { kind: "all" },
        expires_at: options.expiresAt ?? null,
    });

    try {
        onTestFinished(async () => {
            try {
                await apiClient.deleteAccessToken(created.metadata.id);
            } catch (error) {
                // Tests that revoke or rotate-and-delete their token already cleaned up.
                if (!(error instanceof ApiError && error.status === 404)) {
                    throw error;
                }
            }
        });
    } catch {
        // Outside a test (beforeAll) the token lives as long as the test server.
    }

    return { token: created.token, metadata: created.metadata };
}

/** Environment that lets the remote CLI authenticate with a token without a saved login. */
export function remoteEnv(baseUrl: string, token: string) {
    return { REDOOR_REMOTE_SERVER: baseUrl, REDOOR_REMOTE_TOKEN: token };
}
