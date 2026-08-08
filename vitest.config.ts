import { defineConfig } from "vitest/config";
import path from "node:path";
import { testPorts } from "./test-ports.ts";

export default defineConfig({
    resolve: {
        alias: {
            "@bindings": path.resolve(import.meta.dirname, "./ui/bindings"),
            "@": path.resolve(import.meta.dirname, "./ui/src"),
        },
    },
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
