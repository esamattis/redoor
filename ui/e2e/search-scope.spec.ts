import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

/** Shared by every fixture name, so one path search finds all of them. */
const TOKEN = "scopetoken";

test.describe("Search scope", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        if (testDirPath === "") {
            return;
        }

        await teardownTestDir(testDirPath);
        testDirPath = "";
    });

    test("changes the searched folder from breadcrumbs, results and a typed path", async ({
        page,
    }) => {
        const ctx = await setupTestDir("search-scope");
        testDirPath = ctx.testDirPath;
        const nestedPath = path.join(ctx.testDirPath, "nested");
        const folderPath = path.join(nestedPath, `${TOKEN}-folder`);
        const outsidePath = path.join(ctx.testDirPath, `outside-${TOKEN}.txt`);
        const siblingPath = path.join(nestedPath, `sibling-${TOKEN}.txt`);
        const insidePath = path.join(folderPath, `inside-${TOKEN}.txt`);
        await fs.mkdir(folderPath, { recursive: true });
        await fs.writeFile(outsidePath, "outside\n");
        await fs.writeFile(siblingPath, "sibling\n");
        await fs.writeFile(insidePath, "inside\n");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(nestedPath)}?q=${TOKEN}`,
        );

        const dialog = page.getByRole("dialog", { name: "Search device" });
        const scope = dialog.getByRole("navigation", { name: "Search folder" });

        const outsideResult = dialog.getByRole("link", {
            name: `Open path ${outsidePath}`,
        });

        const siblingResult = dialog.getByRole("link", {
            name: `Open path ${siblingPath}`,
        });

        // The scope starts at the browsed folder, so the file above it is not found.
        await expect(dialog).toContainText(`Search in ${nestedPath}`);
        await expect(siblingResult).toBeVisible();
        await expect(outsideResult).toHaveCount(0);

        await scope
            .getByRole("link", { name: `Search in ${ctx.testDirPath}` })
            .click();
        // An ancestor breadcrumb widens the search and keeps it shareable in the URL.
        await expect(page).toHaveURL(/[?&]dir=/);
        await expect(dialog).toContainText(`Search in ${ctx.testDirPath}`);
        await expect(outsideResult).toBeVisible();

        const directoriesOnly = dialog.getByRole("button", {
            name: "Search directories only",
        });

        await directoriesOnly.click();
        // Only directories match, so the matching files drop out of the path results.
        await expect(page).toHaveURL(/[?&]dirs=true/);
        await expect(directoriesOnly).toHaveAttribute("aria-pressed", "true");
        await expect(
            dialog.getByRole("link", { name: `Open path ${folderPath}` }),
        ).toBeVisible();
        await expect(outsideResult).toHaveCount(0);

        await dialog
            .getByRole("button", { name: `Search in ${folderPath}` })
            .click();

        const contentInput = dialog.getByRole("searchbox", {
            name: "Search file contents",
        });

        // A picked folder becomes the scope of a content search inside it.
        await expect(page).toHaveURL(/[?&]mode=content/);
        await expect(dialog).toContainText(`Search in ${folderPath}`);
        // The carried-over query is focused and selected, so typing replaces it.
        await expect(contentInput).toBeFocused();
        await expect(contentInput).toHaveValue(TOKEN);
        expect(
            await contentInput.evaluate((input: HTMLInputElement) => [
                input.selectionStart,
                input.selectionEnd,
            ]),
        ).toEqual([0, TOKEN.length]);
        await page.keyboard.type("inside");
        await expect(contentInput).toHaveValue("inside");
        await expect(
            dialog.getByRole("link", { name: `Open ${insidePath} at line 1` }),
        ).toBeVisible();

        await page.goBack();

        const pathInput = dialog.getByRole("searchbox", {
            name: "Search file paths",
        });

        // Picking the folder added a history entry, so Back returns to the folder list.
        await expect(pathInput).toBeVisible();
        await expect(dialog).toContainText(`Search in ${ctx.testDirPath}`);
        // The typed query is shared by both modes, like switching modes by hand.
        await expect(pathInput).toHaveValue("inside");
        await pathInput.fill(TOKEN);
        await directoriesOnly.click();
        await expect(page).not.toHaveURL(/[?&]dirs=/);
        await expect(outsideResult).toBeVisible();

        await dialog
            .getByRole("button", { name: "Edit search folder" })
            .click();

        const folderInput = dialog.getByRole("textbox", {
            name: "Search folder path",
        });

        await folderInput.press("Escape");
        // Escape only leaves the folder editor; the modal search stays open.
        await expect(dialog).toBeVisible();
        await expect(folderInput).toHaveCount(0);

        await dialog
            .getByRole("button", { name: "Edit search folder" })
            .click();
        await folderInput.fill(nestedPath);
        await folderInput.press("Enter");
        // A typed folder becomes the scope.
        await expect(dialog).toContainText(`Search in ${nestedPath}`);
        await expect(siblingResult).toBeVisible();
        await expect(outsideResult).toHaveCount(0);

        await scope
            .getByRole("link", { name: `Search in ${ctx.testDirPath}` })
            .click();
        await expect(outsideResult).toBeVisible();
        await dialog.getByRole("button", { name: "Close search" }).click();
        await page.getByRole("button", { name: "Search device" }).click();
        // A chosen folder belongs to one search, so reopening starts from the browsed folder.
        await expect(page).not.toHaveURL(/[?&]dir=/);
        await expect(dialog).toContainText(`Search in ${nestedPath}`);
    });
});
