import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    confirmUpload,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
    uploadDialog,
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
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`;
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

        const dialog = uploadDialog(page);

        const fileNameInput = dialog.getByRole("textbox", {
            name: `Name for ${suggestedName}`,
        });

        // The image remains pending locally until the upload dialog is confirmed.
        await expect(dialog).toBeVisible();
        await expect(fs.access(suggestedPath)).rejects.toThrow();
        // The clipboard-provided extension remains available when choosing a clearer name.
        await expect(fileNameInput).toHaveValue(suggestedName);
        await fileNameInput.fill(savedName);
        await confirmUpload(page, 1);

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
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`;
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

        const dialog = uploadDialog(page);

        const fileNameInput = dialog.getByRole("textbox", {
            name: `Name for ${existingName}`,
        });

        // The made-up name is taken, so the dialog starts from a free one instead.
        await expect(fileNameInput).toHaveValue("pasted-text_2.txt");
        // Pasted text was never named by the user, so replacing the file is not offered.
        await expect(
            dialog.getByRole("combobox", { name: `If ${existingName} exists` }),
        ).toHaveCount(0);

        await fileNameInput.fill(existingName);

        // Typing the taken name back must block the upload instead of replacing the file.
        await expect(dialog.getByRole("alert")).toHaveText(
            `${existingName} already exists in this directory`,
        );
        await expect(
            dialog.getByRole("button", { name: "Upload 1 item" }),
        ).toBeDisabled();

        await fileNameInput.fill(replacementName);
        await confirmUpload(page, 1);

        // Choosing a non-conflicting name must save the originally pasted text.
        await expect
            .poll(() => fs.readFile(replacementPath, "utf8").catch(() => null))
            .toBe("new clipboard text");
        // The existing file is left untouched.
        expect(await fs.readFile(existingPath, "utf8")).toBe("original text");
    });

    test("requires a different filename when a pasted image would replace a file", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir2");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`;
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

        const fileNameInput = uploadDialog(page).getByRole("textbox", {
            name: `Name for ${existingName}`,
        });

        // Clipboard images are named by the browser, so a taken name becomes a free one.
        await expect(fileNameInput).toHaveValue(
            existingName.replace(/\.png$/, "_2.png"),
        );

        await fileNameInput.fill(replacementName);
        await confirmUpload(page, 1);

        // The pending image blob must survive the conflict and upload under the new name.
        await expect
            .poll(() => fs.readFile(replacementPath, "utf8").catch(() => null))
            .toBe("new image bytes");
        // The existing image bytes are left untouched.
        expect(await fs.readFile(existingPath, "utf8")).toBe("original image");
    });

    test("should preselect the pasted text filename before its extension", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "subdir2", "deep"))}`;
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

        const fileNameInput = uploadDialog(page).getByRole("textbox", {
            name: "Name for pasted-text.txt",
        });

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
});
