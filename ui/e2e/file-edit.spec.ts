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

test.describe.serial("File Edit View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should show edit button for plain text files", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        // Edit is only offered after the agent marks the file editable via UTF-8 sniffing.
        await expect(
            page.getByRole("link", { name: "Edit", exact: true }),
        ).toBeVisible();
    });

    test("should open edit view via query param and load content", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Edit", exact: true }).click();

        await expect(page).toHaveURL(/\?view=edit$/);
        // The textarea should contain the on-disk contents so edits start from truth.
        await expect(page.getByLabel("File editor")).toHaveValue("content1");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Restore file contents" }),
        ).toBeDisabled();
    });

    test("should restore unsaved edits", async ({ page }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expect(editor).toHaveValue("content1");

        await editor.fill("temporary unsaved text");
        await expect(editor).toHaveValue("temporary unsaved text");
        // Restore must undo in-memory edits without writing to disk.
        await page
            .getByRole("button", { name: "Restore file contents" })
            .click();
        await expect(editor).toHaveValue("content1");
    });

    test("should save edits to disk", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expect(editor).toHaveValue("content1");
        await editor.click();
        await editor.fill("saved from ui");
        // Wait until React marks the buffer dirty so Save is actually clickable.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Save file" }).click();

        // Status feedback confirms the upload completed in the UI.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // Polling the filesystem verifies the PUT actually replaced remote bytes.
        await expect
            .poll(async () => fs.readFile(filePath, "utf8"))
            .toBe("saved from ui");
    });

    test("should hide edit button for binary files", async ({ page }) => {
        const binaryPath = path.join(ctx.testDirPath, "binary.bin");
        await fs.writeFile(
            binaryPath,
            Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
        );

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "binary.bin", exact: true })
            .click();

        // Invalid UTF-8 must not expose the text editor even when listed as a regular file.
        await expect(
            page.getByRole("link", { name: "Edit", exact: true }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("binary.bin");
    });

    test("should hide edit button for large text files", async ({ page }) => {
        const largePath = path.join(ctx.testDirPath, "large.txt");
        // Just over the 2 MiB editor limit so multi-megabyte text stays download-only.
        const largeContent = "a".repeat(2 * 1024 * 1024 + 1);
        await fs.writeFile(largePath, largeContent);

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "large.txt", exact: true })
            .click();

        // Size gating prevents loading multi-megabyte bodies into a textarea.
        await expect(
            page.getByRole("link", { name: "Edit", exact: true }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("large.txt");
    });
});
