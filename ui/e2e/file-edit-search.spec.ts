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
        // Opening search must keep replacement fields and destructive actions out of the default panel.
        await expect(page.getByLabel("Replace with")).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Replace", exact: true }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Replace all", exact: true }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Match case", exact: true }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", {
                name: "Regular expression",
                exact: true,
            }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Match whole word", exact: true }),
        ).toBeHidden();
        const advanced = page.getByRole("button", {
            name: "Advanced",
            exact: true,
        });
        await advanced.click();
        // Advanced mode reveals both replacement tools and optional search constraints.
        await expect(advanced).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByLabel("Replace with")).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Match case", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", {
                name: "Regular expression",
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Match whole word", exact: true }),
        ).toBeVisible();
        await advanced.click();
        // Returning to search mode hides every replacement control again.
        await expect(page.getByLabel("Replace with")).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Replace", exact: true }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Replace all", exact: true }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Match case", exact: true }),
        ).toBeHidden();
        await advanced.click();
        await toggle.click();
        await expect(page.getByLabel("Find in file")).toBeHidden();
        await toggle.click();
        // Reopening starts in compact search mode even if replace was enabled before closing.
        await expect(advanced).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByLabel("Replace with")).toBeHidden();
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

    test("should use the selected text when Find next has an empty query", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "selection-search.txt");
        await fs.writeFile(filePath, "foo beta foo gamma");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor");
        await expect(editor).toBeVisible();
        await page
            .getByRole("button", { name: "Toggle search and replace" })
            .click();
        const findInput = page.getByLabel("Find in file");
        await findInput.fill("");
        await editor.click();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        const findNext = page.getByRole("button", {
            name: "Find next",
            exact: true,
        });
        // Selecting text makes Find next usable even though the query field is empty.
        await expect(findNext).toBeEnabled();
        await findNext.click();
        // The selection becomes the visible query and navigation advances beyond the selected match.
        await expect(findInput).toHaveValue("foo");
        await expect(page.getByLabel("Search match count")).toHaveText(
            "2 of 2",
        );
        await findNext.click();
        // Subsequent navigation reuses the adopted query and still wraps through matches.
        await expect(page.getByLabel("Search match count")).toHaveText(
            "1 of 2",
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

        await page
            .getByRole("button", { name: "Advanced", exact: true })
            .click();
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
        const searchToggle = page.getByRole("button", {
            name: "Toggle search and replace",
        });
        await searchToggle.hover();
        // The action tooltip advertises the keyboard path to the same panel.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Search and replace in the file (Ctrl+F)",
        );
        await searchToggle.click();
        await expect(
            page.getByRole("region", { name: "Search & Replace" }),
        ).toBeVisible();
        await searchToggle.hover();
        // Once the panel is open, the same control must name closing it.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Close search and replace (Ctrl+F)",
        );
        await page
            .getByRole("button", { name: "Advanced", exact: true })
            .click();
        const matchCase = page.getByRole("button", { name: "Match case" });
        await matchCase.hover();
        // Unchecked options advertise enabling the constraint.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Match the exact letter case",
        );
        await matchCase.click();
        await matchCase.hover();
        // After enabling, the tooltip names the click that turns the option off.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Ignore letter case",
        );
    });
});
