import { test, expect, type Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    simulateTabRefocus,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

/** CodeMirror is contenteditable, so assertions use text content instead of input value. */
async function expectEditorText(editor: Locator, text: string) {
    await expect(editor).toHaveText(text);
}

/** Replaces the whole buffer without depending on CodeMirror class names. */
async function fillEditor(editor: Locator, text: string) {
    await editor.click();
    await editor.fill(text);
}

test.describe.serial("File Edit View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should link View for plain text files", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        // View links to the text representation after UTF-8 sniffing marks the file editable.
        await expect(
            page.getByRole("link", { name: "View", exact: true }),
        ).toBeVisible();
    });

    test("should open edit view via query param and load content", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "View", exact: true }).click();

        await expect(page).toHaveURL(/\?view=edit$/);
        // The editor should contain the on-disk contents so edits start from truth.
        await expectEditorText(page.getByLabel("File editor"), "content1");
        // The switch identifies View as the active file representation while editing.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "View", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Restore file contents" }),
        ).toBeDisabled();
    });

    test("should download editable file contents once", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        const rawPath = `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/${encodeFilesystemPath(filePath)}`;
        const rawGets: string[] = [];
        page.on("request", (request) => {
            if (request.method() !== "GET") {
                return;
            }
            const url = new URL(request.url());
            // The editor buffer uses the bare /raw GET; Download adds ?download=1.
            if (url.pathname === rawPath && !url.searchParams.has("download")) {
                rawGets.push(request.url());
            }
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "content1");

        const downloadsAfterOpen = rawGets.length;
        // Loader plus a StrictMode/preload duplicate may share one transfer or repeat it once.
        expect(downloadsAfterOpen).toBeGreaterThan(0);
        expect(downloadsAfterOpen).toBeLessThanOrEqual(2);

        const fileView = page.getByLabel("File view");
        const detailsLink = fileView.getByRole("link", {
            name: "Details",
            exact: true,
        });
        const viewLink = fileView.getByRole("link", {
            name: "View",
            exact: true,
        });
        // Intent preload re-runs the edit loader; a stale buffer would download again.
        await detailsLink.hover();
        await viewLink.hover();
        await detailsLink.hover();
        await viewLink.hover();

        // Leaving and returning remounts the editor and re-runs fetchQuery on the same key.
        await detailsLink.click();
        await expect(detailsLink).toHaveAttribute("aria-current", "page");
        await viewLink.click();
        await expectEditorText(editor, "content1");

        // Preload and remount must reuse the cached buffer instead of hitting /raw again.
        expect(rawGets.length).toBe(downloadsAfterOpen);
    });

    test("should keep large files inside the editor viewport", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "large-viewport.txt");
        const lines = [
            "FIRST_VISIBLE_LINE",
            ...Array.from(
                { length: 498 },
                (_, index) => `middle line ${index + 2}`,
            ),
            "LAST_BUFFER_LINE",
        ];
        await fs.writeFile(filePath, lines.join("\n"));
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        const editorViewport = page.getByRole("region", {
            name: "Editor viewport",
        });
        await expect(editor.getByText("FIRST_VISIBLE_LINE")).toBeVisible();

        const editorBox = await editorViewport.boundingBox();
        const viewport = page.viewportSize();
        expect(editorBox).not.toBeNull();
        expect(viewport).not.toBeNull();
        if (editorBox === null || viewport === null) {
            throw new Error("expected editor and viewport measurements");
        }
        // The visible editor surface must stay inside the window, not grow with the buffer.
        expect(editorBox.height).toBeLessThan(viewport.height);

        const pageScroll = await page.getByRole("main").evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));
        // Vertical scrolling must stay in CodeMirror, not the overlay page scroller.
        expect(pageScroll.scrollHeight).toBeLessThanOrEqual(
            pageScroll.clientHeight + 1,
        );

        // Distant lines stay out of the DOM until the editor scroller reaches them.
        await expect(editor.getByText("LAST_BUFFER_LINE")).toHaveCount(0);
        await editor.press("Control+End");
        await expect(editor.getByText("LAST_BUFFER_LINE")).toBeVisible();
    });

    test("should refresh a clean editor when the tab is focused", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "focus-refresh.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");

        await fs.writeFile(filePath, "changed on disk");
        await simulateTabRefocus(page);

        // A clean editor should pick up external writes after the user returns to the tab.
        await expectEditorText(editor, "changed on disk");
    });

    test("should keep unsaved edits when the tab is focused", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "focus-dirty.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "unsaved local edit");

        await fs.writeFile(filePath, "changed on disk");
        await simulateTabRefocus(page);

        // Dirty text must survive refocus so an external change cannot wipe in-progress edits.
        await expectEditorText(editor, "unsaved local edit");
    });

    test("should restore unsaved edits", async ({ page }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "content1");

        await fillEditor(editor, "temporary unsaved text");
        await expectEditorText(editor, "temporary unsaved text");
        // Restore must undo in-memory edits without writing to disk.
        await page
            .getByRole("button", { name: "Restore file contents" })
            .click();
        await expectEditorText(editor, "content1");
    });

    test("should save edits to disk", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "content1");
        await fillEditor(editor, "saved from ui");
        // Wait until React marks the buffer dirty so Save is actually clickable.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Save file" }).click();

        // Status feedback confirms the upload completed in the UI.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // Polling the filesystem verifies the PUT actually replaced remote bytes.
        await expect
            .poll(async () => fs.readFile(filePath, "utf8"))
            .toBe("saved from ui");
    });

    test("should show unsupported message for binary files", async ({
        page,
    }) => {
        const binaryPath = path.join(ctx.testDirPath, "binary.bin");
        await fs.writeFile(
            binaryPath,
            Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
        );

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "binary.bin", exact: true })
            .click();

        // Non-image binaries still expose View so users get an explicit unsupported state.
        await page.getByRole("link", { name: "View", exact: true }).click();
        await expect(page).toHaveURL(/\?view=edit$/);
        await expect(page.getByLabel("Unsupported file type")).toHaveText(
            "Viewing this file type is not supported",
        );
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("binary.bin");
    });

    test("should show unsupported message for large text files", async ({
        page,
    }) => {
        const largePath = path.join(ctx.testDirPath, "large.txt");
        // Just over the 2 MiB editor limit so multi-megabyte text stays download-only.
        const largeContent = "a".repeat(2 * 1024 * 1024 + 1);
        await fs.writeFile(largePath, largeContent);

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "large.txt", exact: true })
            .click();

        // Size gating routes oversized text to the unsupported view instead of a huge textarea.
        await page.getByRole("link", { name: "View", exact: true }).click();
        await expect(page.getByLabel("Unsupported file type")).toHaveText(
            "Viewing this file type is not supported",
        );
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("large.txt");
    });

    test("should open image view for PNG magic bytes without relying on extension", async ({
        page,
    }) => {
        const imagePath = path.join(ctx.testDirPath, "photo.bin");
        // Minimal PNG signature so the agent marks the path viewable by content.
        await fs.writeFile(
            imagePath,
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );

        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "photo.bin", exact: true })
            .click();
        await page.getByRole("link", { name: "View", exact: true }).click();

        await expect(page).toHaveURL(/\?view=edit$/);
        // Image representation is selected in the same View switch used by the text editor.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "View", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
            page.getByRole("img", { name: "photo.bin" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("photo.bin");
    });

    test("should save edits with the conventional shortcut", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "shortcut-save.txt");
        await fs.writeFile(filePath, "shortcut original");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "shortcut original");
        await fillEditor(editor, "saved with shortcut");
        // The shortcut must wait for a dirty buffer just like the Save button.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        await page.keyboard.press("ControlOrMeta+s");

        // Status feedback confirms Mod-s used the same upload path as the button.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // Polling the filesystem verifies the shortcut actually replaced remote bytes.
        await expect
            .poll(async () => fs.readFile(filePath, "utf8"))
            .toBe("saved with shortcut");
    });

    test("should expose the save shortcut on the Save control", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}?view=edit`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        await page.getByRole("button", { name: "Save file" }).hover();
        // The tooltip keeps the accessible name as Save file while advertising Ctrl+S.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Save file (Ctrl+S)",
        );
    });

    test("should open shell-style files in the file editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, ".bashrc");
        await fs.writeFile(filePath, "export FOO=1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        // Filename-based shell mapping must still produce an editable File editor.
        await expect(page.getByLabel("File editor")).toBeVisible();
        await expectEditorText(page.getByLabel("File editor"), "export FOO=1");
    });

    test("should keep the editor focused draft when Backspace is pressed", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "backspace-guard.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "keep this draft");
        await editor.click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Backspace");

        // CodeMirror is contenteditable; Backspace must edit text, not leave the file.
        await expect(page).toHaveURL(/\?view=edit$/);
        await expect(
            page.getByRole("dialog", { name: "Discard unsaved changes?" }),
        ).toBeHidden();
        await expectEditorText(editor, "keep this draft");
    });

    test("should keep unsaved edits when in-app navigation is cancelled", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-cancel.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "keep this draft");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        await page
            .getByLabel("File view")
            .getByRole("link", { name: "Details", exact: true })
            .click();

        const confirmDialog = page.getByRole("dialog", {
            name: "Discard unsaved changes?",
        });
        // In-app links must not drop the draft without an explicit confirm.
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "Cancel" }).click();
        await expect(confirmDialog).toBeHidden();
        await expect(page).toHaveURL(/\?view=edit$/);
        await expectEditorText(editor, "keep this draft");
    });

    test("should discard unsaved edits when leaving is confirmed", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-confirm.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "throw this draft away");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        await page
            .getByLabel("File view")
            .getByRole("link", { name: "Details", exact: true })
            .click();

        const confirmDialog = page.getByRole("dialog", {
            name: "Discard unsaved changes?",
        });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog
            .getByRole("button", { name: "Discard changes" })
            .click();

        // Confirming leave must complete the Details navigation after the user accepts data loss.
        await expect(confirmDialog).toBeHidden();
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect
            .poll(async () => fs.readFile(filePath, "utf8"))
            .toBe("original buffer");
    });

    test("should allow navigation after restoring unsaved edits", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-after-restore.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await fillEditor(editor, "temporary draft");
        await page
            .getByRole("button", { name: "Restore file contents" })
            .click();
        await expectEditorText(editor, "original buffer");

        await page
            .getByLabel("File view")
            .getByRole("link", { name: "Details", exact: true })
            .click();

        // A clean buffer must not prompt, otherwise Restore would not actually clear the guard.
        await expect(
            page.getByRole("dialog", { name: "Discard unsaved changes?" }),
        ).toBeHidden();
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");
    });

    test("should warn before reload when the editor is dirty", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "reload-guard.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=edit`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "do not lose this");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        // Playwright auto-accepts beforeunload, so assert the same window listener the browser uses.
        const dirtyReloadBlocked = await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        });
        expect(dirtyReloadBlocked).toBe(true);
        await expectEditorText(editor, "do not lose this");

        await page
            .getByRole("button", { name: "Restore file contents" })
            .click();
        await expectEditorText(editor, "original buffer");
        const cleanReloadBlocked = await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        });
        // A clean buffer must not trap refresh or tab close.
        expect(cleanReloadBlocked).toBe(false);
    });
});
