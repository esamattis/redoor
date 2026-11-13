// Serial: asserts on the shared open files list, which parallel specs add files to.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../fixtures";

import { ApiClient } from "#ui/api-client";
import {
    defaultUserState,
    getOpenFileKey,
    userStateSchema,
} from "#ui/user-state";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

test.describe.serial("Open files unsaved changes", () => {
    let ctx: TestContext;
    let api: ApiClient;

    test.beforeAll(async () => {
        ctx = await setupTestDir("open-files-unsaved");
        api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
    });

    test.afterAll(async () => {
        await api.updateUserState({ state: defaultUserState });
        await teardownTestDir(ctx.testDirPath);
    });

    test("marks an open file with unsaved changes until it is saved", async ({
        page,
    }) => {
        await api.updateUserState({ state: defaultUserState });
        const filePath = path.join(ctx.testDirPath, "unsaved-mark.txt");
        await fs.writeFile(filePath, "content");
        const key = getOpenFileKey({ agentId: ctx.agentId, path: filePath });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("content");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" edited");

        const row = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("listitem", {
                name: `Open file unsaved-mark.txt on ${ctx.agentName}`,
            });

        const mark = row.getByRole("img", { name: "Unsaved changes" });
        // The first edit opens the file and marks it at once from the loaded buffer.
        await expect(mark).toBeVisible();

        // The mark is stored with the open file once the buffer is written.
        await expect
            .poll(async () =>
                userStateSchema
                    .parse((await api.getUserState()).state)
                    .openFiles.find((file) => getOpenFileKey(file) === key),
            )
            .toMatchObject({ dirty: true });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(ctx.testDirPath)}`,
        );
        // After a reload the buffer is not loaded, so the stored mark keeps the file marked.
        await expect(mark).toBeVisible();

        await row.getByRole("link", { name: "unsaved-mark.txt" }).click();
        await expect(editor).toHaveText("content edited");
        await page.getByRole("button", { name: "Save file" }).click();
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // Saving clears the mark.
        await expect(mark).toBeHidden();
    });
});
