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

test.describe.serial("File editor search and replace", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit-search");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should toggle search from the editor actions", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "title-open.txt");
        await fs.writeFile(filePath, "alpha foo beta foo gamma");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        // Search stays out of the editor until its dedicated action is used.
        await expect(page.getByLabel("Find in file")).toBeHidden();
        const toggle = page.getByRole("button", {
            name: "Toggle search and replace",
        });
        await toggle.click();
        await expect(page.getByLabel("Find in file")).toBeVisible();
        await expect(
            page.getByRole("region", { name: "Search & Replace" }),
        ).toBeVisible();
        await toggle.click();
        await expect(page.getByLabel("Find in file")).toBeHidden();
    });

    test("should open search from the shortcut and keep typing in the field", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "shortcut-open.txt");
        await fs.writeFile(filePath, "alpha foo beta foo gamma");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+f");
        const findInput = page.getByLabel("Find in file");
        // Cmd+F must focus the app field instead of CodeMirror's default panel.
        await expect(findInput).toBeFocused();
        await expect(
            page.getByRole("button", { name: "next", exact: true }),
        ).toHaveCount(0);

        await findInput.fill("");
        await findInput.pressSequentially("foo");
        // Character keys must stay in the search field rather than triggering other shortcuts.
        await expect(findInput).toHaveValue("foo");
        await expect(page.getByLabel("Search match count")).toHaveText(
            "2 matches",
        );
    });

    test("should find replace and replace all matches", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "replace.txt");
        await fs.writeFile(filePath, "alpha foo beta foo gamma");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+f");
        const findInput = page.getByLabel("Find in file");
        await findInput.fill("foo");
        await page.getByRole("button", { name: "Find next" }).click();
        // Next should land on the first match so replace has a current target.
        await expect(page.getByLabel("Search match count")).toHaveText(
            "1 of 2",
        );

        await page.getByLabel("Replace with").fill("baz");
        await page
            .getByRole("button", { name: "Replace", exact: true })
            .click();
        await expect(page.getByLabel("File editor")).toHaveText(
            "alpha baz beta foo gamma",
        );

        await page.getByRole("button", { name: "Replace all" }).click();
        // Replace all must rewrite every remaining match, not only the selection.
        await expect(page.getByLabel("File editor")).toHaveText(
            "alpha baz beta baz gamma",
        );
        await expect(page.getByLabel("Search match count")).toHaveText(
            "No matches",
        );
    });

    test("should expose the search shortcut on the editor action", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "tooltip.txt");
        await fs.writeFile(filePath, "content");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        await page
            .getByRole("button", { name: "Toggle search and replace" })
            .hover();
        // The action tooltip advertises the keyboard path to the same panel.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Search and replace in the file (Ctrl+F)",
        );
    });
});
