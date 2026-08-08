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
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("file1.txt");
        const metadata = page.getByRole("region", { name: "Metadata" });
        // Scoping these labels verifies the metadata cards without conflicting with permission row labels.
        await expect(metadata.getByText("Size")).toBeVisible();
        await expect(metadata.getByText("Owner")).toBeVisible();
        await expect(metadata.getByText("Group")).toBeVisible();
        await expect(metadata.getByText("UID")).toBeVisible();
        await expect(metadata.getByText("GID")).toBeVisible();
        // The permissions heading verifies the new access grid is part of the file detail view.
        await expect(
            page.getByRole("heading", { name: "Permissions" }),
        ).toBeVisible();
        // A visible owner read cell proves raw mode bits are translated into understandable access rights.
        await expect(page.getByLabel("Owner Read: allowed")).toBeVisible();
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
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const sizeText = await page.getByLabel("File size value").textContent();

        expect(sizeText).toBeDefined();
        expect(sizeText).not.toBe("-");
    });

    test("should navigate back from file detail view", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
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
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
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
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir1" }).click();

        await page
            .getByRole("link", { name: "nested1.txt", exact: true })
            .click();

        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("nested1.txt");
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
