import { defineConfig } from "vitest/config";

// UI unit tests run without a server, so fresh checkouts need no reserved test ports.
export default defineConfig({
    test: {
        environment: "node",
        include: ["ui/src/**/*.test.{ts,tsx}"],
        hookTimeout: 10000,
        testTimeout: 10000,
        pool: "forks",
        maxWorkers: 1,
        isolate: false,
    },
});
