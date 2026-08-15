import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File Operations", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("ops");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should upload files from directory view", async ({ page }) => {
        const uploadSourceDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-upload-"),
        );
        const firstUploadPath = path.join(uploadSourceDir, "uploaded-a.txt");
        const secondUploadPath = path.join(uploadSourceDir, "uploaded-b.txt");

        await fs.writeFile(firstUploadPath, "uploaded content a");
        await fs.writeFile(secondUploadPath, "uploaded content b");

        try {
            await page.goto(ctx.agentBrowserUrl);
            await page
                .locator(
                    `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
                )
                .click();
            const uploadDestinationUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
            await Promise.all([
                page.waitForURL(uploadDestinationUrl),
                page
                    .getByRole("link", { name: "subdir3", exact: true })
                    .click(),
            ]);
            await expect(
                page.getByRole("navigation", { name: "Breadcrumbs" }),
            ).toContainText("subdir3");

            const uploadsCompleted = Promise.all([
                page.waitForResponse(
                    (response) =>
                        response.request().method() === "PUT" &&
                        response.url().includes("uploaded-a.txt") &&
                        response.ok(),
                ),
                page.waitForResponse(
                    (response) =>
                        response.request().method() === "PUT" &&
                        response.url().includes("uploaded-b.txt") &&
                        response.ok(),
                ),
            ]);
            await page
                .getByLabel("Choose files to upload")
                .setInputFiles([firstUploadPath, secondUploadPath]);
            await uploadsCompleted;

            // Uploads remain in directory context instead of switching to a dedicated queue route.
            await expect(page).toHaveURL(uploadDestinationUrl);
            await page.reload();
            // Both files appearing in the refreshed list proves the uploads completed in place.
            await expect(
                page.getByRole("link", {
                    name: "uploaded-a.txt",
                    exact: true,
                }),
            ).toBeVisible();
            await expect(
                page.getByRole("link", {
                    name: "uploaded-b.txt",
                    exact: true,
                }),
            ).toBeVisible();

            // Transfers remain separate from agent tabs in the application sidebar.
            await page
                .getByRole("navigation", { name: "Application" })
                .getByRole("link", { name: "Transfers" })
                .click();
            await expect(page).toHaveURL(new RegExp("/transfers$"));

            // This confirms the transfer history page reflects the completed upload state for the first uploaded file.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .filter({ hasText: "completed" })
                    .last(),
            ).toBeVisible();
            // This verifies the first uploaded file name is rendered in transfer history even if multiple matching rows exist during refreshes.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .last(),
            ).toBeVisible();
            // This verifies multi-file uploads are tracked independently in transfer history even if multiple matching rows exist during refreshes.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-b.txt" })
                    .last(),
            ).toBeVisible();
        } finally {
            await fs.rm(uploadSourceDir, { force: true, recursive: true });
        }
    });

    test("should keep a single-file upload in the directory view", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const uploadName = `single-upload-${Date.now()}.txt`;
        let releaseUpload = () => {};
        let notifyUploadStarted = () => {};
        const uploadStarted = new Promise<void>((resolve) => {
            notifyUploadStarted = resolve;
        });
        const uploadGate = new Promise<void>((resolve) => {
            releaseUpload = resolve;
        });
        await page.route("**/raw/**", async (route) => {
            if (route.request().method() !== "PUT") {
                await route.continue();
                return;
            }
            notifyUploadStarted();
            await uploadGate;
            await route.continue();
        });
        await page.goto(directoryUrl);

        await page.getByRole("button", { name: "Upload", exact: true }).click();
        // The upload menu makes the existing drag-and-drop workflow discoverable.
        await expect(
            page.getByText(
                "You can also upload files by dragging and dropping them into this directory.",
            ),
        ).toBeVisible();
        await page.keyboard.press("Escape");

        await page.getByLabel("Choose files to upload").setInputFiles({
            name: uploadName,
            mimeType: "text/plain",
            buffer: Buffer.from("single uploaded content"),
        });

        await uploadStarted;
        // A file that immediately claimed a scheduler slot never appears as waiting.
        await expect(
            page.getByRole("heading", { name: /Upload queue/ }),
        ).toHaveCount(0);
        releaseUpload();
        // A single upload remains in context instead of opening queue details unnecessarily.
        await expect(page).toHaveURL(directoryUrl);
        // The refreshed listing confirms the background upload completed without requiring the queue view.
        await expect(
            page.getByRole("link", { name: uploadName, exact: true }),
        ).toBeVisible();
        // Disk contents verify that remaining in the directory did not interrupt the upload.
        await expect(
            fs.readFile(path.join(directoryPath, uploadName), "utf8"),
        ).resolves.toBe("single uploaded content");
    });

    test("should upload a selected directory with nested paths", async ({
        page,
    }) => {
        const sourceParent = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-directory-upload-"),
        );
        const sourceDirectory = path.join(sourceParent, "selected-directory");
        const nestedDirectory = path.join(sourceDirectory, "nested");
        const destinationDirectory = path.join(
            ctx.testDirPath,
            "subdir3",
            "selected-directory",
        );
        await fs.mkdir(nestedDirectory, { recursive: true });
        await fs.writeFile(
            path.join(sourceDirectory, "root.txt"),
            "root content",
        );
        await fs.writeFile(
            path.join(nestedDirectory, "nested.txt"),
            "nested content",
        );

        try {
            const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
            await page.goto(directoryUrl);
            await page
                .getByLabel("Choose directory to upload")
                .setInputFiles(sourceDirectory);

            // Directory uploads remain in the current file-list route.
            await expect(page).toHaveURL(directoryUrl);
            // Polling disk contents proves parent directories were created before asynchronous uploads completed.
            await expect
                .poll(async () => {
                    try {
                        return await fs.readFile(
                            path.join(destinationDirectory, "root.txt"),
                            "utf8",
                        );
                    } catch {
                        return null;
                    }
                })
                .toBe("root content");
            await expect
                .poll(async () => {
                    try {
                        return await fs.readFile(
                            path.join(
                                destinationDirectory,
                                "nested",
                                "nested.txt",
                            ),
                            "utf8",
                        );
                    } catch {
                        return null;
                    }
                })
                .toBe("nested content");
        } finally {
            await fs.rm(sourceParent, { force: true, recursive: true });
        }
    });

    test("should reject selections over 100 files", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
        await page.goto(directoryUrl);
        const files = Array.from({ length: 101 }, (_value, index) => ({
            name: `over-limit-${index}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(String(index)),
        }));

        await page.getByLabel("Choose files to upload").setInputFiles(files);

        // The complete source is rejected so no partial upload begins unexpectedly.
        await expect(
            page.getByText("Upload queues are limited to 100 files."),
        ).toBeVisible();
        // Staying in the file view confirms rejection does not redirect to an empty queue.
        await expect(page).toHaveURL(directoryUrl);
    });

    test("should upload at most five files concurrently", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
        let activeUploads = 0;
        let maximumActiveUploads = 0;
        let enteredUploads = 0;
        let releaseUploads = () => {};
        const uploadGate = new Promise<void>((resolve) => {
            releaseUploads = resolve;
        });
        await page.route("**/raw/**", async (route) => {
            if (route.request().method() !== "PUT") {
                await route.continue();
                return;
            }
            activeUploads += 1;
            enteredUploads += 1;
            maximumActiveUploads = Math.max(
                maximumActiveUploads,
                activeUploads,
            );
            await uploadGate;
            await route.fulfill({ status: 200, body: "{}" });
            activeUploads -= 1;
        });
        await page.goto(directoryUrl);
        const files = Array.from({ length: 6 }, (_value, index) => ({
            name: `concurrency-${index}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(String(index)),
        }));

        await page.getByLabel("Choose files to upload").setInputFiles(files);

        // Five blocked requests prove the scheduler fills every available upload slot.
        await expect.poll(() => enteredUploads).toBe(5);
        // Uploads with active scheduler slots are omitted from the waiting queue.
        await expect(
            page.getByRole("heading", { name: "Upload queue (1 waiting)" }),
        ).toBeVisible();
        // The sixth file must remain waiting until one of those upload slots is released.
        await expect(page.getByText("concurrency-5.txt")).toBeVisible();
        releaseUploads();
        // The inline queue disappears as soon as the final file starts uploading.
        await expect(
            page.getByRole("heading", { name: /Upload queue/ }),
        ).toHaveCount(0);
        await expect.poll(() => enteredUploads).toBe(6);
        // Network interception verifies no scheduling race exceeded the configured cap.
        expect(maximumActiveUploads).toBe(5);
    });

    test("should create directory from directory view", async ({ page }) => {
        const createdDirectoryName = `created-via-ui-${Date.now()}`;
        const createdDirectoryPath = path.join(
            ctx.testDirPath,
            "subdir3",
            createdDirectoryName,
        );

        await fs.rm(createdDirectoryPath, { force: true, recursive: true });

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir3", exact: true }).click();

        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New directory", exact: true })
            .hover();
        // The menu action advertises the equivalent keyboard shortcut.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Create a new directory (d)",
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press("d");

        // The shortcut opens the same dialog as the menu action.
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toBeVisible();
        // Autofocus lets users type the name immediately after choosing New directory.
        await expect(
            page.getByRole("textbox", { name: "Directory name" }),
        ).toBeFocused();

        const directoryNameInput = page.getByRole("textbox", {
            name: "Directory name",
        });
        await page.keyboard.type("d");
        // Typing the shortcut key into an input must enter text instead of reopening the dialog.
        await expect(directoryNameInput).toHaveValue("d");
        await directoryNameInput.fill(createdDirectoryName);

        // The preview path confirms the UI targets the current directory instead of the agent root.
        await expect(page.getByText(createdDirectoryPath)).toBeVisible();

        await page
            .getByRole("dialog", { name: "Create directory" })
            .getByRole("button", { name: "Create directory", exact: true })
            .click();

        // The created directory becomes the active location so users can work in it immediately.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(createdDirectoryPath)}`,
        );

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);

        // A directory on disk proves the UI action created the requested directory through the backend.
        expect(createdDirectoryStats.isDirectory()).toBe(true);
    });

    test("should create a new file and open it in the editor", async ({
        page,
    }) => {
        const fileName = `created-via-ui-${Date.now()}.txt`;
        const filePath = path.join(ctx.testDirPath, "subdir3", fileName);
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;

        await page.goto(directoryUrl);
        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New file", exact: true })
            .click();

        const dialog = page.getByRole("dialog", { name: "Create file" });
        // The dedicated dialog keeps file naming explicit before creating anything remotely.
        await expect(dialog).toBeVisible();
        // Autofocus lets users type the name immediately after choosing New file.
        await expect(
            dialog.getByRole("textbox", { name: "File name" }),
        ).toBeFocused();
        await dialog.getByRole("textbox", { name: "File name" }).fill(fileName);
        // The path preview confirms the empty file will be created in the active directory.
        await expect(dialog.getByText(filePath)).toBeVisible();
        await dialog
            .getByRole("button", { name: "Create file", exact: true })
            .click();

        // New files open directly in edit mode so content can be entered immediately.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );
        // The editor being ready proves the empty upload produced an editable text file.
        await expect(
            page.getByRole("textbox", { name: "File editor" }),
        ).toBeVisible();
        // Disk state verifies the UI action created a zero-byte file through the upload API.
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("");
    });

    test("should explain clipboard paste behavior", async ({ page }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
        await page.goto(directoryUrl);

        await page.getByRole("button", { name: "Paste files or text" }).hover();

        // The tooltip makes it clear that clipboard content becomes a file in this directory.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Pasted text or images are created as new files in this directory.",
        );
    });

    test("should preselect the pasted text filename before its extension", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await page.evaluate(() => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", "pasted content");
            window.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    clipboardData,
                }),
            );
        });

        const dialog = page.getByRole("dialog", { name: "Save pasted text" });
        const fileNameInput = dialog.getByRole("textbox", { name: "Filename" });
        // Selecting only the stem lets typing replace the default name while preserving .txt.
        await expect(fileNameInput).toBeFocused();
        await expect
            .poll(() =>
                fileNameInput.evaluate((input) => ({
                    start:
                        input instanceof HTMLInputElement
                            ? input.selectionStart
                            : null,
                    end:
                        input instanceof HTMLInputElement
                            ? input.selectionEnd
                            : null,
                })),
            )
            .toEqual({ start: 0, end: "pasted-text".length });
    });

    test("should rename a file inline without leaving the directory", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const originalName = `inline.${Date.now()}.archive.txt`;
        const renamedName = `inline-renamed-${Date.now()}.txt`;
        const originalPath = path.join(directoryPath, originalName);
        const renamedPath = path.join(directoryPath, renamedName);
        await fs.writeFile(originalPath, "inline rename content");
        await page.goto(directoryUrl);

        await page
            .getByRole("button", {
                name: `Actions for file ${originalName}`,
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", {
                name: `Actions for file ${originalName}`,
            })
            .getByRole("button", { name: "Rename", exact: true })
            .click();
        const dialog = page.getByRole("dialog", { name: "Rename file" });
        const renameInput = dialog.getByRole("textbox", {
            name: "Rename file",
        });
        // The row action must open the shared focused rename workflow.
        await expect(dialog).toBeVisible();
        await expect(renameInput).toBeFocused();
        // Multi-dot names select only the basename before the first extension separator.
        await expect
            .poll(() =>
                renameInput.evaluate((input) => ({
                    start:
                        input instanceof HTMLInputElement
                            ? input.selectionStart
                            : null,
                    end:
                        input instanceof HTMLInputElement
                            ? input.selectionEnd
                            : null,
                })),
            )
            .toEqual({ start: 0, end: originalName.indexOf(".", 1) });

        await renameInput.fill(renamedName);
        await dialog
            .getByRole("button", { name: "Rename", exact: true })
            .click();

        // A successful inline rename closes its workflow instead of leaving a stale modal open.
        await expect(dialog).toBeHidden();
        // Inline editing keeps the current directory address stable.
        await expect(page).toHaveURL(directoryUrl);
        // Refreshing in place replaces the old entry with the renamed link.
        await expect(
            page.getByRole("link", { name: renamedName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: originalName, exact: true }),
        ).toHaveCount(0);
        // Disk contents prove the inline workflow moved the file without rewriting it.
        await expect(fs.readFile(renamedPath, "utf8")).resolves.toBe(
            "inline rename content",
        );
        await expect(fs.stat(originalPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("should rename a directory inline without opening it", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const originalName = `inline-directory-${Date.now()}`;
        const renamedName = `inline-renamed-directory-${Date.now()}`;
        const originalPath = path.join(directoryPath, originalName);
        const renamedPath = path.join(directoryPath, renamedName);
        await fs.mkdir(originalPath);
        await page.goto(directoryUrl);

        await page
            .getByRole("button", {
                name: `Actions for directory ${originalName}`,
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", {
                name: `Actions for directory ${originalName}`,
            })
            .getByRole("button", { name: "Rename", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Rename directory",
        });
        const renameInput = dialog.getByRole("textbox", {
            name: "Rename directory",
        });
        // Extensionless directory names are selected in full for immediate replacement.
        await expect
            .poll(() =>
                renameInput.evaluate((input) => ({
                    start:
                        input instanceof HTMLInputElement
                            ? input.selectionStart
                            : null,
                    end:
                        input instanceof HTMLInputElement
                            ? input.selectionEnd
                            : null,
                })),
            )
            .toEqual({ start: 0, end: originalName.length });
        await renameInput.fill(renamedName);
        await dialog
            .getByRole("button", { name: "Rename", exact: true })
            .click();

        // Inline directory renames close the modal and retain the parent listing URL.
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(directoryUrl);
        // The new directory link appearing proves route data refreshed in place.
        await expect(
            page.getByRole("link", { name: renamedName, exact: true }),
        ).toBeVisible();
        await expect(fs.stat(renamedPath)).resolves.toMatchObject({});
        await expect(fs.stat(originalPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("should delete a file from its row action menu", async ({ page }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const fileName = `delete-from-row-${Date.now()}.txt`;
        const filePath = path.join(directoryPath, fileName);
        await fs.writeFile(filePath, "temporary row content");
        await page.goto(directoryUrl);

        await page
            .getByRole("button", {
                name: `Actions for file ${fileName}`,
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: `Actions for file ${fileName}` })
            .getByRole("button", { name: "Delete", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Delete this file?",
        });
        // Row deletion retains an explicit destructive confirmation step.
        await expect(dialog).toBeVisible();
        await dialog
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        // Refreshing the listing after deletion removes the stale row in place.
        await expect(
            page.getByRole("link", { name: fileName, exact: true }),
        ).toHaveCount(0);
        // The filesystem check proves the row action deleted the remote path.
        await expect(fs.stat(filePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("should delete file from detail view after confirmation", async ({
        page,
    }) => {
        const deletableFilePath = path.join(
            ctx.testDirPath,
            "subdir3",
            "delete-me.txt",
        );
        await fs.writeFile(deletableFilePath, "temporary content");

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir3", exact: true }).click();
        await page
            .getByRole("link", { name: "delete-me.txt", exact: true })
            .click();

        await page
            .getByRole("button", { name: "File actions", exact: true })
            .click();
        await page
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        // This verifies the UI uses a custom confirmation dialog instead of deleting immediately.
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeVisible();
        // This keeps accidental-delete protection intact by ensuring the cancel action closes the dialog.
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeHidden();

        await page
            .getByRole("button", { name: "File actions", exact: true })
            .click();
        await page
            .getByRole("button", { name: "Delete file", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "Delete this file?" })
            .getByRole("button", { name: "Delete file" })
            .click();

        // Redirecting back to the parent directory confirms the delete request completed successfully.
        await expect(page).toHaveURL(
            new RegExp(
                `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}$`,
            ),
        );
        // The deleted entry disappearing from the listing proves the route refreshed with the new filesystem state.
        await expect(
            page.getByRole("link", { name: "delete-me.txt", exact: true }),
        ).toHaveCount(0);
    });

    test("should delete the open directory from the more menu", async ({
        page,
    }) => {
        const parentDirectoryPath = path.join(ctx.testDirPath, "subdir3");
        const deletableDirectoryName = `delete-directory-${Date.now()}`;
        const deletableDirectoryPath = path.join(
            parentDirectoryPath,
            deletableDirectoryName,
        );
        const parentDirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(parentDirectoryPath)}`;
        await fs.mkdir(deletableDirectoryPath);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(deletableDirectoryPath)}`,
        );

        await page.getByRole("button", { name: "More", exact: true }).click();
        await page
            .getByRole("button", { name: "Delete directory", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Delete this directory?",
        });
        // The directory action must retain the same explicit destructive confirmation as file deletion.
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Delete directory" }).click();

        // Completing the action must leave the now-missing directory instead of keeping the busy dialog open.
        await expect(page).toHaveURL(parentDirectoryUrl);
        await expect(dialog).toBeHidden();
        // The missing entry confirms the parent listing refreshed after recursive deletion.
        await expect(
            page.getByRole("link", {
                name: deletableDirectoryName,
                exact: true,
            }),
        ).toHaveCount(0);
        await expect(fs.stat(deletableDirectoryPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    test("should delete selected file from directory view after confirmation", async ({
        page,
    }) => {
        const deletableFilePath = path.join(
            ctx.testDirPath,
            "subdir3",
            "delete-selected.txt",
        );

        await fs.writeFile(deletableFilePath, "temporary content");

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir3", exact: true }).click();

        await page
            .getByRole("button", {
                name: "Select file delete-selected.txt",
            })
            .click();

        const deleteSelectedItemsButton = page.getByRole("button", {
            name: "Delete selected items",
        });

        // This verifies the selected-items delete action is available after selecting a file.
        await expect(deleteSelectedItemsButton).toBeEnabled();

        await deleteSelectedItemsButton.click();

        const deleteSelectedItemsDialog = page.getByRole("dialog", {
            name: "Delete this selected item?",
        });

        // The confirmation must appear before the destructive selected-items request can run.
        await expect(deleteSelectedItemsDialog).toBeVisible();
        await deleteSelectedItemsDialog
            .getByRole("button", { name: "Delete selected item" })
            .click();

        // The file name is rendered in both the listing and the selected-items panel, so wait on disk state first.
        await expect
            .poll(async () => {
                try {
                    await fs.stat(deletableFilePath);
                    return "present";
                } catch {
                    return "missing";
                }
            })
            .toBe("missing");
        await expect(
            page.getByRole("button", {
                name: "Unselect delete-selected.txt",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", {
                name: "Select file delete-selected.txt",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("row", {
                name: /File entry delete-selected\.txt/,
            }),
        ).toHaveCount(0);
        // The file row disappearing confirms the directory view refreshed after the shared selected-items delete action.
        await expect(
            page.getByRole("button", {
                name: "Unselect file delete-selected.txt",
            }),
        ).toHaveCount(0);
    });
});
