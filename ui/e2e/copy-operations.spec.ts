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

/** Selects one source entry and opens the directory that contains its conflict. */
async function openCopyConflict(props: {
    page: import("@playwright/test").Page;
    ctx: TestContext;
    sourceName: string;
    sourceType: "file" | "directory";
    destinationDirectoryName: string;
}) {
    await props.page.goto(
        `${WEB_BASE_URL}/agents/${props.ctx.agentId}/browser/${props.ctx.testDirUrlPath}`,
    );
    await props.page
        .getByRole("button", {
            name: `Select ${props.sourceType} ${props.sourceName}`,
        })
        .click();
    await props.page
        .getByRole("link", {
            name: props.destinationDirectoryName,
            exact: true,
        })
        .click();
    await props.page
        .getByRole("button", {
            name: "Copy selected items to this directory",
        })
        .click();
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

    test("should keep an existing file when resolving a copy conflict", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const sourceName = `keep-existing-${Date.now()}.txt`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        const destinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            sourceName,
        );
        await fs.writeFile(sourcePath, "source content");
        await fs.writeFile(destinationPath, "destination content");

        await openCopyConflict({
            page,
            ctx,
            sourceName,
            sourceType: "file",
            destinationDirectoryName: "subdir1",
        });
        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // A same-named destination must interrupt the copy before any request starts.
        await expect(dialog).toBeVisible();
        // The policy explanation must clarify that files do not have distinct merge behavior.
        await expect(dialog).toContainText(
            "For files, Replace and Merge both replace the existing file.",
        );
        // Keeping the destination is the safe default conflict policy.
        await expect(
            dialog.getByRole("radio", { name: "Keep existing" }),
        ).toBeChecked();

        const copyRequest = page.waitForRequest(
            (request) =>
                request.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                request.method() === "POST",
        );
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        // The selected dialog action must be forwarded to the copy API.
        expect((await copyRequest).postDataJSON().on_existing).toBe("error");
        // The terminal transfer error must be reported after choosing the safe policy.
        await expect(page.getByRole("alert")).toContainText("Copy failed", {
            timeout: 30_000,
        });
        // Error policy must preserve the destination bytes.
        await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe(
            "destination content",
        );
        // A failed copy must also preserve the source and its selection.
        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(
            "source content",
        );
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Clear selection" }).click();
    });

    test("should replace an existing directory when resolving a copy conflict", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const sourceName = `replace-existing-${Date.now()}`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        const destinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            sourceName,
        );
        await fs.mkdir(sourcePath);
        await fs.writeFile(path.join(sourcePath, "conflict.txt"), "source");
        await fs.writeFile(path.join(sourcePath, "source-only.txt"), "source");
        await fs.mkdir(destinationPath);
        await fs.writeFile(
            path.join(destinationPath, "conflict.txt"),
            "destination",
        );
        await fs.writeFile(
            path.join(destinationPath, "destination-only.txt"),
            "destination",
        );

        await openCopyConflict({
            page,
            ctx,
            sourceName,
            sourceType: "directory",
            destinationDirectoryName: "subdir1",
        });
        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        const copyRequest = page.waitForRequest(
            (request) =>
                request.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                request.method() === "POST",
        );
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        // Choosing replacement must map to the API's override policy.
        expect((await copyRequest).postDataJSON().on_existing).toBe("override");
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // Override must publish the source version of conflicting content.
        await expect(
            fs.readFile(path.join(destinationPath, "conflict.txt"), "utf8"),
        ).resolves.toBe("source");
        // Override must include entries that only exist in the source.
        await expect(
            fs.readFile(path.join(destinationPath, "source-only.txt"), "utf8"),
        ).resolves.toBe("source");
        // Override replaces the entire destination rather than retaining old entries.
        await expect(
            fs.stat(path.join(destinationPath, "destination-only.txt")),
        ).rejects.toThrow();
    });

    test("should merge an existing directory when resolving a copy conflict", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const sourceName = `merge-existing-${Date.now()}`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        const destinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            sourceName,
        );
        await fs.mkdir(sourcePath);
        await fs.writeFile(path.join(sourcePath, "conflict.txt"), "source");
        await fs.writeFile(path.join(sourcePath, "source-only.txt"), "source");
        await fs.mkdir(destinationPath);
        await fs.writeFile(
            path.join(destinationPath, "conflict.txt"),
            "destination",
        );
        await fs.writeFile(
            path.join(destinationPath, "destination-only.txt"),
            "destination",
        );

        await openCopyConflict({
            page,
            ctx,
            sourceName,
            sourceType: "directory",
            destinationDirectoryName: "subdir1",
        });
        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        await dialog.getByRole("radio", { name: "Merge directories" }).check();
        const copyRequest = page.waitForRequest(
            (request) =>
                request.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                request.method() === "POST",
        );
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        // Choosing merge must map directly to the API's merge policy.
        expect((await copyRequest).postDataJSON().on_existing).toBe("merge");
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // Merge must favor the source when both trees contain the same entry.
        await expect(
            fs.readFile(path.join(destinationPath, "conflict.txt"), "utf8"),
        ).resolves.toBe("source");
        // Merge must add entries found only in the source tree.
        await expect(
            fs.readFile(path.join(destinationPath, "source-only.txt"), "utf8"),
        ).resolves.toBe("source");
        // Merge must retain entries found only in the destination tree.
        await expect(
            fs.readFile(
                path.join(destinationPath, "destination-only.txt"),
                "utf8",
            ),
        ).resolves.toBe("destination");
    });

    test("should copy multiple selected files when only one conflicts", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const suffix = Date.now();
        const conflictingName = `batch-conflict-${suffix}.txt`;
        const availableName = `batch-available-${suffix}.txt`;
        const conflictingSourcePath = path.join(
            ctx.testDirPath,
            conflictingName,
        );
        const availableSourcePath = path.join(ctx.testDirPath, availableName);
        const conflictingDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            conflictingName,
        );
        const availableDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            availableName,
        );
        await fs.writeFile(conflictingSourcePath, "new conflict content");
        await fs.writeFile(availableSourcePath, "available content");
        await fs.writeFile(conflictingDestinationPath, "old conflict content");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("button", {
                name: `Select file ${conflictingName}`,
            })
            .click();
        await page
            .getByRole("button", { name: `Select file ${availableName}` })
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // The dialog must count only the conflicting member of the two-file batch.
        await expect(dialog).toContainText("1 selected item has the same name");
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // The chosen policy must replace the one conflicting destination file.
        await expect(
            fs.readFile(conflictingDestinationPath, "utf8"),
        ).resolves.toBe("new conflict content");
        // The same batch must still copy the file that had no destination conflict.
        await expect(
            fs.readFile(availableDestinationPath, "utf8"),
        ).resolves.toBe("available content");
    });

    test("should copy multiple selected directories when only one conflicts", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const suffix = Date.now();
        const conflictingName = `batch-conflict-dir-${suffix}`;
        const availableName = `batch-available-dir-${suffix}`;
        const conflictingSourcePath = path.join(
            ctx.testDirPath,
            conflictingName,
        );
        const availableSourcePath = path.join(ctx.testDirPath, availableName);
        const conflictingDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            conflictingName,
        );
        const availableDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            availableName,
        );
        await fs.mkdir(conflictingSourcePath);
        await fs.writeFile(
            path.join(conflictingSourcePath, "conflict.txt"),
            "source",
        );
        await fs.mkdir(availableSourcePath);
        await fs.writeFile(
            path.join(availableSourcePath, "available.txt"),
            "available",
        );
        await fs.mkdir(conflictingDestinationPath);
        await fs.writeFile(
            path.join(conflictingDestinationPath, "conflict.txt"),
            "destination",
        );
        await fs.writeFile(
            path.join(conflictingDestinationPath, "destination-only.txt"),
            "destination only",
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("button", {
                name: `Select directory ${conflictingName}`,
            })
            .click();
        await page
            .getByRole("button", {
                name: `Select directory ${availableName}`,
            })
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // The dialog must count only the conflicting member of the directory batch.
        await expect(dialog).toContainText("1 selected item has the same name");
        await dialog.getByRole("radio", { name: "Merge directories" }).check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // Merge must replace the conflicting entry with the source version.
        await expect(
            fs.readFile(
                path.join(conflictingDestinationPath, "conflict.txt"),
                "utf8",
            ),
        ).resolves.toBe("source");
        // Merge must preserve destination-only entries in the conflicting directory.
        await expect(
            fs.readFile(
                path.join(conflictingDestinationPath, "destination-only.txt"),
                "utf8",
            ),
        ).resolves.toBe("destination only");
        // The non-conflicting directory must be copied as part of the same batch.
        await expect(
            fs.readFile(
                path.join(availableDestinationPath, "available.txt"),
                "utf8",
            ),
        ).resolves.toBe("available");
    });

    test("should copy other selected files when one source is already in the destination", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const copiedFilePath = path.join(
            ctx.testDirPath,
            "subdir1",
            "file1.txt",
        );
        await fs.rm(copiedFilePath, { force: true });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        await page
            .getByRole("button", { name: "Select file nested1.txt" })
            .click();

        // The mixed selection must expose Copy even though one item already has its destination path.
        const copyButton = page.getByRole("button", {
            name: "Copy selected items to this directory",
        });
        await expect(copyButton).toBeEnabled();

        const copyResponses: number[] = [];
        page.on("response", (response) => {
            if (
                response.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                response.request().method() === "POST"
            ) {
                copyResponses.push(response.status());
            }
        });
        await copyButton.click();

        await expect.poll(() => copyResponses.length).toBe(2);
        // One rejection must not prevent the independent valid request from being accepted.
        expect([...copyResponses].sort((left, right) => left - right)).toEqual([
            200, 400,
        ]);
        await expect(
            page.getByText(
                "Copied 1 of 2 items. Source and destination must be different",
                { exact: true },
            ),
        ).toBeVisible({ timeout: 30_000 });

        // The successful file must reach the destination despite the same-path error.
        await expect(fs.readFile(copiedFilePath, "utf8")).resolves.toBe(
            "content1",
        );
        // Only the rejected same-path file must remain selected after terminal copy success.
        await expect(
            page.getByText("1 file, 0 directories selected"),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Unselect file nested1.txt" }),
        ).toBeVisible();
        await expect(copyButton).toHaveCount(0);

        await page.getByRole("button", { name: "Clear selection" }).click();
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
