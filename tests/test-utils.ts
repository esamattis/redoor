import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ApiClient, Agent } from "@/api-client";
import { Toxiproxy } from "toxiproxy-node-client";
import type Proxy from "toxiproxy-node-client/dist/Proxy";
import { testPorts } from "../test-ports.ts";

export async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Failed to get ephemeral port"));
                return;
            }

            server.close(() => resolve(address.port));
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
            status: options.agent.status,
            connected_at: options.agent.connectedAt,
            connection_id: options.agent.connectionId,
            last_seen_at: options.agent.lastSeenAt,
            connection_issue: options.agent.connectionIssue,
            binary: options.agent.binary,
            supports_self_exec: options.agent.supportsSelfExec,
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
            this.tempDir = mkdtempSync(join(tmpdir(), "redoor-test-"));
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
            this.tempDir = mkdtempSync(join(tmpdir(), "redoor-test-"));
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
export const SERVER_PATH = join(TESTS_DIRECTORY, "../target/debug/redoor");
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

export type SpawnAgentArgs = {
    wsAddress: string;
    executablePath?: string;
    name?: string;
    cwd: string;
    dir?: string;
    log?: string;
    token?: string;
};

export type SpawnServerArgs = {
    log?: string;
    config?: string;
};

/** Groups optional process settings so callers cannot confuse cwd and environment. */
type SpawnOptions = {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
};

export class ProcessManager {
    private processes: Map<number, ChildProcess> = new Map();
    private stdoutBuffers: Map<number, OutputBuffer> = new Map();

    spawn(
        command: string,
        args: string[],
        options: SpawnOptions = {},
    ): number {
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

        if (args.dir !== undefined) {
            cliArgs.push("--dir", args.dir);
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

        return this.spawn(args.executablePath ?? AGENT_PATH, cliArgs, {
            cwd: args.cwd,
        });
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

        mkdirSync(TEST_SERVER_HOME, { recursive: true });
        return this.spawn(SERVER_PATH, cliArgs, {
            cwd: PROJECT_ROOT,
            env: {
                HOME: TEST_SERVER_HOME,
                REDOOR_APP_NAME: "redoor",
            },
        });
    }

    kill(pid: number): void {
        try {
            // Spawned processes are detached group leaders, so kill the group
            // to prevent server-managed child agents surviving between runs.
            process.kill(-pid, "SIGKILL");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
                throw e;
            }
        }
        this.processes.delete(pid);
        this.stdoutBuffers.delete(pid);
    }

    killAll(): void {
        for (const pid of this.processes.keys()) {
            this.kill(pid);
        }
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

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for process ${pid} to exit`));
            }, timeoutMs);

            process.once("exit", (code) => {
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
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    process.env.REDOOR_PORT = serverPort.toString();
    const serverPid = options.processManager.spawnServer({});

    await waitForPort(serverPort);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    const serverProcess = options.processManager.getProcess(serverPid);
    if (!serverProcess) {
        throw new Error("Server process not found");
    }

    const waitForAgentPromise = waitForLogMessage(
        serverProcess,
        new RegExp(`Agent registered:.*agent_name=${options.agentName}`),
        10000,
    );
    const waitForTransferPromise = waitForAgentTransfer(
        serverProcess,
        options.agentName,
    );

    const agentPid = options.processManager.spawnAgent({
        wsAddress: wsUrl,
        name: options.agentName,
        cwd: options.agentCwd,
        dir: options.agentCwd,
        executablePath: options.agentExecutablePath,
    });

    await Promise.all([waitForAgentPromise, waitForTransferPromise]);

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

/** Waits until the agent's payload socket is router-owned before tests start streamed work. */
export async function waitForAgentTransfer(
    serverProcess: ChildProcess,
    agentId: string,
): Promise<void> {
    await waitForLogMessage(
        serverProcess,
        new RegExp(`Transfer socket registered: agent_id=${agentId},`),
        10000,
    );
}

export async function waitForPort(
    port: number,
    maxRetries = 50,
): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(
                `http://127.0.0.1:${port}/api/v1/agents`,
            );
            if (response.ok || response.status === 401) {
                return;
            }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Port ${port} not ready after ${maxRetries} retries`);
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
            if (value !== undefined) {
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
