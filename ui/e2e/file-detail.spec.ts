import { test, expect } from "@playwright/test";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File Detail View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("detail");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should navigate to file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        await expect(page.locator("h1.text-2xl.font-bold")).toContainText(
            "file1.txt",
        );
        await expect(page.getByText("Size")).toBeVisible();
        await expect(page.getByText("Owner")).toBeVisible();
        await expect(page.getByText("Group")).toBeVisible();
        await expect(page.getByText("UID")).toBeVisible();
        await expect(page.getByText("GID")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Download File" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Back", exact: true }),
        ).toBeVisible();
    });

    test("should display correct file size on detail view", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const sizeText = await page
            .locator("p", { hasText: "Size" })
            .locator("..")
            .locator("p.text-gray-900")
            .textContent();

        expect(sizeText).toBeDefined();
        expect(sizeText).not.toBe("-");
    });

    test("should navigate back from file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const backButton = page.getByRole("link", {
            name: "Back",
            exact: true,
        });
        await backButton.click();

        // This confirms returning from detail view restores the file list without matching the selection control cell.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
    });

    test("should navigate back to agent from file detail view", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${ctx.agentId}$`));
    });

    test("should navigate to nested file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir1" }).click();

        await page
            .getByRole("link", { name: "nested1.txt", exact: true })
            .click();

        await expect(page.locator("h1.text-2xl.font-bold")).toContainText(
            "nested1.txt",
        );
        await expect(page.getByText("Size")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();

        const backLink = page.getByRole("link", { name: "Back", exact: true });
        await backLink.click();

        // These assertions verify the nested directory listing is restored after using the back link.
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "nested2.txt", exact: true }),
        ).toBeVisible();
    });
});
