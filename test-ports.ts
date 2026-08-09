import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type TestPorts = {
    vitest: number;
    playwright: number;
};

const TEST_PORTS_PATH = fileURLToPath(
    new URL("./test_ports.json", import.meta.url),
);
const testPortsSchema = z
    .object({
        vitest: z.number().int(),
        playwright: z.number().int(),
    })
    .refine((ports) => ports.vitest !== ports.playwright, {
        message: "vitest and playwright ports must be distinct",
    });

/** Loads the per-worktree ports generated before either test runner starts. */
function readTestPorts(): TestPorts {
    return testPortsSchema.parse(
        JSON.parse(readFileSync(TEST_PORTS_PATH, "utf8")),
    );
}

export const testPorts = readTestPorts();
