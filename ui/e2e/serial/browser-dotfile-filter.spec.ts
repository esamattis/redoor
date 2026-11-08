// Serial: persists "hide hidden files", which hides the `.test-*` directories other specs browse.
import { test, expect } from "../fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    API_BASE_URL,
    WEB_BASE_URL,
    type TestContext,
} from "../helpers";

test.describe.serial("Dotfile filter", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("dotfile-filter");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    const hiddenFileName = ".env.local";
    let hiddenPath = "";

    test.afterEach(async () => {
        if (hiddenPath !== "") {
            await fs.rm(hiddenPath, { force: true });
            hiddenPath = "";
        }

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later listings look up `.test-*` paths from the agent home.
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
            },
        });
    });

    test("includes hidden files while the filter starts with a dot", async ({
        page,
    }) => {
        hiddenPath = path.join(ctx.testDirPath, hiddenFileName);
        await fs.writeFile(hiddenPath, "secret");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const hidePersisted = page.waitForResponse(
            (response) =>
                response.request().method() === "PUT" &&
                response.url().includes("/api/v1/user/state"),
        );

        await page.getByRole("button", { name: "Hide hidden files" }).click();
        await hidePersisted;

        const hiddenFile = page.getByRole("link", {
            name: hiddenFileName,
            exact: true,
        });

        // The persisted hide preference still conceals dotfiles until the query asks for them.
        await expect(hiddenFile).toHaveCount(0);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });

        await filterInput.fill("env.local");
        // A query without a leading dot must not reveal hidden names.
        await expect(hiddenFile).toHaveCount(0);

        await filterInput.fill(".env");
        // The leading dot temporarily includes hidden names for this filter only.
        await expect(hiddenFile).toBeVisible();
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toHaveCount(0);

        await filterInput.fill("");
        // Clearing the filter restores the hide preference without keeping the extra rows.
        await expect(hiddenFile).toHaveCount(0);
    });
});
