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

    test("requires a different filename when pasted text would replace a file", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir1");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const existingName = "pasted-text.txt";
        const replacementName = `renamed-pasted-text-${Date.now()}.txt`;
        const existingPath = path.join(directoryPath, existingName);
        const replacementPath = path.join(directoryPath, replacementName);
        await fs.writeFile(existingPath, "original text");
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await page.evaluate(() => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", "new clipboard text");
            window.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    clipboardData,
                }),
            );
        });

        const dialog = page.getByRole("dialog", {
            name: "Save pasted text",
        });
        const fileNameInput = dialog.getByRole("textbox", { name: "Filename" });
        await dialog.getByRole("button", { name: "Upload text" }).click();

        // A collision must stay in the naming workflow instead of dismissing the dialog.
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("alert")).toContainText(
            "already exists. Choose a different filename.",
        );
        // Strict server publication must preserve the file even if it appears during upload.
        await expect
            .poll(() => fs.readFile(existingPath, "utf8"))
            .toBe("original text");

        await fileNameInput.fill(replacementName);
        await dialog.getByRole("button", { name: "Upload text" }).click();

        // Choosing a non-conflicting name must save the originally pasted text.
        await expect
            .poll(() => fs.readFile(replacementPath, "utf8").catch(() => null))
            .toBe("new clipboard text");
        await expect(dialog).not.toBeVisible();
    });

    test("requires a different filename when a pasted image would replace a file", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir2");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const existingName = `existing-pasted-image-${Date.now()}.png`;
        const replacementName = `renamed-colliding-image-${Date.now()}.png`;
        const existingPath = path.join(directoryPath, existingName);
        const replacementPath = path.join(directoryPath, replacementName);
        await fs.writeFile(existingPath, "original image");
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await page.evaluate((fileName) => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(
                new File(["new image bytes"], fileName, { type: "image/png" }),
            );
            window.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    clipboardData,
                }),
            );
        }, existingName);

        const dialog = page.getByRole("dialog", {
            name: "Save pasted image",
        });
        const fileNameInput = dialog.getByRole("textbox", { name: "Filename" });
        await dialog.getByRole("button", { name: "Upload image" }).click();

        // Images use the same inline collision path and must remain available for renaming.
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("alert")).toContainText(
            "already exists. Choose a different filename.",
        );
        // Rejecting the upload must not alter the existing image bytes.
        await expect
            .poll(() => fs.readFile(existingPath, "utf8"))
            .toBe("original image");

        await fileNameInput.fill(replacementName);
        await dialog.getByRole("button", { name: "Upload image" }).click();

        // The pending image blob must survive the conflict and upload under the new name.
        await expect
            .poll(() => fs.readFile(replacementPath, "utf8").catch(() => null))
            .toBe("new image bytes");
        await expect(dialog).not.toBeVisible();
    });
});
