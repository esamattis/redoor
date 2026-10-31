import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { VITEST_PORT_COUNT } from "./integration-test-lanes.ts";

export type TestPorts = {
    /** First of the `VITEST_PORT_COUNT` consecutive ports the integration test workers use. */
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
    .refine(
        (ports) =>
            ports.playwright < ports.vitest ||
            ports.playwright >= ports.vitest + VITEST_PORT_COUNT,
        {
            message:
                "the playwright port must lie outside the vitest worker port range",
        },
    );

/** Loads the per-worktree ports generated before either test runner starts. */
function readTestPorts(): TestPorts {
    return testPortsSchema.parse(
        JSON.parse(readFileSync(TEST_PORTS_PATH, "utf8")),
    );
}

export const testPorts = readTestPorts();
