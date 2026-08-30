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
        const hidden = ".hidden.txt";
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
                                name: hidden,
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
        // The visible cell provides an absolute browser-local date without wrapping.
        await expect(modifiedTime).not.toHaveText("");
        await expect(modifiedTime).toHaveCSS("white-space", "nowrap");
        // The machine-readable timestamp remains independent of the browser locale.
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

        // The default directory ordering keeps hidden files after visible peers.
        await expectOrder(["z-directory", "alpha.txt", "beta.txt", hidden]);
        await page
            .getByRole("button", { name: "Sort by Name ascending" })
            .click();
        await expectOrder(["alpha.txt", "beta.txt", "z-directory", hidden]);
        await page
            .getByRole("button", { name: "Sort by Name descending" })
            .click();
        await expectOrder(["z-directory", "beta.txt", "alpha.txt", hidden]);
        await page
            .getByRole("button", { name: "Sort by Type ascending" })
            .click();
        await expectOrder(["z-directory", "alpha.txt", "beta.txt", hidden]);
        await page
            .getByRole("button", { name: "Sort by Size ascending" })
            .click();
        await expectOrder(["z-directory", "alpha.txt", hidden, "beta.txt"]);
        await page
            .getByRole("button", { name: "Sort by Modified ascending" })
            .click();
        await expectOrder(["alpha.txt", hidden, "beta.txt", "z-directory"]);
        await page
            .getByRole("button", { name: "Sort by Owner ascending" })
            .click();
        await expectOrder(["beta.txt", "alpha.txt", hidden, "z-directory"]);
        await page
            .getByRole("button", { name: "Sort by Owner descending" })
            .click();
        // Descending metadata still keeps a hidden entry after its visible tie.
        await expectOrder(["z-directory", "alpha.txt", hidden, "beta.txt"]);
        await page
            .getByRole("button", { name: "Sort by Group ascending" })
            .click();
        await expectOrder(["beta.txt", "alpha.txt", hidden, "z-directory"]);
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

        await page
            .getByRole("button", {
                name: "Actions for directory subdir1",
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: "Actions for directory subdir1" })
            .getByRole("button", { name: "Download", exact: true })
            .click();
        const downloadDialog = page.getByRole("dialog", {
            name: "Download directory",
        });
        // Directory downloads explain their streaming archive format before starting.
        await expect(downloadDialog).toContainText(
            "streamed as a .tar.gz archive",
        );
        const downloadDirectory = downloadDialog.getByRole("link", {
            name: "Download .tar.gz",
            exact: true,
        });
        await expect(downloadDirectory).toBeVisible();
        await expect(downloadDirectory).toHaveAttribute(
            "href",
            new RegExp(
                `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/.*[?&]download=1`,
            ),
        );

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
        let pathSearchRequests = 0;
        page.on("request", (request) => {
            if (new URL(request.url()).pathname.includes("/api/v1/find")) {
                pathSearchRequests += 1;
            }
        });
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
        // File-list filtering never starts recursive transport or exposes its removed controls.
        expect(pathSearchRequests).toBe(0);
        await expect(
            page.getByRole("button", { name: "Search recursively" }),
        ).toHaveCount(0);

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
            page.getByRole("link", {
                name: "Go to the parent directory",
                exact: true,
            }),
        ).toBeVisible();
    });

    test("should support file browser keyboard shortcuts", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        // The visible hint advertises the only shortcut owned by local filtering.
        await expect(filterInput).toHaveAttribute(
            "placeholder",
            "Filter files (f)",
        );
        await page.keyboard.press("f");
        // The local filter shortcut moves focus without changing its search mode.
        await expect(filterInput).toBeFocused();

        await page.keyboard.type("f");
        // Character shortcuts stay inactive while typing into an input.
        await expect(filterInput).toHaveValue("f");
        await page.keyboard.press("Escape");
        // Escape globally releases text controls for immediate shortcut use.
        await expect(filterInput).not.toBeFocused();
        await filterInput.fill("");
        await page.keyboard.press("Escape");

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

        const upLink = page.getByRole("link", {
            name: "Go to the parent directory",
            exact: true,
        });
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

    test("should start tab traversal in the application sidebar", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        const homeLink = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Server home" });
        // Visible application navigation proves the authenticated desktop shell is mounted.
        await expect(homeLink).toBeVisible();
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
            }
        });

        await page.keyboard.press("Tab");

        // Global traversal skips branding but includes the persistent sidebar before agent tabs.
        await expect(homeLink).toBeFocused();
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
        await page.keyboard.press("Escape");
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
        const calculateSize = page.getByRole("button", {
            name: "Calculate size",
            exact: true,
        });
        // Recursive traversal remains opt-in so opening details is fast for large trees.
        await expect(calculateSize).toBeVisible();
        await calculateSize.click();
        // The fixture has 37 bytes across files at multiple directory depths.
        await expect(page.getByLabel("Directory size value")).toHaveText(
            "37 B",
        );
        // Details reuses the same current-path chrome as the Files toolbar.
        await expect(
            page.getByRole("link", { name: "Download", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "More", exact: true }).click();
        const detailsMore = page.getByRole("dialog", { name: "More" });
        await expect(
            detailsMore.getByRole("button", { name: "Rename", exact: true }),
        ).toBeVisible();
        await expect(
            detailsMore.getByRole("button", {
                name: "Select",
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            detailsMore.getByRole("button", {
                name: "Delete directory",
                exact: true,
            }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        // Activating details replaces the child list instead of rendering both dense views together.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).not.toBeVisible();
        // Content-creation actions belong to the file listing rather than metadata view.
        await expect(
            page.getByRole("button", { name: "New", exact: true }),
        ).toHaveCount(0);

        await directoryView
            .getByRole("link", { name: "Files", exact: true })
            .click();

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

    test("should warn when directory size skips entries", async ({ page }) => {
        await page.route(
            "**/api/v1/agents/*/directory-size/**",
            async (route) => {
                await route.fulfill({
                    json: {
                        path: ctx.testDirPath,
                        size: 37,
                        errors: [
                            {
                                path: `${ctx.testDirPath}/linked.txt`,
                                error: "Unsupported filesystem entry type",
                            },
                        ],
                    },
                });
            },
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}?view=details`,
        );

        await page
            .getByRole("button", { name: "Calculate size", exact: true })
            .click();

        // Partial results remain useful even when one entry could not be measured.
        await expect(page.getByLabel("Directory size value")).toHaveText(
            "37 B",
        );
        // The warning summarizes skipped entries without replacing the successful result.
        await expect(page.getByRole("alert")).toHaveText(
            "Could not read the size of 1 entry.",
        );
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
        // Directory Sync reuses the file workspace but hides Diff because the API cannot compare trees.
        await expect(
            page.getByRole("button", { name: "Diff", exact: true }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Copy", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Move", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "view", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(destinationPath)}`,
        );
        // Directory Sync must not expose on-page conflict radios before Copy is chosen.
        await expect(page.getByRole("radio", { name: "Merge" })).toHaveCount(0);
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        const confirmation = page.getByRole("dialog", {
            name: "Copy directory?",
        });
        // Directory copy must be confirmed before the existing-path policy is requested.
        await expect(confirmation).toBeVisible();
        await confirmation
            .getByRole("button", { name: "Confirm copy" })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // An existing directory must open the shared Keep / Replace / Merge prompt.
        await expect(dialog).toBeVisible();
        await dialog
            .getByRole("radio", {
                name: "Merge directories and replace files",
            })
            .check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();

        // A terminal success confirms the selected policy completed on the destination agent.
        await expect(page.getByRole("status")).toContainText(
            "Copy completed successfully",
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

    test("should reverse directory sync and check conflicts at the current path", async ({
        page,
    }) => {
        const currentPath = path.join(
            ctx.testDirPath,
            `reverse-directory-current-${Date.now()}`,
        );
        const selectedPath = path.join(
            ctx.testDirPath,
            `reverse-directory-selected-${Date.now()}`,
        );
        await fs.mkdir(currentPath);
        await fs.mkdir(selectedPath);
        await fs.writeFile(path.join(currentPath, "old.txt"), "old");
        await fs.writeFile(path.join(selectedPath, "new.txt"), "new");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(currentPath)}?view=sync`,
        );
        await page.getByLabel("Sync path").fill(selectedPath);

        // Directory Sync exposes the same explicit direction control while retaining no tree Diff action.
        await page.getByRole("radio", { name: "Receive" }).check();
        await expect(
            page.getByRole("button", { name: "Diff", exact: true }),
        ).toHaveCount(0);
        // View remains tied to the selected source rather than changing to the current destination.
        await expect(
            page.getByRole("link", { name: "view", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(selectedPath)}`,
        );
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await page
            .getByRole("dialog", { name: "Copy directory?" })
            .getByRole("button", { name: "Confirm copy" })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // The current directory already exists, so reverse mode must request a destination policy.
        await expect(dialog).toBeVisible();
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        await expect(page.getByRole("status")).toContainText(
            "Copy completed successfully",
        );
        // Replacement contents prove the selected directory flowed back into the current path.
        await expect(
            fs.readFile(path.join(currentPath, "new.txt"), "utf8"),
        ).resolves.toBe("new");
        await expect(
            fs.access(path.join(currentPath, "old.txt")),
        ).rejects.toThrow();
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

    test("should navigate using the parent directory button", async ({
        page,
    }) => {
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

        await page
            .getByRole("link", {
                name: "Go to the parent directory",
                exact: true,
            })
            .click();

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
            name: "Go to the parent directory",
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
});
