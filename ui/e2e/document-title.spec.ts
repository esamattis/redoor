import { test, expect } from "./fixtures";
import { hostname } from "node:os";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    deviceBrowserUrl,
    API_BASE_URL,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Document title", () => {
    let ctx: TestContext;
    let serverTitle: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("document-title");
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        const serverInfo = await api.getServerInfo();
        serverTitle = `${hostname()} | Redoor ${serverInfo.version}`;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("names the server outside the file browser", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);

        // Pages without a browsed path only identify the server tab.
        await expect(page).toHaveTitle(serverTitle);
    });

    test("names the browsed entry and agent in the file browser", async ({
        page,
    }) => {
        await page.goto(deviceBrowserUrl(ctx.agentName, ctx.testDirPath));

        // The browsed directory's base name and agent tell browser tabs of one server apart.
        await expect(page).toHaveTitle(
            `${ctx.testDirName}@${ctx.agentName} | ${serverTitle}`,
        );

        await page
            .getByRole("link", { name: "subdir1", exact: true })
            .first()
            .click();

        // Navigating inside the browser must retitle the tab to the new entry.
        await expect(page).toHaveTitle(
            `subdir1@${ctx.agentName} | ${serverTitle}`,
        );
    });
});
