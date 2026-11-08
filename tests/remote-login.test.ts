import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { $ } from "zx";
import { existsSync } from "node:fs";
import path from "node:path";

import {
    ProcessManager,
    TempFileManager,
    createAccessToken,
    startServerAndAgent,
} from "./test-utils";

/**
 * The remote CLI without a saved login. Logging in through the browser is covered by
 * `cli-login.test.ts`.
 */
describe("Remote CLI with a token from the environment", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();

    const binary =
        process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");

    let setup: Awaited<ReturnType<typeof startServerAndAgent>>;
    let home: string;

    beforeAll(async () => {
        setup = await startServerAndAgent({
            processManager: processes,
            agentName: "remote-login-agent",
            agentCwd: files.tempDirectory(),
        });
        home = files.tempDirectory();
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Runs the real binary in an isolated namespace; empty overrides disable inherited ones. */
    function remote(
        namespace: string,
        args: string[],
        env: Record<string, string>,
    ) {
        return $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: namespace,
                REDOOR_REMOTE_SERVER: "",
                REDOOR_REMOTE_TOKEN: "",
                ...env,
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;
    }

    /** Path of a namespace's saved credentials. */
    function credentialsPath(namespace: string) {
        return path.join(
            home,
            ".local/share",
            namespace,
            "remote-credentials.json",
        );
    }

    it("uses the environment override without a saved login", async () => {
        const created = await createAccessToken(setup.apiClient, {
            name: "env override",
            permissions: ["files:read"],
        });

        const devices = await remote("env-override", ["devices", "--json"], {
            REDOOR_REMOTE_SERVER: setup.apiClient.baseUrl,
            REDOOR_REMOTE_TOKEN: created.token,
        });

        // Both variables authenticate without any credentials file.
        expect(devices.exitCode, devices.stderr).toBe(0);
        expect(JSON.parse(devices.stdout).agents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: setup.testAgent.id }),
            ]),
        );
        expect(existsSync(credentialsPath("env-override"))).toBe(false);

        const half = await remote("env-override", ["devices"], {
            REDOOR_REMOTE_TOKEN: created.token,
        });

        // Only one of the variables is a configuration mistake, not a silent fallback.
        expect(half.exitCode).not.toBe(0);
        expect(half.stderr).toContain("REDOOR_REMOTE_SERVER");
    });
});
