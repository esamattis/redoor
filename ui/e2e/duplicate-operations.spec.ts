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

test.describe.serial("Duplicate Operations", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("duplicate");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should duplicate a file inline without leaving the directory", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const originalName = `inline.${Date.now()}.archive.txt`;
        const duplicatedName = `inline-duplicated-${Date.now()}.txt`;
        const originalPath = path.join(directoryPath, originalName);
        const duplicatedPath = path.join(directoryPath, duplicatedName);
        await fs.writeFile(originalPath, "inline duplicate content");
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
            .getByRole("button", { name: "Duplicate", exact: true })
            .click();
        const dialog = page.getByRole("dialog", { name: "Duplicate file" });
        const duplicateInput = dialog.getByRole("textbox", {
            name: "Duplicate file",
        });
        // The row action must open a focused copy workflow seeded with the current leaf name.
        await expect(dialog).toBeVisible();
        await expect(duplicateInput).toHaveValue(originalName);
        await expect(duplicateInput).toBeFocused();
        // Multi-dot names select only the basename so typing can keep the existing extension.
        await expect
            .poll(() =>
                duplicateInput.evaluate((input) => ({
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

        await duplicateInput.fill(duplicatedName);
        await dialog
            .getByRole("button", { name: "Duplicate", exact: true })
            .click();

        // A successful inline duplicate closes its workflow instead of leaving a stale modal open.
        await expect(dialog).toBeHidden();
        // Inline copying keeps the current directory address stable.
        await expect(page).toHaveURL(directoryUrl);
        // Refreshing in place adds the copy without removing the original link.
        await expect(
            page.getByRole("link", { name: duplicatedName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: originalName, exact: true }),
        ).toBeVisible();
        // Disk contents prove the source stayed put while the copy received the same bytes.
        await expect(fs.readFile(duplicatedPath, "utf8")).resolves.toBe(
            "inline duplicate content",
        );
        await expect(fs.readFile(originalPath, "utf8")).resolves.toBe(
            "inline duplicate content",
        );
    });

    test("should duplicate a directory inline without opening it", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "subdir3");
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(directoryPath)}`;
        const originalName = `inline-directory-${Date.now()}`;
        const duplicatedName = `inline-duplicated-directory-${Date.now()}`;
        const originalPath = path.join(directoryPath, originalName);
        const duplicatedPath = path.join(directoryPath, duplicatedName);
        await fs.mkdir(originalPath);
        await fs.writeFile(
            path.join(originalPath, "nested.txt"),
            "nested duplicate content",
        );
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
            .getByRole("button", { name: "Duplicate", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Duplicate directory",
        });
        const duplicateInput = dialog.getByRole("textbox", {
            name: "Duplicate directory",
        });
        // Extensionless directory names are selected in full for immediate replacement.
        await expect(duplicateInput).toHaveValue(originalName);
        await expect
            .poll(() =>
                duplicateInput.evaluate((input) => ({
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
        await duplicateInput.fill(duplicatedName);
        await dialog
            .getByRole("button", { name: "Duplicate", exact: true })
            .click();

        // Inline directory duplicates close the modal and retain the parent listing URL.
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(directoryUrl);
        // The new directory link appearing proves route data refreshed in place.
        await expect(
            page.getByRole("link", { name: duplicatedName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: originalName, exact: true }),
        ).toBeVisible();
        await expect(fs.stat(duplicatedPath)).resolves.toMatchObject({});
        await expect(fs.stat(originalPath)).resolves.toMatchObject({});
        // Nested contents prove the copy used the directory transfer, not an empty mkdir.
        await expect(
            fs.readFile(path.join(duplicatedPath, "nested.txt"), "utf8"),
        ).resolves.toBe("nested duplicate content");
    });
});
