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

declare global {
    interface PerformanceEntry {
        readonly value: number;
    }

    interface Window {
        selectionLayoutShiftObserver?: PerformanceObserver;
        selectionLayoutShiftValues?: number[];
    }
}

test.describe.serial("Copy Operations", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("copy");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should show the copy destination action only with a selection", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        let copyButton = page.getByRole("button", {
            name: "Copy selected items to this directory",
        });
        const fileListing = page.getByRole("table").first();

        // An unavailable copy action no longer consumes a full row above the listing.
        await expect(copyButton).toHaveCount(0);

        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();

        // Copying onto the same path is unusable, so the action remains hidden at the source.
        await expect(copyButton).toHaveCount(0);
        await page.getByRole("link", { name: "subdir1", exact: true }).click();

        copyButton = page.getByRole("button", {
            name: "Copy selected items to this directory",
        });
        // A distinct destination reveals the copy action in the directory toolbar.
        await expect(copyButton).toBeVisible();
        await expect(copyButton).toBeEnabled();

        await page.getByRole("button", { name: "Show", exact: true }).click();
        const selectedItemsPanel = page.getByRole("tabpanel", {
            name: /Selected/,
        });

        // The popup no longer contains the copy action after it was moved into the directory.
        await expect(
            selectedItemsPanel.getByRole("button", {
                name: "Copy selected items to this directory",
            }),
        ).toHaveCount(0);

        const copyButtonBox = await copyButton.boundingBox();
        const fileListingBox = await fileListing.boundingBox();

        // Comparing vertical positions verifies the contextual action remains above the file listing.
        expect(copyButtonBox).not.toBeNull();
        expect(fileListingBox).not.toBeNull();
        expect(copyButtonBox?.y).toBeLessThan(fileListingBox?.y ?? 0);

        // Drop the selection so later serial tests start from a clean clipboard state.
        await page.getByRole("button", { name: "Clear selection" }).click();
        // Clearing removes the selected row while leaving the persistent drawer available.
        await expect(
            selectedItemsPanel.getByRole("link", {
                name: "file1.txt",
                exact: true,
            }),
        ).toHaveCount(0);
    });

    test("should select a file without shifting the file list layout", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await expect(
            page.getByRole("button", { name: "Select file file1.txt" }),
        ).toBeVisible();
        await page.evaluate(async () => document.fonts.ready);

        const supportsLayoutShift = await page.evaluate(() =>
            PerformanceObserver.supportedEntryTypes.includes("layout-shift"),
        );
        test.skip(
            !supportsLayoutShift,
            "The browser does not expose layout-shift performance entries",
        );

        await page.evaluate(() => {
            window.selectionLayoutShiftValues = [];
            window.selectionLayoutShiftObserver = new PerformanceObserver(
                (entries) => {
                    window.selectionLayoutShiftValues?.push(
                        ...entries.getEntries().map((entry) => entry.value),
                    );
                },
            );
            window.selectionLayoutShiftObserver.observe({
                type: "layout-shift",
            });
        });

        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();
        await expect(
            page.getByRole("button", { name: "Unselect file file1.txt" }),
        ).toBeVisible();
        await page.evaluate(
            () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    );
                }),
        );

        const layoutShift = await page.evaluate(() => {
            const observer = window.selectionLayoutShiftObserver;
            const pendingValues =
                observer?.takeRecords().map((entry) => entry.value) ?? [];
            observer?.disconnect();
            return [
                ...(window.selectionLayoutShiftValues ?? []),
                ...pendingValues,
            ].reduce((total, value) => total + value, 0);
        });

        // Selecting a row must not move the file list or surrounding browser controls.
        expect(layoutShift).toBe(0);

        await page.getByRole("button", { name: "Clear selection" }).click();
    });

    test("should copy two selected files into a new subdirectory", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const copyTargetDirName = `selected-copy-target-${Date.now()}`;
        const copyTargetDirPath = path.join(
            ctx.testDirPath,
            "subdir1",
            copyTargetDirName,
        );
        await fs.rm(copyTargetDirPath, { force: true, recursive: true });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await expect(
            page.getByRole("button", { name: "Select file file1.txt" }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();
        await page
            .getByRole("button", { name: "Select file file2.txt" })
            .click();
        // The summary proves both source rows entered the persistent selection.
        await expect(
            page.getByText("2 files, 0 directories selected"),
        ).toBeVisible();

        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New directory", exact: true })
            .click();
        await page
            .getByRole("textbox", { name: "Directory name" })
            .fill(copyTargetDirName);
        await page
            .getByRole("dialog", { name: "Create directory" })
            .getByRole("button", { name: "Create directory", exact: true })
            .click();

        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(copyTargetDirPath)}`,
        );
        const copyResponses: boolean[] = [];
        page.on("response", (response) => {
            if (
                response.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                response.request().method() === "POST"
            ) {
                copyResponses.push(response.ok());
            }
        });

        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();
        await expect.poll(() => copyResponses.length).toBe(2);
        // Both accepted responses prove each selected source started its own copy.
        expect(copyResponses).toEqual([true, true]);
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });

        await page.reload();
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "file2.txt", exact: true }),
        ).toBeVisible();
        // Filesystem contents verify both copies landed in the newly created destination.
        await expect(
            fs.readFile(path.join(copyTargetDirPath, "file1.txt"), "utf8"),
        ).resolves.toBe("content1");
        await expect(
            fs.readFile(path.join(copyTargetDirPath, "file2.txt"), "utf8"),
        ).resolves.toBe("content2");
    });

    test("should copy a file to a newly created directory within the same agent", async ({
        page,
    }) => {
        // This flow performs several agent round trips before the copy, so the
        // default 30-second whole-test budget is too close to its backend wait.
        test.setTimeout(60_000);
        const copyTargetDirName = `copy-target-${Date.now()}`;
        const copyTargetDirPath = path.join(ctx.testDirPath, copyTargetDirName);
        const copiedFilePath = path.join(copyTargetDirPath, "file1.txt");

        await fs.rm(copyTargetDirPath, { force: true, recursive: true });

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        // Wait for the nested listing to render so the create action receives the test directory path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await expect(
            page.getByRole("button", { name: "Select file file1.txt" }),
        ).toBeVisible();

        // Create a new directory that will serve as the copy destination.
        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New directory", exact: true })
            .click();
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toBeVisible();
        await page
            .getByRole("textbox", { name: "Directory name" })
            .fill(copyTargetDirName);
        await page
            .getByRole("dialog", { name: "Create directory" })
            .getByRole("button", { name: "Create directory", exact: true })
            .click();
        // Creation navigates directly into the destination so it is ready for immediate use.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(copyTargetDirPath)}`,
        );

        // Prefer an explicit parent navigation over history back: bfcache can restore a
        // listing that still omits the directory that was just created.
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );

        // Returning to the parent makes the source file and new directory available.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await expect(
            page.getByRole("button", { name: "Select file file1.txt" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: copyTargetDirName, exact: true }),
        ).toBeVisible();

        // Clear any leftover selection from earlier serial tests in this worker.
        const clearSelection = page.getByRole("button", {
            name: "Clear selection",
        });
        if (await clearSelection.isVisible()) {
            await clearSelection.click();
        }

        // Select the source file from the parent directory.
        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();

        await page.getByRole("button", { name: "Show", exact: true }).click();
        const selectedItemsPanel = page.getByRole("tabpanel", {
            name: /Selected/,
        });
        // The selected-items panel must show the file we just chose, not another row.
        await expect(
            selectedItemsPanel.getByRole("link", {
                name: "file1.txt",
                exact: true,
            }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Minimize bottom drawer" })
            .click();

        // Navigate into the newly created directory to set it as the copy destination.
        await page
            .getByRole("link", { name: copyTargetDirName, exact: true })
            .click();
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(copyTargetDirPath)}`,
        );

        // The selection persists across navigation, so the destination action is enabled.
        const copyButton = page.getByRole("button", {
            name: "Copy selected items to this directory",
        });
        await expect(copyButton).toBeEnabled();
        // The compact action keeps details in its accessible label and tooltip.
        await expect(copyButton).toHaveText("Copy");

        const copyResponsePromise = page.waitForResponse(
            (response) =>
                response.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                response.request().method() === "POST",
        );
        await copyButton.click();
        const copyResponse = await copyResponsePromise;

        // An accepted API response proves the click reached the intended copy route.
        expect(copyResponse.ok()).toBe(true);
        // Terminal success clears the copied item rather than clearing it on request acceptance.
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });

        // Reload the page because the directory listing does not auto-refresh after copy.
        await page.reload();

        // Seeing the copied file in the destination directory proves the copy landed in the right place.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const copiedContent = await fs.readFile(copiedFilePath, "utf-8");

        // Matching contents proves the copy preserved the original file bytes.
        expect(copiedContent).toBe("content1");
    });

    test("should copy a file from one agent to another agent", async ({
        page,
    }) => {
        const crossAgentCopiedPath = path.join(
            "dev_agents",
            "agent2",
            "file1.txt",
        );

        await fs.rm(crossAgentCopiedPath, { force: true });

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        // Select the file on the source agent.
        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();

        // The source directory hides copy because it would overwrite the same path.
        await expect(
            page.getByRole("button", {
                name: "Copy selected items to this directory",
            }),
        ).toHaveCount(0);

        // Navigate to the destination agent via the right menu so the
        // selection state survives the client-side navigation.
        await page.getByRole("link", { name: "agent2_custom" }).click();

        await expect(page).toHaveURL(ctx.agent2BrowserUrl);

        // The selection persists across agents, so the destination action remains enabled.
        const copyButton = page.getByRole("button", {
            name: "Copy selected items to this directory",
        });
        await expect(copyButton).toBeEnabled();

        await copyButton.click();

        // Cross-agent copies use the same terminal transfer state before clearing selection.
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });

        // Reload the page because the directory listing does not auto-refresh after copy.
        await page.reload();

        // Seeing the copied file in the destination agent proves the cross-agent copy landed in the right place.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const copiedContent = await fs.readFile(crossAgentCopiedPath, "utf-8");

        // Matching contents proves the cross-agent copy preserved the original file bytes.
        expect(copiedContent).toBe("content1");

        await fs.rm(crossAgentCopiedPath, { force: true });
    });
});
