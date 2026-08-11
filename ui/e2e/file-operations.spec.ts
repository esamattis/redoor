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
                page.getByRole("link", { name: "subdir3" }).click(),
            ]);
            await expect(
                page.getByRole("navigation", { name: "Breadcrumbs" }),
            ).toContainText("subdir3");

            await page
                .getByLabel("Choose files to upload")
                .setInputFiles([firstUploadPath, secondUploadPath]);

            // This checks the inline status feedback shown next to the upload action.
            await expect(page.getByText("Uploaded 2 files")).toBeVisible();

            // Transfers live in the burger menu so agent tabs remain dedicated to agents.
            await page.getByRole("button", { name: "Open menu" }).click();
            await page
                .getByRole("dialog", { name: "Menu" })
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
            .click();

        // The dialog must open before submitting so the test exercises the browser action rather than the API directly.
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toBeVisible();

        await page
            .getByRole("textbox", { name: "Directory name" })
            .fill(createdDirectoryName);

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
                name: `Rename file ${originalName}`,
                exact: true,
            })
            .click();
        const dialog = page.getByRole("dialog", { name: "Rename file" });
        const renameInput = dialog.getByRole("textbox", {
            name: "Rename file",
        });
        // The inline pencil must open the shared focused rename workflow.
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
                name: `Rename directory ${originalName}`,
                exact: true,
            })
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
        await page.getByRole("link", { name: "subdir3" }).click();
        await page.getByRole("link", { name: "delete-me.txt" }).click();

        await page.getByRole("button", { name: "More", exact: true }).click();
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

        await page.getByRole("button", { name: "More", exact: true }).click();
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
            page.getByRole("link", { name: "delete-me.txt" }),
        ).toHaveCount(0);
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
        await page.getByRole("link", { name: "subdir3" }).click();

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
            name: "Delete this item?",
        });

        // The confirmation must appear before the destructive selected-items request can run.
        await expect(deleteSelectedItemsDialog).toBeVisible();
        await deleteSelectedItemsDialog
            .getByRole("button", { name: "Delete item" })
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
