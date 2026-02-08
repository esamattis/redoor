import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            "@bindings": path.resolve(__dirname, "./ui/bindings"),
            "@": path.resolve(__dirname, "./ui/src"),
        },
    },
    test: {
        environment: "node",
        hookTimeout: 10000,
        testTimeout: 10000,
        exclude: ["node_modules", "**/e2e/**", ".opencode"],
        pool: "forks",
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
    },
});
