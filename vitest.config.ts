import { defineConfig } from "vitest/config";
import { testPorts } from "./test-ports.ts";

export default defineConfig({
    test: {
        environment: "node",
        env: {
            REDOOR_PORT: testPorts.vitest.toString(),
            // Shrink production idle timers so keepalive and stale-restart tests do not wait tens of seconds.
            REDOOR_WEBSOCKET_KEEPALIVE: "200ms",
            REDOOR_WEBSOCKET_STALE_TIMEOUT: "1s",
            REDOOR_WEBSOCKET_STALE_CHECK_INTERVAL: "100ms",
        },
        hookTimeout: 10000,
        testTimeout: 10000,
        exclude: ["node_modules", "**/e2e/**", ".opencode"],
        pool: "forks",
        maxWorkers: 1,
        isolate: false,
    },
});
