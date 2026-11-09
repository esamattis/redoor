import { defineConfig } from "vitest/config";
import {
    INTEGRATION_LANES,
    SERIAL_INTEGRATION_TEST_FILES,
} from "./integration-test-lanes.ts";

export default defineConfig({
    test: {
        environment: "node",
        env: {
            // Shrink production idle timers so keepalive and stale-restart tests do not wait tens of seconds.
            REDOOR_WEBSOCKET_KEEPALIVE: "200ms",
            REDOOR_WEBSOCKET_STALE_TIMEOUT: "1s",
            REDOOR_WEBSOCKET_STALE_CHECK_INTERVAL: "100ms",
            // Replaces the 2-5 s reconnect jitter so every server restart or dropped link reconnects quickly.
            REDOOR_RECONNECT_DELAY: "200ms",
            // Keeps the developer's own git config out of the test repos: settings such as
            // `tag.gpgsign` turn a plain `git tag` into a signed tag that needs a message.
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
        },
        hookTimeout: 10000,
        testTimeout: 10000,
        exclude: ["node_modules", "**/e2e/**", ".opencode"],
        // Each worker gets its own server port (see `tests/setup-worker-port.ts`); the files of
        // a worker still run one after another and reuse that port.
        setupFiles: ["./tests/setup-worker-port.ts"],
        pool: "forks",
        isolate: false,
        projects: [
            {
                extends: true,
                test: {
                    name: "parallel",
                    include: ["tests/**/*.test.ts"],
                    exclude: SERIAL_INTEGRATION_TEST_FILES,
                    maxWorkers: INTEGRATION_LANES.parallel.workers,
                    env: { REDOOR_VITEST_LANE: "parallel" },
                },
            },
            {
                extends: true,
                test: {
                    name: "serial",
                    include: SERIAL_INTEGRATION_TEST_FILES,
                    maxWorkers: INTEGRATION_LANES.serial.workers,
                    // Projects with different worker counts need their own group. A plain
                    // `vitest run` therefore runs this lane after the parallel one, while
                    // `scripts/test/run-integration-tests.mts` runs both lanes at once.
                    sequence: { groupOrder: 1 },
                    env: { REDOOR_VITEST_LANE: "serial" },
                },
            },
        ],
    },
});
