import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    minimizeBottomDrawer,
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

/** Opens the editor overflow so secondary actions can be exercised by accessible name. */
async function openEditorOptions(page: Page) {
    await page.getByRole("button", { name: "Editor options" }).click();
    return page.getByRole("dialog", { name: "Editor options" });
}

test.describe.serial("File Edit View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should open editable files in the Edit tab by default", async ({
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

        const fileView = page.getByLabel("File view");
        // Editable files use Edit as the first tab so opening a file starts in the editor.
        await expect(fileView.getByRole("link").first()).toHaveText("Edit");
        await expect(
            fileView.getByRole("link", { name: "Edit", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(page).not.toHaveURL(/[?&]view=/);
        // The editor should contain the on-disk contents so edits start from truth.
        await expectEditorText(page.getByLabel("File editor"), "content1");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        const saveBox = await page
            .getByRole("button", { name: "Save file" })
            .boundingBox();
        const bookmarkBox = await page
            .getByRole("button", { name: "Bookmark", exact: true })
            .boundingBox();
        const copyReferenceButton = page.getByRole("button", {
            name: "Copy selection with file reference",
        });
        const copyReferenceBox = await copyReferenceButton.boundingBox();
        expect(saveBox).not.toBeNull();
        expect(bookmarkBox).not.toBeNull();
        expect(copyReferenceBox).not.toBeNull();
        if (
            saveBox === null ||
            bookmarkBox === null ||
            copyReferenceBox === null
        ) {
            throw new Error("expected editor action measurements");
        }
        // Bookmark is the next persistent toolbar action after Save.
        expect(bookmarkBox.x).toBeGreaterThan(saveBox.x);
        // Copy reference follows Bookmark and stays unavailable without selected editor text.
        expect(copyReferenceBox.x).toBeGreaterThan(bookmarkBox.x);
        await expect(copyReferenceButton).toBeDisabled();
        const editorOptions = await openEditorOptions(page);
        await expect(
            editorOptions.getByRole("button", { name: "Reload", exact: true }),
        ).toBeEnabled();
        await expect(
            editorOptions.getByRole("link", { name: "Download", exact: true }),
        ).toHaveAttribute("href", /[?&]download=1$/);
    });

    test("should open details from the second file tab", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        const fileView = page.getByLabel("File view");
        await fileView
            .getByRole("link", { name: "Details", exact: true })
            .click();

        // Details is addressable only through the query so the default file URL stays on Edit.
        await expect(page).toHaveURL(/\?view=details$/);
        await expect(
            fileView.getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("file1.txt");
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
        const editLink = fileView.getByRole("link", {
            name: "Edit",
            exact: true,
        });
        // Intent preload re-runs the edit loader; a stale buffer would download again.
        await detailsLink.hover();
        await editLink.hover();
        await detailsLink.hover();
        await editLink.hover();

        // Leaving and returning remounts the editor and re-runs fetchQuery on the same key.
        await detailsLink.click();
        await expect(detailsLink).toHaveAttribute("aria-current", "page");
        await editLink.click();
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
        // CodeMirror's Mod-End command must reveal the virtualized document end.
        await editor.press("ControlOrMeta+End");
        await expect(editor.getByText("LAST_BUFFER_LINE")).toBeVisible();
    });

    test("should expand the complete editor to the full window", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "full-window.txt");
        await fs.writeFile(filePath, "full window content");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editorPanel = page.getByRole("article", {
            name: "Editing panel",
        });
        const expandButton = page.getByRole("button", {
            name: "Expand editor to full window",
        });
        const optionsButton = page.getByRole("button", {
            name: "Editor options",
        });
        const expandBox = await expandButton.boundingBox();
        const optionsBox = await optionsButton.boundingBox();
        expect(expandBox).not.toBeNull();
        expect(optionsBox).not.toBeNull();
        if (expandBox === null || optionsBox === null) {
            throw new Error("expected editor toolbar measurements");
        }
        // The expansion control belongs immediately before the overflow menu.
        expect(expandBox.x).toBeLessThan(optionsBox.x);

        await expandButton.click();

        await expect(editorPanel).toHaveCSS("position", "fixed");
        const panelBox = await editorPanel.boundingBox();
        const viewport = page.viewportSize();
        expect(panelBox).not.toBeNull();
        expect(viewport).not.toBeNull();
        if (panelBox === null || viewport === null) {
            throw new Error("expected expanded editor measurements");
        }
        // Fixed edges make the editor and all of its controls fill the browser window.
        expect(panelBox.x).toBe(0);
        expect(panelBox.y).toBe(0);
        expect(panelBox.width).toBe(viewport.width);
        expect(panelBox.height).toBe(viewport.height);
        await expect(
            editorPanel.getByRole("button", { name: "Save file" }),
        ).toBeVisible();
        const editorOptions = await openEditorOptions(page);
        await expect(
            editorOptions.getByRole("button", { name: "Reload", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(editorOptions).toBeHidden();

        await page.getByLabel("File editor").press("ControlOrMeta+f");
        // Search remains inside the expanded panel rather than behind the overlay.
        await expect(editorPanel.getByLabel("Find in file")).toBeVisible();

        const restoreButton = editorPanel.getByRole("button", {
            name: "Restore editor size",
        });
        await restoreButton.click();
        // Restoring returns the card to the route layout without replacing the editor.
        await expect(editorPanel).toHaveCSS("position", "static");
        await expect(page.getByLabel("File editor")).toHaveText(
            "full window content",
        );
    });

    test("should select the open file from the editor options menu", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}`,
        );
        await expectEditorText(page.getByLabel("File editor"), "content1");

        await page.getByRole("button", { name: "Editor options" }).click();
        const editorOptions = page.getByRole("dialog", {
            name: "Editor options",
        });
        const selectFile = editorOptions.getByRole("button", {
            name: "Select",
            exact: true,
        });
        // An unselected path must render the empty checkbox, not a checked icon.
        await expect(selectFile).toHaveAttribute("aria-pressed", "false");
        await selectFile.click();

        // The editor has no listing checkbox, so its overflow menu must add the open file.
        await expect(
            page.getByRole("tab", { name: "Selected 1" }),
        ).toBeVisible();
        // Selecting from the menu should reveal the shared selected-items drawer.
        await expect(
            page.getByRole("button", { name: "Minimize bottom drawer" }),
        ).toBeVisible();
        await expect(
            page.getByRole("tabpanel", { name: /Selected/ }).getByRole("link", {
                name: "file1.txt",
                exact: true,
            }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Editor options" }).click();
        const unselectFile = editorOptions.getByRole("button", {
            name: "Unselect",
            exact: true,
        });
        // Reopening the menu must show the path as already selected.
        await expect(unselectFile).toHaveAttribute("aria-pressed", "true");
        await unselectFile.click();

        // The same menu must also be able to remove the current file from the selection.
        await expect(
            page.getByRole("tab", { name: "Selected 0" }),
        ).toBeVisible();
        await minimizeBottomDrawer(page);
    });

    test("should refresh a clean editor when the tab is focused", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "focus-refresh.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "unsaved local edit");

        await fs.writeFile(filePath, "changed on disk");
        await simulateTabRefocus(page);

        // Dirty text must survive refocus so an external change cannot wipe in-progress edits.
        await expectEditorText(editor, "unsaved local edit");
    });

    test("should refresh a clean editor when CodeMirror regains focus", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "editor-focus-refresh");
        const rawPath = `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/${encodeFilesystemPath(filePath)}`;
        let rawGets = 0;
        page.on("request", (request) => {
            const url = new URL(request.url());
            if (
                request.method() === "GET" &&
                url.pathname === rawPath &&
                !url.searchParams.has("download")
            ) {
                rawGets += 1;
            }
        });
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await page.waitForLoadState("networkidle");
        const downloadsAfterOpen = rawGets;

        await editor.focus();
        // First editor focus uses the freshly loaded buffer instead of repeating the loader GET.
        expect(downloadsAfterOpen).toBeGreaterThan(0);
        expect(downloadsAfterOpen).toBeLessThanOrEqual(2);
        await page
            .getByRole("button", { name: "Bookmark", exact: true })
            .focus();
        await fs.writeFile(filePath, "changed before refocus");
        await editor.focus();

        // Returning to a clean CodeMirror surface pulls current bytes from the agent.
        await expectEditorText(editor, "changed before refocus");
        expect(rawGets).toBe(downloadsAfterOpen + 1);

        await fillEditor(editor, "unsaved local edit");
        await page.getByRole("button", { name: "Save file" }).focus();
        await fs.writeFile(filePath, "changed while dirty");
        await editor.focus();

        // Refocusing a dirty editor must not download or replace its local draft.
        await expectEditorText(editor, "unsaved local edit");
        expect(rawGets).toBe(downloadsAfterOpen + 1);
    });

    test("should reload unsaved edits after confirmation", async ({ page }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "content1");

        await fillEditor(editor, "temporary unsaved text");
        await expectEditorText(editor, "temporary unsaved text");
        // Reload must not discard the draft before the existing confirmation is accepted.
        let editorOptions = await openEditorOptions(page);
        await editorOptions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        const confirmDialog = page.getByRole("dialog", {
            name: "Discard unsaved changes?",
        });
        await expect(confirmDialog).toBeVisible();
        await confirmDialog.getByRole("button", { name: "Cancel" }).click();
        await expectEditorText(editor, "temporary unsaved text");

        editorOptions = await openEditorOptions(page);
        await editorOptions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        await confirmDialog
            .getByRole("button", { name: "Discard changes" })
            .click();
        await expectEditorText(editor, "content1");
    });

    test("should reload a clean editor from the agent", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "manual-reload.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");

        await fs.writeFile(filePath, "manually reloaded");
        const editorOptions = await openEditorOptions(page);
        await editorOptions
            .getByRole("button", { name: "Reload", exact: true })
            .click();

        // Reload remains available for clean editors and replaces cached content.
        await expectEditorText(editor, "manually reloaded");
    });

    test("should save edits to disk", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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

    test("should replace-navigate unsupported binaries to details", async ({
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

        // Unviewable files skip the empty content tab so Backspace/history stay on the listing.
        await expect(page).toHaveURL(/\?view=details$/);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("binary.bin");
        await page.goBack();
        await expect(
            page.getByRole("link", { name: "binary.bin", exact: true }),
        ).toBeVisible();
    });

    test("should replace-navigate oversized text to details", async ({
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

        // Size gating must not open a huge editor, so the default content URL is replaced.
        await expect(page).toHaveURL(/\?view=details$/);
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

        await expect(page).not.toHaveURL(/[?&]view=/);
        // Images keep the View label because they are display-only, not editable text.
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
        // The default image representation must expose the same object actions as Details.
        await expect(
            page.getByRole("link", { name: "Download", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "More", exact: true }).click();
        const imageMore = page.getByRole("dialog", { name: "More" });
        await expect(
            imageMore.getByRole("button", { name: "Rename", exact: true }),
        ).toBeVisible();
        await expect(
            imageMore.getByRole("button", {
                name: "Select",
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            imageMore.getByRole("button", { name: "Delete file", exact: true }),
        ).toBeVisible();
    });

    test("should save edits with the conventional shortcut", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "shortcut-save.txt");
        await fs.writeFile(filePath, "shortcut original");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
        // Mod-s must leave the caret in CodeMirror so the next keystroke still edits.
        await expect(editor).toBeFocused();
    });

    test("should expose the save shortcut on the Save control", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}`,
        );

        await expect(page.getByLabel("File editor")).toBeVisible();
        await page.getByRole("button", { name: "Save file" }).hover();
        // The tooltip keeps the accessible name as Save file while advertising Ctrl+S.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Save file (Ctrl+S)",
        );
    });

    test("should copy selected text with its file and starting line reference", async ({
        page,
        context,
    }) => {
        const filePath = path.join(ctx.testDirPath, "copy-reference.txt");
        await fs.writeFile(
            filePath,
            `alpha
beta
gamma`,
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        const copyReferenceButton = page.getByRole("button", {
            name: "Copy selection with file reference",
        });
        // CodeMirror renders line breaks between sibling elements, so DOM text is concatenated.
        await expect(editor).toHaveText("alphabetagamma");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+ArrowDown");
        await page.keyboard.press("Shift+End");

        // A non-empty CodeMirror selection enables the adjacent reference action.
        await expect(copyReferenceButton).toBeEnabled();
        await copyReferenceButton.hover();
        // The tooltip explains both the copied syntax and why it is useful with AI agents.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Copy the selection as a fenced code block headed by path#Lline, ready to reference this file in prompts to AI agents.",
        );
        await copyReferenceButton.click();

        // The clipboard payload matches the path-and-line fenced format shown by the tooltip.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L2
beta
gamma
\`\`\``);
        // Non-modal feedback confirms the asynchronous browser clipboard write completed.
        await expect(page.getByRole("status")).toHaveText(
            "Copied selection with file reference",
        );
    });

    test("should open shell-style files in the file editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, ".bashrc");
        await fs.writeFile(filePath, "export FOO=1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "keep this draft");
        await editor.click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Backspace");

        // CodeMirror is contenteditable; Backspace must edit text, not leave the file.
        await expect(page).not.toHaveURL(/[?&]view=/);
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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
        await expect(page).not.toHaveURL(/[?&]view=/);
        await expectEditorText(editor, "keep this draft");
    });

    test("should discard unsaved edits when leaving is confirmed", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-confirm.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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

    test("should allow navigation after reloading unsaved edits", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-after-restore.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        await fillEditor(editor, "temporary draft");
        const editorOptions = await openEditorOptions(page);
        await editorOptions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "Discard unsaved changes?" })
            .getByRole("button", { name: "Discard changes" })
            .click();
        await expectEditorText(editor, "original buffer");

        await page
            .getByLabel("File view")
            .getByRole("link", { name: "Details", exact: true })
            .click();

        // A clean buffer must not prompt, otherwise Reload would not actually clear the guard.
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
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

        const editorOptions = await openEditorOptions(page);
        await editorOptions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        await page
            .getByRole("dialog", { name: "Discard unsaved changes?" })
            .getByRole("button", { name: "Discard changes" })
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

    test("should move focus between the editor and terminal with alt shortcuts", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "alt-focus.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor");
        const editorViewport = page.getByRole("region", {
            name: "Editor viewport",
        });
        await expectEditorText(editor, "content1");
        await editor.focus();
        await expect(editor).toBeFocused();
        // A focused editor must show the same blue frame as a focused shell.
        await expect(editorViewport).toHaveCSS(
            "border-color",
            "oklch(0.623 0.214 259.815)",
        );

        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type("t");
        // Typing t into CodeMirror must edit the buffer instead of opening a terminal.
        await expectEditorText(editor, "t");
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);

        await page.keyboard.press("Alt+t");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        const terminalInput = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });
        // Alt+t from the editor must reuse the same open-or-focus action as t.
        await expect(terminalInput).toBeFocused();
        await expectEditorText(editor, "t");

        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .hover();
        // The plus action advertises both the global and editor-scoped shortcuts.
        await expect(page.getByRole("tooltip")).toHaveText(
            `New terminal in ${ctx.agentName} (t, Alt+t)`,
        );
        await page.mouse.move(0, 0);
        await terminalInput.click();
        await expect(terminalInput).toBeFocused();

        await page.keyboard.type("e");
        // A focused shell must keep e as input instead of jumping to the editor.
        await expect(terminalInput).toBeFocused();
        await expect(editor).not.toBeFocused();

        await page.keyboard.press("Alt+e");
        // Alt+e from the terminal must return keyboard ownership to CodeMirror.
        await expect(editor).toBeFocused();
        await expect(editorViewport).toHaveCSS(
            "border-color",
            "oklch(0.623 0.214 259.815)",
        );
        await expectEditorText(editor, "t");
    });
});
