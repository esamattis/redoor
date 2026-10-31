import { randomInt, randomUUID } from "node:crypto";
import { access, link, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { $ } from "zx";
import { z } from "zod";
import { isErrorCode } from "#error-utils";
import { VITEST_PORT_COUNT } from "../../integration-test-lanes.ts";

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

/** Lists the `count` consecutive ports starting at `firstPort`. */
function portRange(firstPort: number, count: number): number[] {
    return Array.from({ length: count }, (_, index) => firstPort + index);
}

/**
 * Picks a random block of `count` free high ports so separate worktrees are unlikely to
 * collide. The integration suite needs a block because every worker runs its own server.
 */
async function getRandomFreePorts(
    count: number,
    excludedPorts: Set<number>,
): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const firstPort = randomInt(10000, 60000 - count);
        let free = true;

        for (const port of portRange(firstPort, count)) {
            if (excludedPorts.has(port) || !(await isPortAvailable(port))) {
                free = false;
                break;
            }
        }

        if (free) {
            return firstPort;
        }
    }

    throw new Error("Could not find free test ports after 100 attempts");
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

/** Reserved port of each test suite, named as on the command line. */
type Suite = keyof z.infer<typeof reservedPortsSchema>;

/**
 * Reads which suites to clean from the command line, defaulting to both. A suite's lifecycle
 * hook names only its own suite so that starting it cannot kill the other suite's server
 * while that suite is running.
 */
function suitesToClean(): Suite[] {
    const requested = z
        .array(z.enum(["vitest", "playwright"]))
        .parse(process.argv.slice(2));

    return requested.length === 0 ? ["vitest", "playwright"] : requested;
}

/** Every port a suite's servers listen on, given its reserved port. */
function suitePorts(suite: Suite, reservedPort: number): number[] {
    // Each integration worker listens on its own port after the reserved one.
    return suite === "vitest"
        ? portRange(reservedPort, VITEST_PORT_COUNT)
        : [reservedPort];
}

/**
 * Clears leftover listeners on the already-reserved worktree ports of the given suites.
 * Returns false without cleaning anything when the port file predates the current worker
 * count and its Vitest port block now overlaps the Playwright port, so it must be recreated.
 */
async function freeExistingTestPorts(suites: Suite[]): Promise<boolean> {
    const ports = reservedPortsSchema.parse(
        JSON.parse(await readFile(TEST_PORTS_PATH, "utf8")),
    );

    if (suitePorts("vitest", ports.vitest).includes(ports.playwright)) {
        return false;
    }

    await Promise.all(
        suites.flatMap((suite) =>
            suitePorts(suite, ports[suite]).map((port) =>
                freeReservedPort(port),
            ),
        ),
    );

    return true;
}

/** Creates stable per-worktree ports once while tolerating concurrent invocations. */
async function ensureTestPorts(): Promise<void> {
    try {
        await access(TEST_PORTS_PATH);

        if (await freeExistingTestPorts(suitesToClean())) {
            return;
        }

        await rm(TEST_PORTS_PATH, { force: true });
    } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
            throw error;
        }
        // Continue to atomic creation when this worktree has no port file yet.
    }

    const vitest = await getRandomFreePorts(VITEST_PORT_COUNT, new Set());

    const playwright = await getRandomFreePorts(
        1,
        new Set(portRange(vitest, VITEST_PORT_COUNT)),
    );

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
