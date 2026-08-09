import { defineConfig } from "vitest/config";
import { testPorts } from "./test-ports.ts";

export default defineConfig({
    test: {
        environment: "node",
        env: {
            REDOOR_PORT: testPorts.vitest.toString(),
        },
        hookTimeout: 10000,
        testTimeout: 10000,
        exclude: ["node_modules", "**/e2e/**", ".opencode"],
        pool: "forks",
        maxWorkers: 1,
        isolate: false,
    },
});
