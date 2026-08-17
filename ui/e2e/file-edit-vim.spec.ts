import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    API_BASE_URL,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File editor Vim mode", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit-vim");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later editor tests assume default keybindings rather than Vim.
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                vimMode: false,
            },
        });
    });

    test("should persist Vim mode and apply Vim keybindings", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "vim-mode.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        await expect(editor).toHaveText("content1");
        const vimToggle = page.getByRole("button", { name: "Vim mode" });
        // Vim stays off by default so existing editor shortcuts keep working.
        await expect(vimToggle).toHaveAttribute("aria-pressed", "false");

        await vimToggle.click();
        await expect(vimToggle).toHaveAttribute("aria-pressed", "true");

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves the toggle lives in user state rather than local storage.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ vimMode: true });

        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await editor.focus();
        await expect(editor).toBeFocused();
        await page.keyboard.press("v");
        await expect(page.getByText("--VISUAL--")).toBeVisible();
        await page.keyboard.press("Escape");
        // Visual-mode Escape must return to normal mode without blurring the editor.
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await expect(editor).toBeFocused();

        await page.reload();
        // Reload must restore the persisted keymap from the server.
        await expect(
            page.getByRole("button", { name: "Vim mode" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await expect(page.getByLabel("File editor")).toHaveText("content1");
    });

    test("should open the terminal with Alt+t from Vim normal mode", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "vim-mode.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Vim mode" }).click();
        const editor = page.getByLabel("File editor");
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await editor.focus();
        await expect(editor).toBeFocused();

        await page.keyboard.press("Alt+t");
        const terminalInput = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });
        // Vim must not treat Alt+t as till, or the buffer and mode would change.
        await expect(terminalInput).toBeFocused();
        await expect(editor).toHaveText("content1");
        await expect(page.getByText("--NORMAL--")).toBeVisible();

        await page.keyboard.press("Alt+e");
        // Returning from the shell must restore the Vim editor, not a browser control.
        await expect(editor).toBeFocused();
        await expect(page.getByText("--NORMAL--")).toBeVisible();
    });

    test("should keep editor focus after :w", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "vim-write.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Vim mode" }).click();
        const editor = page.getByLabel("File editor");
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await editor.focus();
        await page.keyboard.press("i");
        await page.keyboard.type("x");
        await page.keyboard.press("Escape");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        await page.keyboard.type(":w");
        await page.keyboard.press("Enter");
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // :w must not bounce focus to chrome, or the next Vim motion leaves the buffer.
        await expect(editor).toBeFocused();
        await expect(page.getByText("--NORMAL--")).toBeVisible();
    });
});
