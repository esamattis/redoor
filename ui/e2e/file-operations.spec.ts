import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
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
            await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
            await page
                .locator(
                    `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
                )
                .click();
            await page.getByRole("link", { name: "subdir3" }).click();

            await page
                .getByLabel("Choose files to upload")
                .setInputFiles([firstUploadPath, secondUploadPath]);

            // This checks the inline status feedback shown next to the upload action.
            await expect(page.getByText("Uploaded 2 files")).toBeVisible();

            // This confirms the transfer progress panel reflects the completed upload state for the first uploaded file.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .filter({ hasText: "completed" })
                    .last(),
            ).toBeVisible();
            // This verifies the first uploaded file name is rendered in transfer progress even if multiple matching rows exist during refreshes.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .last(),
            ).toBeVisible();
            // This verifies multi-file uploads are tracked independently in transfer progress even if multiple matching rows exist during refreshes.
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

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir3", exact: true }).click();

        await page.getByRole("button", { name: "Create directory" }).click();

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

        // Seeing the new entry in the listing confirms the route refreshed with the created directory.
        await expect(
            page.getByRole("link", {
                name: createdDirectoryName,
                exact: true,
            }),
        ).toBeVisible();

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);

        // A directory on disk proves the UI action created the requested directory through the backend.
        expect(createdDirectoryStats.isDirectory()).toBe(true);
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

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir3" }).click();
        await page.getByRole("link", { name: "delete-me.txt" }).click();

        await page.getByRole("button", { name: "Delete file" }).click();

        // This verifies the UI uses a custom confirmation dialog instead of deleting immediately.
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeVisible();
        // This keeps accidental-delete protection intact by ensuring the cancel action closes the dialog.
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeHidden();

        await page.getByRole("button", { name: "Delete file" }).click();
        await page
            .getByRole("dialog", { name: "Delete this file?" })
            .getByRole("button", { name: "Delete file" })
            .click();

        // Redirecting back to the parent directory confirms the delete request completed successfully.
        await expect(page).toHaveURL(
            new RegExp(
                `/agents/${ctx.agentId}/browser/${ctx.testDirName}/subdir3$`,
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

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
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
