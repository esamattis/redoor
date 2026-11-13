// Serial: turns on the shared vim mode and wrap preferences, which change every editor.
import { test, expect } from "../fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import { defaultUserState, type OpenFile } from "#ui/user-state";
import {
    deleteAllTerminalSessions,
    expectTerminalBlurred,
    expectTerminalFocused,
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    API_BASE_URL,
    WEB_BASE_URL,
    type TestContext,
} from "../helpers";

test.describe.serial("File editor options", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit-vim");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("content1");

        const optionsButton = page.getByRole("button", {
            name: "Editor actions",
        });

        await expect(optionsButton).toHaveAttribute("aria-expanded", "false");
        await optionsButton.click();
        const options = page.getByRole("dialog", { name: "Editor actions" });
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
            .getByRole("button", { name: "Close editor actions" })
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
        await page.getByRole("button", { name: "Editor actions" }).click();
        await expect(
            page.getByRole("button", { name: "Vim mode" }),
        ).toHaveAttribute("aria-pressed", "true");
        await page
            .getByRole("button", { name: "Close editor actions" })
            .click();
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toHaveText("content1");
    });

    test("should persist and replace Vim mappings from preferences", async ({
        page,
    }) => {
        const config = `" Custom keys
inoremap jj <esc>
map ö ^
map ä $
vmap ä $
map x l`;

        const filePath = path.join(ctx.testDirPath, "vim-config.txt");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        await fs.writeFile(filePath, "  one two");
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await page.goto(`${WEB_BASE_URL}/settings/preferences`);

        const configuration = page.getByRole("textbox", {
            name: "Vim configuration",
        });

        await configuration.fill(config);
        // The configuration is saved only when focus leaves the textarea.
        await configuration.blur();
        // Preferences save automatically, so the toast is the only sign the write landed.
        await expect(
            page.getByRole("status").filter({ hasText: "Settings saved" }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Vim mode", exact: true })
            .click();
        // Readback ensures navigation cannot abort a pending settings write.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ vimConfig: config, vimMode: true });
        await page.reload();
        // Reload proves the source belongs to the user's persisted preferences.
        await expect(configuration).toHaveValue(config);
        await configuration.focus();
        await configuration.press("ControlOrMeta+Home");
        await configuration.pressSequentially(`" Top\n`);
        const editedConfig = `" Top\n${config}`;
        // Typing before existing text must keep the caret there, not jump to the end.
        await expect(configuration).toHaveValue(editedConfig);
        await configuration.blur();
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ vimConfig: editedConfig });
        await page.goto(fileUrl);
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("  one two");
        await editor.focus();
        await page.keyboard.type("x");
        // Custom x moves rather than deleting the file's first character.
        await expect(editor).toHaveText("  one two");
        await page.keyboard.press("i");
        await page.keyboard.type("jj");
        // A multi-key insert mapping must exit without leaving either j behind.
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await expect(editor).toHaveText("  one two");
        // Playwright has no Unicode keyboard layout; send the localized key event.
        await editor.dispatchEvent("keydown", { key: "ö", code: "Semicolon" });
        await page.keyboard.type("v");
        await editor.dispatchEvent("keydown", { key: "ä", code: "Quote" });
        // Unicode mappings work in both normal and visual contexts.
        await expect(
            page.getByLabel("Editor selected text", { exact: true }),
        ).toHaveText("one two");
        await page.keyboard.press("Escape");
        await page.goto(`${WEB_BASE_URL}/settings/preferences`);
        await configuration.fill("");
        await configuration.blur();
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ vimConfig: "" });
        await page.goto(fileUrl);
        await expect(editor).toHaveText("  one two");
        await editor.focus();
        await page.keyboard.type("0x");
        // Removing the source restores Vim's built-in delete key for an existing buffer.
        await expect(editor).toHaveText(" one two");
    });

    test("should briefly highlight a Vim yank in the file editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "vim-yank.txt");
        await fs.writeFile(
            filePath,
            `one two
three four

five`,
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Editor actions" }).click();
        await page.getByRole("button", { name: "Vim mode" }).click();
        await page
            .getByRole("button", { name: "Close editor actions" })
            .click();
        const editor = page.getByLabel("File editor", { exact: true });

        const lineHighlights = editor.locator(
            '[data-vim-yank-highlight="line"]',
        );

        await editor.focus();

        await page.keyboard.type("yy");
        // The flash shows the yanked line, proving the file editor wires in the yank
        // highlight. Counted, characterwise and Visual ranges are covered by
        // vim-yank-highlight.test.ts.
        await expect(lineHighlights).toHaveCount(1);
        await expect(lineHighlights).toHaveText("one two");
        // Polling for removal verifies the timer without making the test sleep.
        await expect(lineHighlights).toHaveCount(0);
    });

    test("should persist line wrapping and apply it to the editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "wrap-lines.txt");
        await fs.writeFile(filePath, "x".repeat(500));
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        // Long lines remain horizontally scrollable until the preference is enabled.
        await expect(editor).toHaveAttribute("data-wrap-lines", "false");
        await page.getByRole("button", { name: "Editor actions" }).click();
        const options = page.getByRole("dialog", { name: "Editor actions" });
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
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toHaveAttribute("data-wrap-lines", "true");
        await page.getByRole("button", { name: "Editor actions" }).click();
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Editor actions" }).click();
        await page.getByRole("button", { name: "Vim mode" }).click();
        await page
            .getByRole("button", { name: "Close editor actions" })
            .click();
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(page.getByText("--NORMAL--")).toBeVisible();
        await editor.focus();
        await expect(editor).toBeFocused();

        await page.keyboard.press("Alt+t");

        const terminalInput = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });

        // Vim must not treat Alt+t as till, or the buffer and mode would change.
        await expectTerminalFocused(terminalInput);
        await expect(editor).toHaveText("content1");
        await expect(page.getByText("--NORMAL--")).toBeVisible();

        await page.keyboard.press("Alt+e");
        // Returning from the shell must restore the Vim editor, not a browser control.
        await expect(editor).toBeFocused();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        // The committed connected state must not reclaim focus after Alt+e.
        await expect(editor).toBeFocused();
        await expectTerminalBlurred(terminalInput);
        await expect(page.getByText("--NORMAL--")).toBeVisible();
    });

    test("should keep editor focus after :w", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "vim-write.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("button", { name: "Editor actions" }).click();
        await page.getByRole("button", { name: "Vim mode" }).click();
        await page
            .getByRole("button", { name: "Close editor actions" })
            .click();
        const editor = page.getByLabel("File editor", { exact: true });
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

    test("should save every edited open file with :wa", async ({ page }) => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const files: OpenFile[] = ["vim-wall-a.txt", "vim-wall-b.txt"].map(
            (name) => ({
                agentId: ctx.agentId,
                path: path.join(ctx.testDirPath, name),
                name,
                agentName: ctx.agentName,
            }),
        );

        const [first, second] = files;

        if (first === undefined || second === undefined) {
            throw new Error("Expected two open files");
        }

        await fs.writeFile(first.path, "alpha");
        await fs.writeFile(second.path, "beta");
        await api.updateUserState({
            state: { ...defaultUserState, vimMode: true, openFiles: files },
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(first.path)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("alpha");
        await editor.focus();
        await page.keyboard.press("A");
        await page.keyboard.type("1");
        await page.keyboard.press("Escape");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        // Switching in the app keeps the first file's unsaved buffer in this page.
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" })
            .getByRole("link", { name: second.name, exact: true })
            .click();
        await expect(editor).toHaveText("beta");
        await editor.focus();
        await page.keyboard.press("A");
        await page.keyboard.type("2");
        await page.keyboard.press("Escape");

        await page.keyboard.type(":wa");
        await page.keyboard.press("Enter");
        // The shown file saves through its own editor, like :w.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // The file that is not shown is saved too, with its unsaved text.
        await expect(page.getByText("Saved 1 other file")).toBeVisible();
        await expect.poll(() => fs.readFile(first.path, "utf8")).toBe("alpha1");
        await expect.poll(() => fs.readFile(second.path, "utf8")).toBe("beta2");
    });
});
