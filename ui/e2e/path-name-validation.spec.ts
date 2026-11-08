import { test, expect } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Path name validation", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("path-names");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("applies the same name rules to every dialog that names a path", async ({
        page,
    }) => {
        const nestedRoot = `nested-${Date.now()}`;
        const nestedPath = path.join(ctx.testDirPath, nestedRoot, "child");
        const renamedFile = path.join(ctx.testDirPath, "file1.txt");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New file", exact: true })
            .click();

        const fileDialog = page.getByRole("dialog", { name: "Create file" });
        const fileName = fileDialog.getByRole("textbox", { name: "File name" });
        await fileName.fill("..");
        await fileDialog
            .getByRole("button", { name: "Create file", exact: true })
            .click();
        // The parent directory name would resolve to an existing directory, not a new file.
        await expect(fileDialog.getByRole("alert")).toHaveText(
            'File name cannot contain "." or ".." components',
        );
        await fileName.fill("inner/name.txt");
        await fileDialog
            .getByRole("button", { name: "Create file", exact: true })
            .click();
        // A file name is one entry in this directory, so a separator is refused.
        await expect(fileDialog.getByRole("alert")).toHaveText(
            "File name must be a single path component",
        );
        await fileDialog.getByRole("button", { name: "Cancel" }).click();

        await page.getByRole("button", { name: "New", exact: true }).click();
        await page
            .getByRole("button", { name: "New directory", exact: true })
            .click();

        const directoryDialog = page.getByRole("dialog", {
            name: "Create directory",
        });

        const directoryName = directoryDialog.getByRole("textbox", {
            name: "Directory name",
        });

        await directoryName.fill("../escaped");
        await directoryDialog
            .getByRole("button", { name: "Create directory", exact: true })
            .click();
        // Directory creation accepts nesting, but a parent reference would leave this directory.
        await expect(directoryDialog.getByRole("alert")).toHaveText(
            'Directory name cannot contain "." or ".." components',
        );
        await directoryName.fill(`${nestedRoot}/child`);
        await directoryDialog
            .getByRole("button", { name: "Create directory", exact: true })
            .click();

        // The nested directory becomes the active location, as the agent created every level.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(nestedPath)}`,
        );
        // A directory on disk proves the nested name was accepted rather than rejected or flattened.
        expect((await fs.stat(nestedPath)).isDirectory()).toBe(true);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("button", {
                name: "Actions for file file1.txt",
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: "Actions for file file1.txt" })
            .getByRole("button", { name: "Rename", exact: true })
            .click();

        const renameDialog = page.getByRole("dialog", { name: "Rename file" });

        await renameDialog
            .getByRole("textbox", { name: "Rename file" })
            .fill("..");
        await renameDialog
            .getByRole("button", { name: "Rename", exact: true })
            .click();
        // Rename shares the rule, so the same name is refused there too.
        await expect(renameDialog.getByRole("alert")).toHaveText(
            'File name cannot contain "." or ".." components',
        );
        // Nothing was renamed, so the original file still exists on disk.
        expect((await fs.stat(renamedFile)).isFile()).toBe(true);
    });
});
