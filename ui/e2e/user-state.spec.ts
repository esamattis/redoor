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
        // Later browser tests assume the default user preferences.
        await api.updateUserState({
            state: { showHiddenFiles: true, theme: "system" },
        });
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

    test("should follow the system theme and persist an override", async ({
        page,
    }) => {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto(`${WEB_BASE_URL}/`);

        // A missing preference resolves from the OS rather than assuming dark or light.
        await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            "dark",
        );
        const themeButton = page.getByRole("button", {
            name: "Color theme: System",
        });
        const triggerBox = await themeButton.boundingBox();
        const agentMenuBox = await page
            .getByRole("navigation", { name: "Agents" })
            .boundingBox();
        // The compact control remains at the right edge of central chrome, immediately before the agent menu.
        expect(
            (triggerBox?.x ?? 0) + (triggerBox?.width ?? 0),
        ).toBeLessThanOrEqual(agentMenuBox?.x ?? 0);
        expect(triggerBox?.x ?? 0).toBeGreaterThan(
            (agentMenuBox?.x ?? 0) - 100,
        );

        await page.emulateMedia({ colorScheme: "light" });
        // System mode must react to OS changes without requiring a reload.
        await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            "light",
        );
        await expect(page.locator("body")).toHaveCSS(
            "background-color",
            "rgb(248, 250, 252)",
        );
        await page.emulateMedia({ colorScheme: "dark" });

        await themeButton.hover();
        // The tooltip names the state that the next click will select.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Click to dark theme",
        );
        await themeButton.click();
        const darkThemeButton = page.getByRole("button", {
            name: "Color theme: Dark",
        });
        await darkThemeButton.hover();
        // Each state advertises the next step in the cycle.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Click to light theme",
        );
        await darkThemeButton.click();

        // An explicit choice must override a dark OS preference immediately.
        await expect(page.locator("html")).toHaveClass(/light/);
        await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            "light",
        );
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        const activeFilesTab = page
            .getByLabel("Directory view")
            .getByRole("link", {
                name: "Files",
                exact: true,
            });
        // The raised active tab keeps high-contrast neutral text in the light theme.
        await expect(activeFilesTab).toHaveCSS("color", "rgb(15, 23, 42)");
        // Its icon retains the blue current-view accent used by the earlier tab treatment.
        await expect(activeFilesTab.locator("svg")).toHaveCSS(
            "color",
            "rgb(37, 99, 235)",
        );
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves the choice lives in user state rather than local storage.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ theme: "light" });

        await page.reload();

        // Reload must restore the server preference even though the OS remains dark.
        await expect(page.locator("html")).toHaveClass(/light/);
        await expect(
            page.getByRole("button", { name: "Color theme: Light" }),
        ).toBeVisible();
    });
});
