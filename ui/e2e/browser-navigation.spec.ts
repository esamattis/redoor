import { test, expect } from "@playwright/test";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
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
        await page.goto(ctx.agentBrowserUrl);

        await expect(
            page.locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            ),
        ).toBeVisible();
    });

    test("should navigate to subdirectory and display files", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        const destinationUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await Promise.all([
            page.waitForURL(destinationUrl),
            page
                .locator(
                    `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
                )
                .click(),
        ]);
        await expect(
            page.getByRole("navigation", { name: "Breadcrumbs" }),
        ).toContainText(ctx.testDirName);

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

    test("should show directory details from the view query", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        await page
            .getByRole("link", { name: "View details", exact: true })
            .click();

        // The query parameter makes the alternate view directly addressable and reload-safe.
        await expect(page).toHaveURL(`${directoryUrl}?view=details`);
        // The directory heading confirms details describe the current directory rather than a child.
        const directoryHeading = page.getByRole("heading", {
            name: "Directory name",
            exact: true,
        });
        await expect(directoryHeading).toBeVisible();
        // The visible heading value identifies the directory represented by the metadata.
        await expect(directoryHeading).toHaveText(ctx.testDirName);
        // Shared filesystem details must expose the directory's Unix access mode.
        await expect(
            page.getByRole("heading", { name: "Permissions", exact: true }),
        ).toBeVisible();
        // Activating details replaces the child list instead of rendering both dense views together.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).not.toBeVisible();

        await page
            .getByRole("link", { name: "View files", exact: true })
            .click();

        // Returning to the list removes the details query so the default URL stays canonical.
        await expect(page).toHaveURL(directoryUrl);
        // The file list becomes visible again after leaving details.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
    });

    test("should navigate to deep nested directory", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
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
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir2" }).click();
        await page.getByRole("link", { name: "deep" }).click();

        const breadcrumbs = page.getByRole("navigation", {
            name: "Breadcrumbs",
        });
        // Breadcrumbs describe the filesystem path without repeating the agent tab label.
        await expect(breadcrumbs).not.toContainText(ctx.agentName);
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

    test("should navigate by editing the breadcrumb path", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        const nestedPath = `${ctx.testDirPath}/subdir2`;
        const nestedUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(nestedPath)}`;
        await page.goto(directoryUrl);

        await page.getByRole("button", { name: "Edit file path" }).click();

        const pathInput = page.getByRole("textbox", { name: "File path" });
        // The existing path lets users edit only the portion that needs changing.
        await expect(pathInput).toHaveValue(ctx.testDirPath);

        await pathInput.fill(nestedPath);
        await pathInput.press("Enter");

        // Enter submits the edited path to the browser route.
        await expect(page).toHaveURL(nestedUrl);
        // The nested directory contents prove navigation loaded the requested location.
        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Edit file path" }).click();
        await page
            .getByRole("textbox", { name: "File path" })
            .fill(ctx.testDirPath);
        await page.getByRole("button", { name: "Navigate to path" }).click();

        // The icon submit button uses the same direct-path navigation behavior.
        await expect(page).toHaveURL(directoryUrl);
        // Returning directory contents confirm the icon action completed navigation.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
    });

    test("should keep path editor focused when breadcrumb path does not exist", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        const missingPath = `${ctx.testDirPath}/does-not-exist`;
        const missingUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(missingPath)}`;
        const nestedPath = `${ctx.testDirPath}/subdir1`;
        const nestedUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(nestedPath)}`;
        await page.goto(directoryUrl);

        await page.getByRole("button", { name: "Edit file path" }).click();
        const pathInput = page.getByRole("textbox", { name: "File path" });
        await pathInput.fill(missingPath);
        await pathInput.press("Enter");

        // Navigation still commits the missing path in the URL.
        await expect(page).toHaveURL(missingUrl);
        // Browser chrome stays mounted so the path can be corrected in place.
        await expect(page.getByLabel("File browser actions")).toBeVisible();
        await expect(
            page.getByRole("table", { name: "File list" }),
        ).toBeVisible();
        // Missing path is reported without replacing the file browser skeleton.
        await expect(
            page.getByText("Directory not found", { exact: true }),
        ).toBeVisible();

        const missingPathInput = page.getByRole("textbox", {
            name: "File path",
        });
        // The editor reopens automatically so the user can fix the path immediately.
        await expect(missingPathInput).toBeVisible();
        await expect(missingPathInput).toHaveValue(missingPath);
        // Focus stays in the input for immediate correction after a failed path.
        await expect(missingPathInput).toBeFocused();

        await missingPathInput.fill(nestedPath);
        await missingPathInput.press("Enter");

        // Correcting the path recovers into the real directory listing.
        await expect(page).toHaveURL(nestedUrl);
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        // Successful navigation closes the editor again.
        await expect(
            page.getByRole("textbox", { name: "File path" }),
        ).not.toBeVisible();
    });

    test("should navigate using Up button", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir2", exact: true }).click();
        await page.getByRole("link", { name: "deep", exact: true }).click();

        // Waiting for deep-directory content ensures the next Up click runs
        // after the route loader has rendered the nested page rather than
        // racing with the intermediate URL change.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir2/deep`)}`,
        );
        await expect(
            page.getByRole("link", { name: "nested3.txt", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "Up", exact: true }).click();

        // One Up click should remove only the deepest path segment.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir2`)}`,
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
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

        // Reaching the configured default does not turn it into a browser root.
        await expect(page).toHaveURL(ctx.agentBrowserUrl);
        await expect(upButton).not.toHaveAttribute("aria-disabled", "true");
        await upButton.click();
        // Up continues from the configured default to its real filesystem parent.
        await expect(page).not.toHaveURL(ctx.agentBrowserUrl);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath("/")}`,
        );
        // Only the filesystem root has no parent navigation target.
        await expect(upButton).toHaveAttribute("aria-disabled", "true");
    });

    test("should navigate back to agent page using Back to Agent button", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${ctx.agentId}$`));
    });

    test("should remember each agent tab location across switches and reloads", async ({
        page,
    }) => {
        const agent1DirectoryPath = `${ctx.testDirPath}/subdir1`;
        const agent1DirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(agent1DirectoryPath)}`;
        const agent2DirectoryPath = `${ctx.testDirPath}/subdir2/deep`;
        const agent2DirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(agent2DirectoryPath)}`;
        const agent2FilePath = `${agent2DirectoryPath}/nested3.txt`;
        const agent2FileUrl = `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(agent2FilePath)}`;

        await page.goto(ctx.agentBrowserUrl);
        await page.goto(agent1DirectoryUrl);
        // The first tab must capture its directory before another agent becomes active.
        await expect(
            page.getByRole("tab", { name: ctx.agentName, exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(agent1DirectoryPath)}`,
        );

        await page
            .getByRole("tab", { name: "agent2_custom", exact: true })
            .click();
        await page.goto(agent2DirectoryUrl);
        await page
            .getByRole("link", { name: "nested3.txt", exact: true })
            .click();
        // Opening a file must make that exact file the second tab's destination.
        await expect(page).toHaveURL(agent2FileUrl);

        await page
            .getByRole("tab", { name: ctx.agentName, exact: true })
            .click();
        // Switching back must restore the first agent's independent directory.
        await expect(page).toHaveURL(agent1DirectoryUrl);

        await page.reload();
        await page
            .getByRole("tab", { name: "agent2_custom", exact: true })
            .click();
        // Reloading must not discard the inactive tab's remembered file.
        await expect(page).toHaveURL(agent2FileUrl);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("nested3.txt");

        await page
            .getByRole("tab", { name: ctx.agentName, exact: true })
            .click();
        // Both persisted entries must remain independent after the refresh.
        await expect(page).toHaveURL(agent1DirectoryUrl);
    });

    test("should display correct icons and sizes", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
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
