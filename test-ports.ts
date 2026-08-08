import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TestPorts = {
    vitest: number;
    playwright: number;
};

const TEST_PORTS_PATH = fileURLToPath(
    new URL("./test_ports.json", import.meta.url),
);

/** Loads the per-worktree ports generated before either test runner starts. */
function readTestPorts(): TestPorts {
    const ports = JSON.parse(
        readFileSync(TEST_PORTS_PATH, "utf8"),
    ) as Partial<TestPorts>;

    if (
        !Number.isInteger(ports.vitest) ||
        !Number.isInteger(ports.playwright) ||
        ports.vitest === ports.playwright
    ) {
        throw new Error(
            "test_ports.json must contain distinct integer vitest and playwright ports",
        );
    }

    return ports as TestPorts;
}

export const testPorts = readTestPorts();
