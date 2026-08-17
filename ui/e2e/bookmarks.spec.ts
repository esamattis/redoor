import { test, expect } from "@playwright/test";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    type TestContext,
} from "./helpers";

test.describe.serial("Bookmarks", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("bookmarks");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later browser tests assume the default user preferences.
        await api.updateUserState({
            state: { showHiddenFiles: true, theme: "system", bookmarks: [] },
        });
    });

    test("should bookmark a file from the list menu and persist it under its agent", async ({
        page,
    }) => {
        const fileName = "file1.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        await page
            .getByRole("button", {
                name: `Actions for file ${fileName}`,
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: `Actions for file ${fileName}` })
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();

        const agentBookmarks = page.getByRole("list", {
            name: `${ctx.agentName} bookmarks`,
        });
        // The right panel must nest the bookmark under the agent that owns the path.
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("list", { name: "agent2_custom bookmarks" }),
        ).toHaveCount(0);

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves the bookmark lives in user state rather than local storage.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                bookmarks: [
                    {
                        agentId: ctx.agentId,
                        path: filePath,
                        name: fileName,
                        entryType: "file",
                    },
                ],
            });

        await agentBookmarks
            .getByRole("link", { name: fileName, exact: true })
            .click();
        // Clicking the sidebar entry must open that exact bookmarked path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.reload();
        // Reload must restore the bookmark from the server document.
        await expect(
            page
                .getByRole("list", { name: `${ctx.agentName} bookmarks` })
                .getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();
    });

    test("should bookmark and remove a file from the file actions menu", async ({
        page,
    }) => {
        const fileName = "file2.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=details`,
        );

        await page
            .getByRole("button", { name: "File actions", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "File actions" })
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();

        const agentBookmarks = page.getByRole("list", {
            name: `${ctx.agentName} bookmarks`,
        });
        // The details kebab must write the same user-state list as the file-row menu.
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "File actions", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "File actions" })
            .getByRole("button", { name: "Remove bookmark", exact: true })
            .click();

        // The same menu item must toggle membership so operators can unbookmark in place.
        await expect(agentBookmarks).toHaveCount(0);
    });
});
