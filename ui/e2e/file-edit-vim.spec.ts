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

test.describe.serial("File editor options", () => {
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
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
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
        const optionsButton = page.getByRole("button", {
            name: "Editor options",
        });
        await expect(optionsButton).toHaveAttribute("aria-expanded", "false");
        await optionsButton.click();
        const options = page.getByRole("dialog", { name: "Editor options" });
        const vimToggle = options.getByRole("button", { name: "Vim mode" });
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

        await options
            .getByRole("button", { name: "Close editor options" })
            .click();
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
        await page.getByRole("button", { name: "Editor options" }).click();
        await expect(
            page.getByRole("button", { name: "Vim mode" }),
        ).toHaveAttribute("aria-pressed", "true");
        await page
            .getByRole("button", { name: "Close editor options" })
            .click();
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await expect(page.getByLabel("File editor")).toHaveText("content1");
    });

    test("should persist line wrapping and apply it to the editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "wrap-lines.txt");
        await fs.writeFile(filePath, "x".repeat(500));
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        // Long lines remain horizontally scrollable until the preference is enabled.
        await expect(editor).toHaveAttribute("data-wrap-lines", "false");
        await page.getByRole("button", { name: "Editor options" }).click();
        const options = page.getByRole("dialog", { name: "Editor options" });
        const wrapToggle = options.getByRole("button", { name: "Wrap lines" });
        await expect(wrapToggle).toHaveAttribute("aria-pressed", "false");

        await wrapToggle.click();
        // The CodeMirror extension must update immediately rather than waiting for reload.
        await expect(wrapToggle).toHaveAttribute("aria-pressed", "true");
        await expect(editor).toHaveAttribute("data-wrap-lines", "true");

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves wrapping follows the other persisted editor options.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ wrapEditorLines: true });

        await page.reload();
        // Reload must restore both the control state and the wrapping extension.
        await expect(page.getByLabel("File editor")).toHaveAttribute(
            "data-wrap-lines",
            "true",
        );
        await page.getByRole("button", { name: "Editor options" }).click();
        await expect(
            page.getByRole("button", { name: "Wrap lines" }),
        ).toHaveAttribute("aria-pressed", "true");
    });

    test("should open the terminal with Alt+t from Vim normal mode", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "vim-mode.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Editor options" }).click();
        await page.getByRole("button", { name: "Vim mode" }).click();
        await page
            .getByRole("button", { name: "Close editor options" })
            .click();
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

        await page.getByRole("button", { name: "Editor options" }).click();
        await page.getByRole("button", { name: "Vim mode" }).click();
        await page
            .getByRole("button", { name: "Close editor options" })
            .click();
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
