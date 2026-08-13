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

    test("should display modified time and sort every metadata column", async ({
        page,
    }) => {
        const now = Date.now();
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        const modifiedAt = Math.floor(
            (now - ((3 * 24 + 2) * 60 + 3) * 60_000) / 1000,
        );
        await page.route(
            `**/api/v1/agents/${encodeURIComponent(ctx.agentId)}/ls/**`,
            async (route) => {
                await route.fulfill({
                    contentType: "application/json",
                    body: JSON.stringify({
                        path: ctx.testDirPath,
                        owner: "owner",
                        group: "group",
                        uid: 1000,
                        gid: 1000,
                        permissions: 0o755,
                        files: [
                            {
                                name: "z-directory",
                                type: "directory",
                                size: 0,
                                owner: "charlie",
                                group: "gamma",
                                uid: 1000,
                                gid: 1000,
                                modified_at: modifiedAt + 2 * 86_400,
                            },
                            {
                                name: "alpha.txt",
                                type: "file",
                                size: 10,
                                owner: "bravo",
                                group: "beta",
                                uid: 1000,
                                gid: 1000,
                                modified_at: modifiedAt,
                            },
                            {
                                name: "beta.txt",
                                type: "file",
                                size: 100,
                                owner: "alpha",
                                group: "alpha",
                                uid: 1000,
                                gid: 1000,
                                modified_at: modifiedAt + 86_400,
                            },
                        ],
                    }),
                });
            },
        );
        await page.goto(directoryUrl);

        const modifiedCell = page.getByLabel("Modified alpha.txt");
        const modifiedTime = modifiedCell.locator("time");
        // The visible cell provides an absolute local date and an ISO value for machines.
        await expect(modifiedTime).not.toHaveText("");
        await expect(modifiedTime).toHaveAttribute(
            "datetime",
            new Date(modifiedAt * 1000).toISOString(),
        );
        await modifiedTime.hover();
        // The tooltip spells out the complete age rather than using compact abbreviations.
        await expect(page.getByRole("tooltip")).toHaveText(
            "3 days 2 hours 3 minutes ago",
        );

        const rows = page.locator("main tbody tr");
        const expectOrder = async (names: string[]) => {
            const expectedLabels = names.map((name) =>
                name === "z-directory"
                    ? `Directory entry ${name}`
                    : `File entry ${name}`,
            );
            // Waiting on the first row ensures React has committed the requested order.
            await expect(rows.first()).toHaveAttribute(
                "aria-label",
                expectedLabels[0] ?? "",
            );
            // Row labels capture the complete ordering without depending on visual styling.
            expect(
                await rows.evaluateAll((entries) =>
                    entries.map((entry) => entry.getAttribute("aria-label")),
                ),
            ).toEqual(expectedLabels);
        };

        await page
            .getByRole("button", { name: "Sort by Name ascending" })
            .click();
        await expectOrder(["alpha.txt", "beta.txt", "z-directory"]);
        await page
            .getByRole("button", { name: "Sort by Name descending" })
            .click();
        await expectOrder(["z-directory", "beta.txt", "alpha.txt"]);
        await page
            .getByRole("button", { name: "Sort by Type ascending" })
            .click();
        await expectOrder(["z-directory", "alpha.txt", "beta.txt"]);
        await page
            .getByRole("button", { name: "Sort by Size ascending" })
            .click();
        await expectOrder(["z-directory", "alpha.txt", "beta.txt"]);
        await page
            .getByRole("button", { name: "Sort by Modified ascending" })
            .click();
        await expectOrder(["alpha.txt", "beta.txt", "z-directory"]);
        await page
            .getByRole("button", { name: "Sort by Owner ascending" })
            .click();
        await expectOrder(["beta.txt", "alpha.txt", "z-directory"]);
        await page
            .getByRole("button", { name: "Sort by Group ascending" })
            .click();
        await expectOrder(["beta.txt", "alpha.txt", "z-directory"]);
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

        // Row actions expose download without leaving the directory listing.
        const downloadFile = page.getByRole("link", {
            name: "Download file file1.txt",
            exact: true,
        });
        await expect(downloadFile).toBeVisible();
        await expect(downloadFile).toHaveAttribute(
            "href",
            new RegExp(
                `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/.*[?&]download=1`,
            ),
        );
        const downloadDirectory = page.getByRole("link", {
            name: "Download directory subdir1 as .tar.gz",
            exact: true,
        });
        await expect(downloadDirectory).toBeVisible();
        await expect(downloadDirectory).toHaveAttribute(
            "href",
            new RegExp(
                `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/.*[?&]download=1`,
            ),
        );
        await downloadDirectory.hover();
        const downloadTooltip = page.getByRole("tooltip", {
            name: "Download as .tar.gz archive",
        });
        // The shared tooltip must escape the file table's clipped card instead of losing content at its edge.
        await expect(downloadTooltip).toBeInViewport({ ratio: 1 });

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

    test("should support file browser keyboard shortcuts", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        // The visible hint makes both search shortcuts discoverable before they are used.
        await expect(filterInput).toHaveAttribute(
            "placeholder",
            "Filter files (f, s for recursive)",
        );
        await page.keyboard.press("f");
        // The local filter shortcut moves focus without changing its search mode.
        await expect(filterInput).toBeFocused();
        await expect(
            page.getByRole("button", { name: "Search recursively" }),
        ).toHaveAttribute("aria-pressed", "false");

        await page.keyboard.type("f");
        // Character shortcuts stay inactive while typing into an input.
        await expect(filterInput).toHaveValue("f");
        await page.keyboard.press("Escape");
        // Escape globally releases text controls for immediate shortcut use.
        await expect(filterInput).not.toBeFocused();
        await filterInput.fill("");
        await page.keyboard.press("Escape");
        await page.keyboard.press("s");
        // Recursive search is enabled before its shortcut focuses the query input.
        await expect(
            page.getByRole("button", { name: "Search recursively" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(filterInput).toBeFocused();
        await page.keyboard.press("Escape");
        // The first Escape only releases the active search input.
        await expect(
            page.getByRole("button", { name: "Search recursively" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(filterInput).not.toBeFocused();
        await page.keyboard.press("Escape");
        // A second Escape leaves recursive mode while retaining the query.
        await expect(
            page.getByRole("button", { name: "Search recursively" }),
        ).toHaveAttribute("aria-pressed", "false");

        const firstFileEntry = page.getByRole("link", {
            name: "subdir1",
            exact: true,
        });
        const secondFileEntry = page.getByRole("link", {
            name: "subdir2",
            exact: true,
        });
        await page.keyboard.press("j");
        // The first movement starts at the first visible file-name link.
        await expect(firstFileEntry).toBeFocused();
        await page.keyboard.press("j");
        // Repeated downward movement advances one entry at a time.
        await expect(secondFileEntry).toBeFocused();
        await page.keyboard.press("k");
        // Upward movement returns to the preceding entry.
        await expect(firstFileEntry).toBeFocused();

        const upLink = page.getByRole("link", { name: "Up", exact: true });
        await upLink.hover();
        // Parent navigation advertises the equivalent keyboard shortcut.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Go to the parent directory (Backspace)",
        );

        await page.getByRole("link", { name: "Details", exact: true }).click();
        await expect(page).toHaveURL(`${directoryUrl}?view=details`);
        await expect(
            page.getByRole("heading", { name: "Directory name" }),
        ).toBeVisible();
        await page.keyboard.press("Backspace");
        // Backspace first restores the file list from another directory view.
        await expect(page).toHaveURL(directoryUrl);
        await expect(firstFileEntry).toBeVisible();
        await page.keyboard.press("Backspace");
        // From the file list, Backspace navigates to the immediate parent directory.
        await expect(page).not.toHaveURL(directoryUrl);
    });

    test("should navigate filtered results and clear the filter with a second Escape", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        const firstResult = page.getByRole("link", {
            name: "subdir1",
            exact: true,
        });
        const secondResult = page.getByRole("link", {
            name: "subdir2",
            exact: true,
        });

        await filterInput.fill("subdir");
        await expect(page.locator("main tbody tr")).toHaveCount(3);
        await page.keyboard.press("Escape");

        // The first Escape preserves the query and visible filtered result set.
        await expect(filterInput).not.toBeFocused();
        await expect(filterInput).toHaveValue("subdir");
        await expect(page.locator("main tbody tr")).toHaveCount(3);
        await page.keyboard.press("j");
        await expect(firstResult).toBeFocused();
        await page.keyboard.press("j");
        await expect(secondResult).toBeFocused();
        await page.keyboard.press("k");
        await expect(firstResult).toBeFocused();

        await page.keyboard.press("Escape");

        // Once the input is inactive, Escape clears local filtering and restores all entries.
        await expect(filterInput).toHaveValue("");
        await expect(page.locator("main tbody tr")).toHaveCount(5);
    });

    test("should navigate recursive results and leave search with a second Escape", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        const recursiveToggle = page.getByRole("button", {
            name: "Search recursively",
        });

        await recursiveToggle.click();
        await filterInput.fill("nested");
        await expect(
            page.getByText("3 results", { exact: true }),
        ).toBeVisible();
        const firstResult = page.getByRole("link").filter({
            hasText: "nested1.txt",
        });
        const secondResult = page.getByRole("link").filter({
            hasText: "nested2.txt",
        });
        await page.keyboard.press("Escape");

        // The first Escape leaves recursive search and its results intact for keyboard navigation.
        await expect(filterInput).not.toBeFocused();
        await expect(filterInput).toHaveValue("nested");
        await expect(recursiveToggle).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("j");
        await expect(firstResult).toBeFocused();
        await page.keyboard.press("j");
        await expect(secondResult).toBeFocused();
        await page.keyboard.press("k");
        await expect(firstResult).toBeFocused();

        await page.keyboard.press("Escape");

        // The second Escape returns to local filtering without discarding the query.
        await expect(recursiveToggle).toHaveAttribute("aria-pressed", "false");
        await expect(filterInput).toHaveValue("nested");
        await expect(page.locator("main tbody")).toHaveCount(1);
        await expect(page.locator("main tbody tr")).toHaveCount(0);
    });

    test("should start tab traversal at the first agent tab", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        const firstAgentTab = page.getByRole("tab").first();
        // A rendered tab proves the authenticated layout and its global listener are mounted.
        await expect(firstAgentTab).toBeVisible();
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
            }
        });

        await page.keyboard.press("Tab");

        // Global traversal skips branding so the first sorted agent is the first tab stop.
        await expect(firstAgentTab).toBeFocused();
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
        const timeoutInput = page.getByRole("spinbutton", {
            name: "Search timeout in seconds",
        });
        const hiddenToggle = page.getByRole("button", {
            name: "Search hidden directories",
        });
        const gitignoreToggle = page.getByRole("button", {
            name: "Respect .gitignore files",
        });
        // Recursive-only controls do not occupy the local-filter toolbar.
        await expect(timeoutInput).toHaveCount(0);
        await expect(hiddenToggle).toHaveCount(0);
        await expect(gitignoreToggle).toHaveCount(0);
        await filterInput.fill("nested3txt");

        // Local filtering cannot discover a file below a child directory.
        await expect(page.locator("main tbody tr")).toHaveCount(0);

        await page.getByRole("button", { name: "Search recursively" }).click();
        // Recursive searches reveal their optional controls with safe defaults.
        await expect(timeoutInput).toHaveValue("5");
        await expect(hiddenToggle).toHaveAttribute("aria-pressed", "false");
        await expect(gitignoreToggle).toHaveAttribute("aria-pressed", "true");
        await timeoutInput.hover();
        // The tooltip explains both the unit and accepted range at the control.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Maximum recursive search duration in seconds (1-60)",
        );
        await timeoutInput.fill("12");
        await hiddenToggle.click();
        await expect(hiddenToggle).toHaveAttribute("aria-pressed", "true");
        await gitignoreToggle.click();
        await expect(gitignoreToggle).toHaveAttribute("aria-pressed", "false");
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
        // The chosen duration is sent with every recursive search request.
        expect(searchRequests[0]?.searchParams.get("timeout")).toBe("12");
        // Hidden-directory traversal is explicit rather than enabled by default.
        expect(searchRequests[0]?.searchParams.get("include_hidden")).toBe(
            "true",
        );
        // Git ignore checking is default-on but can be disabled for exhaustive searches.
        expect(searchRequests[0]?.searchParams.get("respect_gitignore")).toBe(
            "false",
        );

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
        // Upload scheduling is inline and has no dedicated directory representation.
        await expect(
            directoryView.getByRole("link", {
                name: "Upload queue",
                exact: true,
            }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "More", exact: true }).click();
        const moreMenu = page.getByRole("dialog", { name: "More" });
        // The removed queue route is no longer exposed through the secondary action menu either.
        await expect(
            moreMenu.getByRole("link", { name: "Upload queue", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Close more menu" }).click();
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
        // Directory download uses the same label as files; packaging is explained via tooltip.
        const downloadDirectory = page
            .getByLabel("File browser actions")
            .getByRole("link", {
                name: "Download",
                exact: true,
            });
        await expect(downloadDirectory).toBeVisible();
        // The href targets the raw endpoint with download=1 so the browser treats it as an attachment.
        await expect(downloadDirectory).toHaveAttribute(
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

        await page.getByRole("button", { name: "Edit file path" }).click();
        await page.getByRole("textbox", { name: "File path" }).press("Enter");
        // Enter accepts an unchanged path even when the router has no navigation to commit.
        await expect(
            page.getByRole("textbox", { name: "File path" }),
        ).not.toBeVisible();

        await page.getByRole("button", { name: "Edit file path" }).click();
        await page.getByRole("button", { name: "Navigate to path" }).click();
        // The submit button shares unchanged-path acceptance with keyboard submission.
        await expect(
            page.getByRole("textbox", { name: "File path" }),
        ).not.toBeVisible();
    });

    test("should sync a directory with the selected existing policy", async ({
        page,
    }) => {
        const sourcePath = path.join(ctx.testDirPath, "subdir1");
        const destinationPath = path.join(ctx.testDirPath, "sync-directory");
        await fs.mkdir(destinationPath);
        await fs.writeFile(
            path.join(destinationPath, "nested1.txt"),
            "old nested content",
        );
        await fs.writeFile(
            path.join(destinationPath, "destination-only.txt"),
            "preserved",
        );
        const sourceUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(sourcePath)}`;
        await page.goto(sourceUrl);

        await page.getByRole("link", { name: "Sync", exact: true }).click();
        await page.getByLabel("Sync path").fill(destinationPath);
        await page.getByRole("radio", { name: "Merge" }).check();
        await page.getByLabel("Merge behavior").hover();
        // The tooltip explains that merge preserves destination-only entries.
        await expect(page.getByRole("tooltip")).toContainText(
            "preserving entries that exist only at the destination",
        );
        await page.getByRole("button", { name: "Sync", exact: true }).click();

        // A terminal success confirms the selected policy completed on the destination agent.
        await expect(page.getByRole("status")).toContainText(
            "Sync completed successfully",
        );
        await expect(
            fs.readFile(path.join(destinationPath, "nested1.txt"), "utf8"),
        ).resolves.toBe("nested1");
        await expect(
            fs.readFile(
                path.join(destinationPath, "destination-only.txt"),
                "utf8",
            ),
        ).resolves.toBe("preserved");
        await expect(page).toHaveURL(`${sourceUrl}?view=sync`);
        await expect(
            page
                .getByLabel("Directory view")
                .getByRole("link", { name: "Sync", exact: true }),
        ).toHaveAttribute("aria-current", "page");
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
        await page.getByRole("link", { name: "subdir2", exact: true }).click();
        await page.getByRole("link", { name: "deep", exact: true }).click();

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

        await page.getByRole("link", { name: "subdir1", exact: true }).click();
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

    test("should navigate back to agent page using Agent button", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        // The icon link must return directly to the agent's published home from nested paths.
        await expect(
            page.getByRole("link", { name: "Agent home" }),
        ).toHaveAttribute("href", new URL(ctx.agentBrowserUrl).pathname);
        const backToAgentButton = page.getByRole("link", {
            name: "Agent",
            exact: true,
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
