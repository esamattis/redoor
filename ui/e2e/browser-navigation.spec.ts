import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
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

    test("should keep navigation available when a path cannot be read", async ({
        page,
    }) => {
        const restrictedPath = `${ctx.testDirPath}/restricted`;
        const restrictedUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(restrictedPath)}`;
        const errorMessage = `Access to ${restrictedPath} was rejected`;
        await page.route(
            `**/api/v1/agents/${encodeURIComponent(ctx.agentId)}/ls/**`,
            async (route) => {
                await route.fulfill({
                    status: 403,
                    contentType: "application/json",
                    body: JSON.stringify({ error: errorMessage }),
                });
            },
        );

        await page.goto(restrictedUrl);

        // The HTTP status keeps permission failures in the browser without relying on error text.
        await expect(
            page.getByRole("heading", {
                name: "Could not read file or directory",
            }),
        ).toBeVisible();
        // The agent-provided reason and path make the failure actionable.
        await expect(
            page.getByRole("status", {
                name: "Could not read file or directory",
            }),
        ).toContainText(errorMessage);
        // Browser history remains available when the parent is not the desired destination.
        await expect(
            page.getByRole("button", { name: "Go back" }),
        ).toBeVisible();
        // Direct parent navigation lets users recover even from a copied or reloaded URL.
        await expect(
            page.getByRole("link", { name: "Open parent directory" }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(ctx.testDirPath)}`,
        );
        // Technical route diagnostics must not replace expected filesystem error handling.
        await expect(page.getByText("Technical details")).not.toBeVisible();
    });

    test("should filter directory entries and navigate to the first match", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        await filterInput.fill("DIR2");

        // Matching is case-insensitive and leaves only names containing the entered text.
        await expect(page.locator("main tbody tr")).toHaveCount(1);
        // The remaining link identifies the first result that Enter should open.
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        // Non-matching entries must be removed from the client-side listing.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).not.toBeVisible();

        await filterInput.press("Enter");

        // Enter follows the first filtered entry using the same route as its visible link.
        await expect(page).toHaveURL(
            `${directoryUrl}/${encodeURIComponent("subdir2")}`,
        );
        // Loaded child contents prove the navigation completed rather than only changing the URL.
        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();
        const destinationFilterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        // Filter-driven navigation restores keyboard focus in the destination listing.
        await expect(destinationFilterInput).toBeFocused();

        // Parent navigation stays in the shared header instead of moving with the search controls.
        await expect(
            page.getByRole("link", { name: "Up", exact: true }),
        ).toBeVisible();
    });

    test("should recursively search from the current directory", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        const searchRequests: Array<URL> = [];
        page.on("request", (request) => {
            const url = new URL(request.url());
            if (url.pathname.includes(`/agents/${ctx.agentId}/search`)) {
                searchRequests.push(url);
            }
        });
        await page.goto(directoryUrl);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        await filterInput.fill("nested3txt");

        // Local filtering cannot discover a file below a child directory.
        await expect(page.locator("main tbody tr")).toHaveCount(0);

        await page
            .getByRole("checkbox", { name: "Search recursively" })
            .check();
        await filterInput.fill("nested");
        await filterInput.fill("nested3txt");

        const nestedResult = page
            .getByRole("link")
            .filter({ hasText: "nested3.txt" });
        // A nested match proves the checked mode uses the recursive API rather than the loaded listing.
        await expect(nestedResult).toBeVisible();
        // Settled results keep the same header occupied with a useful count.
        await expect(page.getByText("1 result", { exact: true })).toBeVisible();
        // The dedicated result renderer exposes the full path and does not reuse directory table rows.
        await expect(
            page.getByText(
                path.join(ctx.testDirPath, "subdir2", "deep", "nested3.txt"),
                { exact: true },
            ),
        ).toBeVisible();
        await expect(page.locator("main tbody")).toHaveCount(0);
        // Inputs inside one throttle window collapse into one request carrying the final keystrokes.
        expect(searchRequests).toHaveLength(1);
        expect(searchRequests[0]?.searchParams.get("query")).toBe("nested3txt");

        let notifyRequestStarted: (() => void) | undefined;
        let releaseRequest: (() => void) | undefined;
        const requestStarted = new Promise<void>((resolve) => {
            notifyRequestStarted = resolve;
        });
        const requestRelease = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });
        await page.route("**/api/v1/agents/*/search/**", async (route) => {
            notifyRequestStarted?.();
            await requestRelease;
            await route.continue();
        });

        await filterInput.fill("nested1txt");
        await requestStarted;

        // Keeping the old match visible while transport is pending prevents result-list flashing.
        await expect(nestedResult).toBeVisible();
        await expect(
            page.getByText("Updating results...", { exact: true }),
        ).toBeVisible();
        releaseRequest?.();
        // The replacement result appearing proves retained rows do not block the eventual update.
        await expect(
            page.getByRole("link").filter({ hasText: "nested1.txt" }),
        ).toBeVisible();
    });

    test("should show directory details from the view query", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const directoryView = page.getByLabel("Directory view");
        // The selected styling is backed by current-page semantics for assistive technology.
        await expect(
            directoryView.getByRole("link", { name: "Files", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await page.getByRole("link", { name: "Details", exact: true }).click();

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
        // Changing representations moves the active state to Details.
        await expect(
            directoryView.getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        // Shared filesystem details must expose the directory's Unix access mode.
        await expect(
            page.getByRole("heading", { name: "Permissions", exact: true }),
        ).toBeVisible();
        // Archive download mirrors the file detail action so users can save the folder as tar.
        const downloadArchive = page.getByRole("link", {
            name: "Download archive",
            exact: true,
        });
        await expect(downloadArchive).toBeVisible();
        // The href targets the raw endpoint with download=1 so the browser treats it as an attachment.
        await expect(downloadArchive).toHaveAttribute(
            "href",
            new RegExp(
                `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/.*[?&]download=1`,
            ),
        );
        // Activating details replaces the child list instead of rendering both dense views together.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).not.toBeVisible();
        // Content-creation actions belong to the file listing rather than metadata view.
        await expect(
            page.getByRole("button", { name: "New", exact: true }),
        ).toHaveCount(0);

        await page.getByRole("link", { name: "Files", exact: true }).click();

        // Returning to the list removes the details query so the default URL stays canonical.
        await expect(page).toHaveURL(directoryUrl);
        // The file list becomes visible again after leaving details.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
    });

    test("should rename a directory and retain its details URL", async ({
        page,
    }) => {
        const originalName = `rename-directory-${Date.now()}`;
        const renamedName = `renamed-directory-${Date.now()}`;
        const originalPath = path.join(ctx.testDirPath, originalName);
        const renamedPath = path.join(ctx.testDirPath, renamedName);
        await fs.mkdir(originalPath);
        const originalUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(originalPath)}?view=details`;
        await page.goto(originalUrl);

        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        const renameInput = page.getByRole("textbox", {
            name: "Rename directory",
        });
        // Directory details expose the current leaf name without making the full path editable.
        await expect(renameInput).toHaveValue(originalName);
        await renameInput.fill(renamedName);
        await page.getByRole("button", { name: "Rename", exact: true }).click();

        // The details query and destination path are both retained after the rename.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(renamedPath)}?view=details`,
        );
        // A directory at only the new name confirms the agent performed the filesystem move.
        await expect(fs.stat(renamedPath)).resolves.toMatchObject({});
        await expect(fs.stat(originalPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
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

    test("should navigate back to agent page using Agent details button", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Agent details",
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
            page.getByRole("tab", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(agent1DirectoryPath)}`,
        );

        await page
            .getByRole("tab", { name: "agent2_custom, connected" })
            .click();
        await page.goto(agent2DirectoryUrl);
        await page
            .getByRole("link", { name: "nested3.txt", exact: true })
            .click();
        // Opening a file must make that exact file the second tab's destination.
        await expect(page).toHaveURL(agent2FileUrl);

        await page
            .getByRole("tab", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            })
            .click();
        // Switching back must restore the first agent's independent directory.
        await expect(page).toHaveURL(agent1DirectoryUrl);

        await page.reload();
        await page
            .getByRole("tab", { name: "agent2_custom, connected" })
            .click();
        // Reloading must not discard the inactive tab's remembered file.
        await expect(page).toHaveURL(agent2FileUrl);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("nested3.txt");

        await page
            .getByRole("tab", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            })
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
