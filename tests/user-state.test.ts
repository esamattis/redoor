import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

const processManager = new ProcessManager();
const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

function userStatePath() {
    return join(
        TEST_SERVER_HOME,
        ".local/share",
        TEST_APP_NAME,
        "users",
        TEST_USERNAME,
        "state.json",
    );
}

beforeAll(async () => {
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processManager.spawnServer({});
    await waitForPort(VITEST_SERVER_PORT);
});

afterAll(() => processManager.killAll());

describe("user state", () => {
    it("protects the preference document until a session exists", async () => {
        const response = await fetch(`${baseUrl}/api/v1/user/state`);
        // Missing login state must be distinguishable from an empty first-run document.
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: "Authentication required",
        });
    });

    it("returns an empty object before any preference has been written", async () => {
        const api = new ApiClient(baseUrl);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        rmSync(userStatePath(), { force: true });

        const response = await api.getUserState();
        // First-run clients apply schema defaults against a stable empty document.
        expect(response.state).toEqual({});
        // A missing file must not be created by a read.
        expect(existsSync(userStatePath())).toBe(false);
    });

    it("writes arbitrary json to the account state file", async () => {
        const api = new ApiClient(baseUrl);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        const statePath = userStatePath();
        onTestFinished(() => {
            rmSync(statePath, { force: true });
        });

        const document = {
            showHiddenFiles: false,
            nested: { theme: "dark", count: 3 },
        };
        const written = await api.updateUserState({ state: document });
        // The response must echo the stored document so clients can skip a follow-up GET.
        expect(written.state).toEqual(document);
        // Persistence lives in the login account directory, not a global settings file.
        expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(document);

        const readBack = await api.getUserState();
        // Reloads and other browsers restore exactly what was posted.
        expect(readBack.state).toEqual(document);

        const replacement = { only: "this" };
        await api.updateUserState({ state: replacement });
        // A later POST replaces the whole document instead of merging server-side.
        expect((await api.getUserState()).state).toEqual(replacement);
        expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(replacement);
    });
});
