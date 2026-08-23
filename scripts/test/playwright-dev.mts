#!/usr/bin/env node
import {
    chmod,
    copyFile,
    glob,
    mkdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $, type ProcessPromise } from "zx";
import { z } from "zod";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOME_DIRECTORY = join(PROJECT_ROOT, ".test-playwright-home");
const STAGED_BINARY = join(HOME_DIRECTORY, "redoor-test-binary");
const AGENT1_TRASH_DIRECTORY = join(HOME_DIRECTORY, "agent1-trash");
const portsSchema = z.object({ playwright: z.number().int().positive() });

type Child = { name: string; process: ProcessPromise };

/** Removes only logs owned by this Playwright fixture. */
async function clearPlaywrightLogs(): Promise<void> {
    const logDirectory = join(PROJECT_ROOT, "log");
    for await (const fileName of glob("playwright-*.log", {
        cwd: logDirectory,
    })) {
        await rm(join(logDirectory, fileName), { force: true });
    }
}

/** Seeds enough history to verify bounded latest-log reads without prior suite activity. */
async function seedLogFixtures(): Promise<void> {
    const newline = `
`;
    const lines = Array.from(
        { length: 510 },
        (_, index) =>
            `[history-fixture] ${String(index + 1).padStart(3, "0")}`,
    );
    const agentLines = Array.from(
        { length: 510 },
        (_, index) =>
            `[agent-history-fixture] ${String(index + 1).padStart(3, "0")}`,
    );
    await Promise.all([
        writeFile(
            join(PROJECT_ROOT, "log/playwright-redoor.log"),
            lines.join(newline) + newline,
        ),
        writeFile(
            join(PROJECT_ROOT, "log/playwright-agent1_src.log"),
            agentLines.join(newline) + newline,
        ),
    ]);
}

/** Prepares isolated state and a binary that cannot change beneath this test run. */
async function prepareFixtures(): Promise<number> {
    await $({ cwd: PROJECT_ROOT, stdio: "inherit" })`pnpm run build`;
    await rm(HOME_DIRECTORY, { recursive: true, force: true });
    await mkdir(join(HOME_DIRECTORY, "lazy-agent"), { recursive: true });
    await mkdir(join(PROJECT_ROOT, "dev_agents/agent2"), { recursive: true });
    await copyFile(join(PROJECT_ROOT, "target/debug/redoor"), STAGED_BINARY);
    await chmod(STAGED_BINARY, 0o755);
    await clearPlaywrightLogs();
    await seedLogFixtures();
    await writeFile(
        join(PROJECT_ROOT, ".test-playwright-config.toml"),
        `agent_token = "test-agent-token"

[server]
username = "test-user"
password = "test-password"

[[agents]]
local = true
name = "lazy_managed"
home = ".test-playwright-home/lazy-agent"
log = "log/playwright-lazy-managed.log"

[[agents]]
local = true
name = "failing_managed"
home = ".test-playwright-home/missing-agent-directory"
log = "log/playwright-failing-managed.log"
`,
    );
    const ports = portsSchema.parse(
        JSON.parse(
            await readFile(join(PROJECT_ROOT, "test_ports.json"), "utf8"),
        ),
    );
    return ports.playwright;
}

/** Starts one owned child with inherited output so failures retain their original logs. */
function startChild(
    name: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
): Child {
    const processPromise = $({
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env: { ...process.env, ...environment },
    })`${STAGED_BINARY} ${args}`.nothrow();
    return { name, process: processPromise };
}

/** Stops every sibling and waits so no listener or reconnecting agent survives the wrapper. */
async function stopChildren(children: Child[]): Promise<void> {
    await Promise.allSettled(
        children.map(async (child) => {
            if (child.process.child?.exitCode !== null) {
                return;
            }
            await child.process.kill("SIGTERM").catch(() => undefined);
        }),
    );
    const gracefulExit = Promise.allSettled(
        children.map((child) => child.process),
    );
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
        gracefulExit.then(() => "exited" as const),
        new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), 2_000);
        }),
    ]);
    if (timeout !== undefined) {
        clearTimeout(timeout);
    }
    if (outcome === "timeout") {
        await Promise.allSettled(
            children.map((child) =>
                child.process.kill("SIGKILL").catch(() => undefined),
            ),
        );
        await gracefulExit;
    }
}

/** Fails fast when any shared process exits instead of letting later specs hit a dead server. */
async function supervise(): Promise<void> {
    const port = await prepareFixtures();
    const children = [
        startChild(
            "server",
            [
                "server",
                "--config",
                ".test-playwright-config.toml",
                "--port",
                String(port),
                "--log",
                "log/playwright-redoor.log",
            ],
            { HOME: HOME_DIRECTORY, REDOOR_PORT: String(port) },
        ),
        startChild(
            "agent1_src",
            [
                "agent",
                `ws://127.0.0.1:${port}/ws`,
                "--name",
                "agent1_src",
                "--token",
                "test-agent-token",
                "--home",
                PROJECT_ROOT,
                "--log",
                "log/playwright-agent1_src.log",
            ],
            {
                REDOOR_APP_NAME: "redoor-playwright-agent1",
                REDOOR_AGENT_TRASH_DIRECTORY: AGENT1_TRASH_DIRECTORY,
            },
        ),
        startChild(
            "agent2_custom",
            [
                "agent",
                `ws://127.0.0.1:${port}/ws`,
                "--name",
                "agent2_custom",
                "--token",
                "test-agent-token",
                "--home",
                join(PROJECT_ROOT, "dev_agents/agent2"),
                "--log",
                "log/playwright-agent2_custom.log",
            ],
            { REDOOR_APP_NAME: "redoor-playwright-agent2" },
        ),
    ];

    let finishSignal: ((signal: NodeJS.Signals) => void) | undefined;
    const signal = new Promise<NodeJS.Signals>((resolve) => {
        finishSignal = resolve;
    });
    const handleSignal = (received: NodeJS.Signals) => finishSignal?.(received);
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    try {
        const outcome = await Promise.race([
            signal.then((received) => ({ type: "signal" as const, received })),
            ...children.map(async (child) => ({
                type: "exit" as const,
                child,
                output: await child.process,
            })),
        ]);
        if (outcome.type === "exit") {
            throw new Error(
                `${outcome.child.name} exited unexpectedly with code ${outcome.output.exitCode}`,
            );
        }
    } finally {
        process.removeListener("SIGINT", handleSignal);
        process.removeListener("SIGTERM", handleSignal);
        await stopChildren(children);
    }
}

await supervise();
