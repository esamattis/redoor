import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    API_BASE_URL,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("User state", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("user-state");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later browser tests assume the default of showing hidden files.
        await api.updateUserState({ state: { showHiddenFiles: true } });
    });

    test("should persist hidden-file visibility on the server", async ({
        page,
    }) => {
        const hiddenFileName = ".hidden-pref.txt";
        await fs.writeFile(
            path.join(ctx.testDirPath, hiddenFileName),
            "secret",
        );
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({ state: { showHiddenFiles: true } });

        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const hiddenFile = page.getByRole("link", {
            name: hiddenFileName,
            exact: true,
        });
        // Default preference shows dotfiles so operators can see them immediately.
        await expect(hiddenFile).toBeVisible();

        const hideButton = page.getByRole("button", {
            name: "Hide hidden files",
        });
        await expect(hideButton).toHaveAttribute("aria-pressed", "true");
        await hideButton.click();

        // The toggle must hide immediately without waiting for the persist request.
        await expect(hiddenFile).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Show hidden files" }),
        ).toHaveAttribute("aria-pressed", "false");

        await page.reload();

        // Reload must restore the persisted preference from the server, not localStorage.
        await expect(
            page.getByRole("button", { name: "Show hidden files" }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(hiddenFile).toHaveCount(0);
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
    });

    test("should toast when settings cannot be saved", async ({ page }) => {
        await page.route("**/api/v1/user/state", async (route) => {
            if (route.request().method() !== "POST") {
                await route.continue();
                return;
            }
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({
                    error: "Could not write settings",
                }),
            });
        });

        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        await page.getByRole("button", { name: "Hide hidden files" }).click();

        // Persist failures must be announced without blocking the optimistic toggle.
        await expect(page.getByRole("alert")).toHaveText(
            "Could not write settings",
        );
        await expect(
            page.getByRole("button", { name: "Show hidden files" }),
        ).toHaveAttribute("aria-pressed", "false");
    });
});
