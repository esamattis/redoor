import { test, expect } from "@playwright/test";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File Browser Navigation", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("nav");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should display file list at agent root", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);

        await expect(
            page.locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            ),
        ).toBeVisible();
    });

    test("should navigate to subdirectory and display files", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "file2.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        const fileEntries = page.locator("main tbody tr");
        await expect(fileEntries).toHaveCount(5);
    });

    test("should navigate to deep nested directory", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir2", exact: true }).click();

        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "deep", exact: true }).click();

        await expect(
            page.getByRole("link", { name: "nested3.txt", exact: true }),
        ).toBeVisible();

        const fileEntries = page.locator("main tbody tr");
        await expect(fileEntries).toHaveCount(1);
    });

    test("should navigate using breadcrumbs", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir2" }).click();
        await page.getByRole("link", { name: "deep" }).click();

        const breadcrumbs = page.getByRole("navigation", {
            name: "Breadcrumbs",
        });
        await expect(breadcrumbs).toContainText(ctx.agentName);
        await expect(breadcrumbs).toContainText(ctx.testDirName);
        await expect(breadcrumbs).toContainText("subdir2");
        await expect(breadcrumbs).toContainText("deep");

        await breadcrumbs.getByText(ctx.testDirName, { exact: true }).click();
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "subdir1" }).click();
        const subdir1Breadcrumbs = page.getByRole("navigation", {
            name: "Breadcrumbs",
        });
        await expect(subdir1Breadcrumbs).toContainText("subdir1");
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "nested2.txt", exact: true }),
        ).toBeVisible();
    });

    test("should navigate using Up button", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir2", exact: true }).click();
        await page.getByRole("link", { name: "deep", exact: true }).click();

        // Waiting for deep-directory content ensures the next Up click runs
        // after the route loader has rendered the nested page rather than
        // racing with the intermediate URL change.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirName}/subdir2/deep`,
        );
        await expect(
            page.getByRole("link", { name: "nested3.txt", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "Up", exact: true }).click();

        // One Up click should remove only the deepest path segment.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirName}/subdir2`,
        );
        // Seeing the child directory confirms we landed in the immediate parent directory.
        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();
        // The breadcrumb text confirms the browser stopped at subdir2 instead of jumping to the test root.
        await expect(
            page.getByRole("navigation", { name: "Breadcrumbs" }),
        ).toContainText("subdir2");

        const upButton = page.getByRole("link", {
            name: "Up",
            exact: true,
        });
        await upButton.click();

        // The second Up click should return from subdir2 to the test directory root.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirName}`,
        );
        // Root directory entries confirm the browser returned to the expected directory listing.
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        await upButton.click();

        // This verifies the final upward navigation from the test directory returns to the agent cwd browser root.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser`,
        );
        await expect(
            page.getByRole("link", { name: ctx.testDirName, exact: true }),
        ).toBeVisible();
        // The aria-disabled attribute confirms there is no parent above the agent cwd root.
        await expect(upButton).toHaveAttribute("aria-disabled", "true");
    });

    test("should navigate back to agent page using Back to Agent button", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${ctx.agentId}$`));
    });

    test("should display correct icons and sizes", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        const dirLinks = page.getByRole("link", {
            name: /^(subdir1|subdir2|subdir3)$/,
        });
        await expect(dirLinks).toHaveCount(3);

        const fileEntries = page
            .locator("td")
            .filter({ hasText: /^(file1|file2)\.txt$/ });
        await expect(fileEntries).toHaveCount(2);

        const dirSizeColumn = page.getByRole("cell", {
            name: "Size for subdir1",
        });
        await expect(dirSizeColumn).toBeVisible();

        const fileSizeColumn = page.getByRole("cell", {
            name: "Size for file1.txt",
        });
        await expect(fileSizeColumn).not.toHaveText("-");
    });
});
