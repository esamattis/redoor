import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

/** Small limit so a few hundred lines are enough to exceed it. */
const LOG_MAX_BYTES = 4 * 1024;

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

let apiClient: ApiClient;

let serverLog: string;

/** Builds numbered lines so assertions can tell which half of a log survived. */
function seedLines(count: number): string {
    return Array.from(
        { length: count },
        (_, index) => `seed-line-${index.toString().padStart(4, "0")}\n`,
    ).join("");
}

beforeAll(async () => {
    serverLog = tempFiles.tempFile({ suffix: "-server.log" });
    // Seeded over the limit so the startup check has something to truncate.
    writeFileSync(serverLog, seedLines(1000));

    const configPath = tempFiles.tempFile({ suffix: ".toml" });
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
log = "${serverLog}"
log_max_size = "${LOG_MAX_BYTES / 1024}KB"
`,
    );
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    // No --log flag: the seeded path must come from the config so it is not deleted first.
    processManager.spawnServer({ config: configPath });
    await waitForPort(VITEST_SERVER_PORT);
    apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
});

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

describe("Log rotation", () => {
    it("truncates an oversized server log to its newer half on startup", () => {
        const log = readFileSync(serverLog, "utf8");

        // The oldest lines are dropped when the log is over its configured limit.
        expect(log).not.toContain("seed-line-0000");
        // The newest seeded history is kept instead of clearing the whole file.
        expect(log).toContain("seed-line-0999");
        // The running server keeps appending to the truncated file.
        expect(log).toContain("Loaded server config");
    });
});
