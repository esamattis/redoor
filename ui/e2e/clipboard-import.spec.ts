import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
    WEB_BASE_URL,
} from "./helpers";

test.describe("Clipboard imports", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("clipboard-import");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("prompts for a filename before uploading a pasted image", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const suggestedName = `clipboard-image-${Date.now()}.png`;
        const savedName = `renamed-pasted-image-${Date.now()}.png`;
        const suggestedPath = path.join(directoryPath, suggestedName);
        const savedPath = path.join(directoryPath, savedName);
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await page.evaluate((fileName) => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(
                new File(["image bytes"], fileName, { type: "image/png" }),
            );
            window.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    clipboardData,
                }),
            );
        }, suggestedName);

        const dialog = page.getByRole("dialog", { name: "Save pasted image" });
        const fileNameInput = dialog.getByRole("textbox", { name: "Filename" });
        // The image remains pending locally until the filename dialog is submitted.
        await expect(dialog).toBeVisible();
        await expect(fs.access(suggestedPath)).rejects.toThrow();
        // The clipboard-provided extension remains available when choosing a clearer name.
        await expect(fileNameInput).toHaveValue(suggestedName);
        await fileNameInput.fill(savedName);
        await dialog.getByRole("button", { name: "Upload image" }).click();

        // The confirmed name, rather than the clipboard suggestion, is used for the upload.
        await expect
            .poll(() => fs.readFile(savedPath, "utf8").catch(() => null))
            .toBe("image bytes");
        await expect(fs.access(suggestedPath)).rejects.toThrow();
    });
});
