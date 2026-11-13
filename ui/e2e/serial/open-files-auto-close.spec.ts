// Serial: replaces the shared user settings to seed aged open files and preferences.
import path from "node:path";
import { expect, test } from "../fixtures";

import { ApiClient } from "#ui/api-client";
import {
    defaultUserState,
    userStateSchema,
    type OpenFile,
} from "#ui/user-state";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

const HOUR_MS = 60 * 60 * 1000;

test.describe.serial("Open files auto-close", () => {
    let ctx: TestContext;
    let api: ApiClient;

    test.beforeAll(async () => {
        ctx = await setupTestDir("open-files-auto-close");
        api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
    });

    test.afterAll(async () => {
        await api.updateUserState({ state: defaultUserState });
        await teardownTestDir(ctx.testDirPath);
    });

    /** An open file of the test device, touched the given number of hours ago. */
    function openFileTouchedHoursAgo(name: string, hours: number): OpenFile {
        return {
            agentId: ctx.agentId,
            path: path.join(ctx.testDirPath, name),
            name,
            agentName: ctx.agentName,
            touchedAt: Date.now() - hours * HOUR_MS,
        };
    }

    test("closes untouched clean files once enabled on the preferences page", async ({
        page,
    }) => {
        const stale = openFileTouchedHoursAgo("file1.txt", 48);
        const dirty = openFileTouchedHoursAgo("file2.txt", 48);
        const fresh = openFileTouchedHoursAgo("file3.txt", 1);

        // Aged timestamps stand in for a day of waiting; auto-close starts off so the files
        // are seen open before the setting closes them.
        await api.updateUserState({
            state: {
                ...defaultUserState,
                openFiles: [stale, dirty, fresh],
                autoCloseOpenFiles: false,
            },
        });

        // Unsaved edits live in the stored buffer of a file not visited since the page loaded.
        await api.putEditorBuffer(`${ctx.agentId}:${dirty.path}`, {
            data: {
                version: 1,
                state: {
                    doc: "unsaved",
                    selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
                },
                baseHash: "base",
                scroll: null,
                lineEntry: null,
                revealEntry: null,
                dirty: true,
            },
        });

        await page.goto(`${WEB_BASE_URL}/settings/preferences`);

        const openFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });

        // Disabled auto-close must leave even a two-day-old file open.
        await expect(
            openFiles.getByRole("link", { name: stale.name, exact: true }),
        ).toBeVisible();

        const autoClose = page.getByRole("button", {
            name: "Close open files automatically",
        });

        await expect(autoClose).toHaveAttribute("aria-pressed", "false");

        await autoClose.click();

        // Enabling sweeps at once: the stale clean file goes, while unsaved edits and a
        // recently touched file stay.
        await expect
            .poll(async () =>
                userStateSchema
                    .parse((await api.getUserState()).state)
                    .openFiles.map((file) => file.name),
            )
            .toEqual([dirty.name, fresh.name]);
        await expect(
            openFiles.getByRole("link", { name: stale.name, exact: true }),
        ).toHaveCount(0);

        await page.getByLabel("Close after").selectOption("72");
        await page.getByRole("button", { name: "Vim mode" }).click();

        // Both preferences must reach the user state so they apply in every browser.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                autoCloseOpenFiles: true,
                autoCloseOpenFilesAfterHours: 72,
                vimMode: true,
            });
    });
});
