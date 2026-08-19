import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Missing path creation", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("missing-path");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should create files and directories from missing paths", async ({
        page,
    }) => {
        const missingName = `created-from-missing-${Date.now()}`;
        const missingPath = `${ctx.testDirPath}/${missingName}`;
        const missingUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(missingPath)}`;
        const missingFileName = "new-file.txt";
        const missingFilePath = `${missingPath}/${missingFileName}`;
        const missingFileUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(missingFilePath)}`;
        await page.goto(missingUrl);

        // A direct missing-path navigation remains at the requested destination.
        await expect(page).toHaveURL(missingUrl);
        // Browser chrome stays mounted so parent and breadcrumb navigation remain available.
        await expect(
            page.getByRole("link", { name: "Agent home" }),
        ).toBeVisible();
        await expect(
            page.getByRole("navigation", { name: "Breadcrumbs" }),
        ).toBeVisible();
        // View tabs only describe existing filesystem entries and must not appear here.
        await expect(page.getByLabel("Directory view")).not.toBeVisible();
        // The creation card clearly explains why creation is being offered.
        await expect(
            page.getByRole("heading", {
                name: "File or directory does not exist",
            }),
        ).toBeVisible();
        // The missing final path segment is ready to use as the new entry name.
        const fileNameInput = page.getByRole("textbox", { name: "File name" });
        await expect(fileNameInput).toHaveValue(missingName);
        // Creation gets keyboard focus instead of unexpectedly opening the breadcrumb editor.
        await expect(fileNameInput).toBeFocused();
        await expect(
            page.getByRole("textbox", { name: "File path" }),
        ).not.toBeVisible();

        await page
            .getByRole("button", { name: "Directory", exact: true })
            .click();

        // Creating the prefilled directory reloads the unchanged URL as a real directory.
        await expect(page).toHaveURL(missingUrl);
        await expect(
            page.getByRole("searchbox", { name: "Filter files" }),
        ).toBeVisible();
        // Disk state confirms the directory action reached the remote filesystem.
        expect((await fs.stat(missingPath)).isDirectory()).toBe(true);

        await page.goto(missingFileUrl);
        // The child filename is prefilled independently after navigation to another missing path.
        await expect(
            page.getByRole("textbox", { name: "File name" }),
        ).toHaveValue(missingFileName);
        await page.getByRole("button", { name: "File", exact: true }).click();
        // Same-url invalidate is not a persistence barrier; the create heading must leave first.
        await expect(
            page.getByRole("heading", {
                name: "File or directory does not exist",
            }),
        ).toHaveCount(0);
        // An empty file proves the File action used the upload API at the requested destination.
        await expect(fs.readFile(missingFilePath, "utf8")).resolves.toBe("");
    });

    test("should hide the create form after breadcrumb navigation to an existing parent", async ({
        page,
    }) => {
        const missingParent = `missing-parent-${Date.now()}`;
        const missingChild = "missing-child";
        const missingPath = `${ctx.testDirPath}/${missingParent}/${missingChild}`;
        const missingUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(missingPath)}`;
        const existingParentUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(missingUrl);

        // The missing nested path must show the create form before breadcrumb navigation.
        await expect(
            page.getByRole("heading", {
                name: "File or directory does not exist",
            }),
        ).toBeVisible();
        await expect(
            page.getByRole("textbox", { name: "File name" }),
        ).toHaveValue(missingChild);

        const breadcrumbs = page.getByRole("navigation", {
            name: "Breadcrumbs",
        });
        await breadcrumbs.getByText(missingParent, { exact: true }).click();
        await breadcrumbs.getByText(ctx.testDirName, { exact: true }).click();

        // Breadcrumb navigation to an existing ancestor must leave the missing-path URL.
        await expect(page).toHaveURL(existingParentUrl);
        // An existing directory must not keep the create form from the previous missing path.
        await expect(
            page.getByRole("heading", {
                name: "File or directory does not exist",
            }),
        ).not.toBeVisible();
        await expect(
            page.getByRole("textbox", { name: "File name" }),
        ).not.toBeVisible();
        // Parent directory contents confirm the listing replaced the create form.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("searchbox", { name: "Filter files" }),
        ).toBeVisible();
    });
});
