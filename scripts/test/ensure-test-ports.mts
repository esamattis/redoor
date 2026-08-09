import { randomInt, randomUUID } from "node:crypto";
import { access, link, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { isErrorCode } from "#error-utils";

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

/** Creates stable per-worktree ports once while tolerating concurrent invocations. */
async function ensureTestPorts(): Promise<void> {
    try {
        await access(TEST_PORTS_PATH);
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
