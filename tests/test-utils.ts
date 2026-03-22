import { spawn, ChildProcess } from "node:child_process";
import {
    mkdtempSync,
    writeFileSync,
    unlinkSync,
    rmSync,
    mkdirSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, Agent } from "@/api-client";

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

/**
 * Manages temporary files for tests. Files are automatically cleaned up
 * when cleanup() is called (typically in afterEach).
 */
export class TempFileManager {
    private files: string[] = [];
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
        this.files.push(directoryPath);
        return directoryPath;
    }

    /**
     * Clean up all temporary files created by this manager.
     */
    cleanup(): void {
        for (const filePath of this.files) {
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
}

export class ProcessManager {
    private processes: Map<number, ChildProcess> = new Map();

    spawn(command: string, args: string[], cwd?: string): number {
        const proc = spawn(command, args, {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            cwd,
        });

        const pid = proc.pid;
        if (pid === undefined) {
            throw new Error("Failed to get process PID");
        }

        this.processes.set(pid, proc);
        return pid;
    }

    kill(pid: number): void {
        try {
            process.kill(pid, "SIGKILL");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
                throw e;
            }
        }
        this.processes.delete(pid);
    }

    killAll(): void {
        for (const pid of this.processes.keys()) {
            this.kill(pid);
        }
    }

    getProcess(pid: number): ChildProcess | undefined {
        return this.processes.get(pid);
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
    serverPath: string;
    agentPath: string;
    agentName: string;
    projectRoot: string;
}): Promise<{
    serverPort: number;
    serverPid: number;
    apiClient: ApiClient;
    testAgent: Agent;
    wsUrl: string;
}> {
    const serverPort = await getAvailablePort();
    const apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    process.env.REDOOR_PORT = serverPort.toString();
    const serverPid = options.processManager.spawn(
        options.serverPath,
        [],
        options.projectRoot,
    );

    await waitForPort(serverPort);

    const serverProcess = options.processManager.getProcess(serverPid);
    if (!serverProcess) {
        throw new Error("Server process not found");
    }

    const waitForAgentPromise = waitForLogMessage(
        serverProcess,
        new RegExp(`Agent registered:.*agent_name=${options.agentName}`),
        10000,
    );

    options.processManager.spawn(
        options.agentPath,
        [wsUrl, "--name", options.agentName],
        options.projectRoot,
    );

    await waitForAgentPromise;

    const agents = await apiClient.listAgents();
    const testAgent = agents.find((agent) => agent.name === options.agentName);
    if (!testAgent) {
        throw new Error(`Agent ${options.agentName} was not registered`);
    }

    return {
        serverPort,
        serverPid,
        apiClient,
        testAgent,
        wsUrl,
    };
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
            if (response.ok) {
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
    // Get both stdout and stderr streams
    const stdout = process.stdout;
    const stderr = process.stderr;

    if (!stdout && !stderr) {
        throw new Error("No stdout/stderr stream available");
    }

    // Use output buffers to track all output from both streams
    const stdoutBuffer = new OutputBuffer();
    const stderrBuffer = new OutputBuffer();

    let resolve: () => void;
    let reject: (error: Error) => void;

    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const checkPattern = () => {
        if (stdoutBuffer.matches(pattern) || stderrBuffer.matches(pattern)) {
            clearTimeout(timeout);
            cleanup();
            resolve();
        }
    };

    const onStdoutData = (chunk: Buffer) => {
        stdoutBuffer.add(chunk.toString());
        checkPattern();
    };

    const onStderrData = (chunk: Buffer) => {
        stderrBuffer.add(chunk.toString());
        checkPattern();
    };

    const cleanup = () => {
        if (stdout) stdout.off("data", onStdoutData);
        if (stderr) stderr.off("data", onStderrData);
    };

    if (stdout) stdout.on("data", onStdoutData);
    if (stderr) stderr.on("data", onStderrData);

    // Check immediately in case the pattern was already emitted
    checkPattern();

    const timeout = setTimeout(() => {
        cleanup();
        const stdoutContent = stdoutBuffer.getContent().slice(-2000);
        const stderrContent = stderrBuffer.getContent().slice(-2000);
        reject(
            new Error(
                `Timeout waiting for log pattern: ${pattern}\n\n` +
                    `Last stdout (up to 2000 chars):\n${stdoutContent}\n\n` +
                    `Last stderr (up to 2000 chars):\n${stderrContent}`,
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
