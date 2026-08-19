import { randomInt, randomUUID } from "node:crypto";
import { access, link, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { $ } from "zx";
import { z } from "zod";
import { isErrorCode } from "#error-utils";

const reservedPortsSchema = z.object({
    vitest: z.number().int(),
    playwright: z.number().int(),
});

const TEST_PORTS_PATH = fileURLToPath(
    new URL("../../test_ports.json", import.meta.url),
);

/** Returns whether a candidate port can currently be bound locally. */
async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const server = createServer();
        server.unref();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
            server.close(() => resolve(true));
        });
    });
}

/** Picks a random high port so separate worktrees are unlikely to collide. */
async function getRandomFreePort(excludedPorts: Set<number>): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const port = randomInt(10000, 60000);
        if (!excludedPorts.has(port) && (await isPortAvailable(port))) {
            return port;
        }
    }

    throw new Error("Could not find a free test port after 100 attempts");
}

/** Finds listeners so a leftover Playwright or Vitest server cannot block the next run. */
async function listenerPids(port: number): Promise<number[]> {
    const result =
        await $`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`.nothrow();
    if (result.exitCode !== 0) {
        // lsof exits 1 when the reserved port is already free.
        return [];
    }
    return [
        ...new Set(
            result.stdout
                .split(/\s+/)
                .map(Number)
                .filter((pid) => pid > 0),
        ),
    ];
}

/** Limits cleanup to this worktree's leftover redoor processes, not unrelated listeners. */
async function isWorktreeRedoor(pid: number): Promise<boolean> {
    // ps and lsof work on both Linux and macOS; /proc does not exist on Darwin.
    const args = await $`ps -p ${pid} -o args=`.nothrow();
    if (args.exitCode !== 0 || !args.stdout.includes("redoor")) {
        return false;
    }
    const cwdListing = await $`lsof -a -p ${pid} -d cwd -Fn`.nothrow();
    if (cwdListing.exitCode !== 0) {
        return false;
    }
    const cwd = cwdListing.stdout
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1);
    return cwd === process.cwd();
}

/** Reaps a leftover test server so Playwright does not refuse to start. */
async function freeReservedPort(port: number): Promise<void> {
    if (await isPortAvailable(port)) {
        return;
    }

    for (const pid of await listenerPids(port)) {
        if (await isWorktreeRedoor(pid)) {
            try {
                process.kill(pid, "SIGTERM");
            } catch (error) {
                if (!isErrorCode(error, "ESRCH")) {
                    throw error;
                }
            }
        }
    }

    for (let attempt = 0; attempt < 20; attempt++) {
        if (await isPortAvailable(port)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (const pid of await listenerPids(port)) {
        if (await isWorktreeRedoor(pid)) {
            try {
                process.kill(pid, "SIGKILL");
            } catch (error) {
                if (!isErrorCode(error, "ESRCH")) {
                    throw error;
                }
            }
        }
    }

    for (let attempt = 0; attempt < 20; attempt++) {
        if (await isPortAvailable(port)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Test port ${port} remains occupied after cleanup`);
}

/** Clears leftover listeners on the already-reserved worktree ports. */
async function freeExistingTestPorts(): Promise<void> {
    const ports = reservedPortsSchema.parse(
        JSON.parse(await readFile(TEST_PORTS_PATH, "utf8")),
    );
    await Promise.all([
        freeReservedPort(ports.vitest),
        freeReservedPort(ports.playwright),
    ]);
}

/** Creates stable per-worktree ports once while tolerating concurrent invocations. */
async function ensureTestPorts(): Promise<void> {
    try {
        await access(TEST_PORTS_PATH);
        await freeExistingTestPorts();
        return;
    } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
            throw error;
        }
        // Continue to atomic creation when this worktree has no port file yet.
    }

    const vitest = await getRandomFreePort(new Set());
    const playwright = await getRandomFreePort(new Set([vitest]));
    const temporaryPath = `${TEST_PORTS_PATH}.${process.pid}.${randomUUID()}`;

    try {
        await writeFile(
            temporaryPath,
            `${JSON.stringify({ vitest, playwright }, null, 4)}\n`,
            { flag: "wx" },
        );
        await link(temporaryPath, TEST_PORTS_PATH);
    } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
            throw error;
        }
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

await ensureTestPorts();
