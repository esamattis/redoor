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

    test("should link View for plain text files", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        // View links to the text representation after UTF-8 sniffing marks the file editable.
        await expect(
            page.getByRole("link", { name: "View", exact: true }),
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
        await page.getByRole("link", { name: "View", exact: true }).click();

        await expect(page).toHaveURL(/\?view=edit$/);
        // The textarea should contain the on-disk contents so edits start from truth.
        await expect(page.getByLabel("File editor")).toHaveValue("content1");
        // The switch identifies View as the active file representation while editing.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "View", exact: true }),
        ).toHaveAttribute("aria-current", "page");
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

    test("should show unsupported message for binary files", async ({
        page,
    }) => {
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

        // Non-image binaries still expose View so users get an explicit unsupported state.
        await page.getByRole("link", { name: "View", exact: true }).click();
        await expect(page).toHaveURL(/\?view=edit$/);
        await expect(page.getByLabel("Unsupported file type")).toHaveText(
            "Viewing this file type is not supported",
        );
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("binary.bin");
    });

    test("should show unsupported message for large text files", async ({
        page,
    }) => {
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

        // Size gating routes oversized text to the unsupported view instead of a huge textarea.
        await page.getByRole("link", { name: "View", exact: true }).click();
        await expect(page.getByLabel("Unsupported file type")).toHaveText(
            "Viewing this file type is not supported",
        );
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("large.txt");
    });

    test("should open image view for PNG magic bytes without relying on extension", async ({
        page,
    }) => {
        const imagePath = path.join(ctx.testDirPath, "photo.bin");
        // Minimal PNG signature so the agent marks the path viewable by content.
        await fs.writeFile(
            imagePath,
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "photo.bin", exact: true })
            .click();
        await page.getByRole("link", { name: "View", exact: true }).click();

        await expect(page).toHaveURL(/\?view=edit$/);
        // Image representation is selected in the same View switch used by the text editor.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "View", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
            page.getByRole("img", { name: "photo.bin" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("photo.bin");
    });
});
