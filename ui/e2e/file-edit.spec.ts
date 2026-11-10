import { test, expect, type Locator, type Page } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import {
    deleteIsolatedTerminalSessions,
    isolateTerminalSessions,
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    expectTerminalFocused,
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

/**
 * Opens the editor's right-click menu. The event is dispatched rather than clicked, because a
 * real right-click also lets the browser move the caret and would disturb the selection.
 */
async function openEditorContextMenu(page: Page, editor: Locator) {
    await editor.dispatchEvent("contextmenu", { clientX: 40, clientY: 40 });
    const menu = page.getByRole("dialog", { name: "Editor context menu" });
    await expect(menu).toBeVisible();

    return menu;
}

/** Opens the editor overflow so secondary actions can be exercised by accessible name. */
async function openEditorActions(page: Page) {
    await page.getByRole("button", { name: "Editor actions" }).click();

    return page.getByRole("dialog", { name: "Editor actions" });
}

test.describe.serial("File Edit View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("edit");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async ({ page }) => {
        // Terminal sessions are shared server state; see `isolateTerminalSessions`.
        await isolateTerminalSessions(page);
    });

    test.afterEach(async ({ page }) => {
        await deleteIsolatedTerminalSessions(page);
    });

    test("should open editable files in the Edit tab by default", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}"]`,
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
        await expectEditorText(
            page.getByLabel("File editor", { exact: true }),
            "content1",
        );
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        // Desktop actions stay icon-only while their accessible names remain available.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toHaveText("");
        const editorActions = await openEditorActions(page);
        await expect(
            editorActions.getByRole("button", { name: "Reload", exact: true }),
        ).toBeEnabled();
        await expect(
            editorActions.getByRole("link", { name: "Download", exact: true }),
        ).toHaveAttribute("href", /[?&]download=1$/);
    });

    test("should open details from the second file tab", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}"]`,
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });

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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editorPanel = page.getByRole("article", {
            name: "Editing panel",
        });

        const expandButton = page.getByRole("button", {
            name: "Expand editor to full window",
        });

        const optionsButton = page.getByRole("button", {
            name: "Editor actions",
        });

        await expect(optionsButton).toBeVisible();
        await expandButton.click();
        // The restore action proves full-window mode without coupling this workflow to layout.
        await expect(
            editorPanel.getByRole("button", { name: "Restore editor size" }),
        ).toBeVisible();
        await expect(
            editorPanel.getByRole("button", { name: "Save file" }),
        ).toBeVisible();
        const editorActions = await openEditorActions(page);
        await expect(
            editorActions.getByRole("button", { name: "Reload", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(editorActions).toBeHidden();

        await page
            .getByLabel("File editor", { exact: true })
            .press("ControlOrMeta+f");
        // Search remains inside the expanded panel rather than behind the overlay.
        await expect(editorPanel.getByLabel("Find in file")).toBeVisible();

        const restoreButton = editorPanel.getByRole("button", {
            name: "Restore editor size",
        });

        await restoreButton.click();
        // Restoring returns the card to the route layout without replacing the editor.
        await expect(expandButton).toBeVisible();
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toHaveText("full window content");
    });

    test("should keep the full-window editor in the URL so Back leaves it", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "full-window-url.txt");
        await fs.writeFile(filePath, "full window url content");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        await page.goto(fileUrl);

        const editorPanel = page.getByRole("article", {
            name: "Editing panel",
        });

        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        // Entering full window is a new history entry, so it can be linked to and left with Back.
        await expect(page).toHaveURL(`${fileUrl}?fullWindow=true`);
        await expect(editorPanel).toHaveCSS("position", "fixed");

        await page.reload();
        // A reload, like opening a shared link, starts in the full-window editor.
        await expect(editorPanel).toHaveCSS("position", "fixed");

        await page.goBack();
        // Back returns to the normal layout without leaving the file.
        await expect(page).toHaveURL(fileUrl);
        await expect(editorPanel).toHaveCSS("position", "static");
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toHaveText("full window url content");
    });

    test("should select the open file from the editor options menu", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/file1.txt`)}`,
        );
        await expectEditorText(
            page.getByLabel("File editor", { exact: true }),
            "content1",
        );

        await page.getByRole("button", { name: "Editor actions" }).click();

        const editorActions = page.getByRole("dialog", {
            name: "Editor actions",
        });

        const selectFile = editorActions.getByRole("button", {
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

        await page.getByRole("button", { name: "Editor actions" }).click();

        const unselectFile = editorActions.getByRole("button", {
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByRole("textbox", {
            name: "File editor",
            exact: true,
        });

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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByRole("textbox", {
            name: "File editor",
            exact: true,
        });

        await expectEditorText(editor, "original buffer");
        await page.waitForLoadState("networkidle");
        const downloadsAfterOpen = rawGets;

        await editor.focus();
        // First editor focus uses the freshly loaded buffer instead of repeating the loader GET.
        expect(downloadsAfterOpen).toBeGreaterThan(0);
        expect(downloadsAfterOpen).toBeLessThanOrEqual(2);
        await page
            .getByRole("button", { name: "Editor actions", exact: true })
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

        // A dirty editor still checks the device, so it can warn that the file changed there.
        await expect(
            page.getByRole("alert", { name: "File changed on device" }),
        ).toBeVisible();
        expect(rawGets).toBe(downloadsAfterOpen + 2);
        // The browser version always wins: refocusing never replaces the local draft.
        await expectEditorText(editor, "unsaved local edit");
    });

    test("should keep unsaved edits on reload and offer the device version when it changed", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "reload-dirty.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "temporary unsaved text");

        const banner = page.getByRole("alert", {
            name: "File changed on device",
        });

        let editorActions = await openEditorActions(page);
        await editorActions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        // Reloading an unchanged device file asks nothing and keeps the unsaved text.
        await expect(
            page.getByRole("dialog", { name: "Discard unsaved changes?" }),
        ).toBeHidden();
        await expectEditorText(editor, "temporary unsaved text");
        // Nothing changed on the device, so there is nothing to warn about.
        await expect(banner).toBeHidden();

        await fs.writeFile(filePath, "written on the device");
        editorActions = await openEditorActions(page);
        await editorActions
            .getByRole("button", { name: "Reload", exact: true })
            .click();
        // A device change under unsaved edits is announced instead of applied.
        await expect(banner).toBeVisible();
        await expectEditorText(editor, "temporary unsaved text");
        // Saving stays possible and would overwrite the device version.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        await banner
            .getByRole("button", { name: "Discard my changes" })
            .click();
        // Discarding loads what the device holds now and makes the buffer clean.
        await expectEditorText(editor, "written on the device");
        await expect(banner).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
    });

    test("should reload a clean editor from the agent", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "manual-reload.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "original buffer");

        await fs.writeFile(filePath, "manually reloaded");
        const editorActions = await openEditorActions(page);
        await editorActions
            .getByRole("button", { name: "Reload", exact: true })
            .click();

        // Reload remains available for clean editors and replaces cached content.
        await expectEditorText(editor, "manually reloaded");
    });

    test("should save through a relative symlink with the dedicated edit endpoint", async ({
        page,
    }) => {
        const targetPath = path.join(ctx.testDirPath, "symlink-target.txt");
        const linkPath = path.join(ctx.testDirPath, "symlink-editor.txt");
        await fs.writeFile(targetPath, "symlink original");
        await fs.symlink("symlink-target.txt", linkPath);
        const editPath = `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/edit/${encodeFilesystemPath(linkPath)}`;
        const rawPath = `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/raw/${encodeFilesystemPath(linkPath)}`;
        const putPaths: string[] = [];
        page.on("request", (request) => {
            if (request.method() === "PUT") {
                putPaths.push(new URL(request.url()).pathname);
            }
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(linkPath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "symlink original");
        await fillEditor(editor, "saved through symlink");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Save file" }).click();

        // Existing editor feedback must report successful completion through the link.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // The target receives the new bytes because editor saves follow symlinks.
        await expect
            .poll(async () => fs.readFile(targetPath, "utf8"))
            .toBe("saved through symlink");
        // The selected link entry must survive with its original relative text.
        await expect
            .poll(async () => fs.readlink(linkPath))
            .toBe("symlink-target.txt");
        // Save must use the dedicated edit endpoint rather than raw replacement upload.
        expect(putPaths).toContain(editPath);
        // No raw PUT may occur because that would replace the symlink entry.
        expect(putPaths).not.toContain(rawPath);
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
                `a[href="/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}"]`,
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
                `a[href="/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}"]`,
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
                `a[href="/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}"]`,
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "shortcut original");
        await fillEditor(editor, "saved with shortcut");
        // The shortcut must wait for a dirty buffer just like the Save button.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        await page.keyboard.press("ControlOrMeta+s");

        // Status feedback confirms Mod-s used the same edit path as the button.
        await expect(page.getByLabel("File edit status")).toHaveText("Saved");
        // Polling the filesystem verifies the shortcut rewrote the remote bytes.
        await expect
            .poll(async () => fs.readFile(filePath, "utf8"))
            .toBe("saved with shortcut");
        // Mod-s must leave the caret in CodeMirror so the next keystroke still edits.
        await expect(editor).toBeFocused();
    });

    test("should cut, paste and toggle comments from the editor context menu", async ({
        page,
        context,
    }) => {
        const filePath = path.join(ctx.testDirPath, "context-menu.js");
        await fs.writeFile(
            filePath,
            `const a = 1;
const b = 2;`,
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "const a = 1;const b = 2;");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");

        let menu = await openEditorContextMenu(page, editor);
        // Without a selection there is nothing to copy or cut.
        await expect(
            menu.getByRole("button", { name: "Cut", exact: true }),
        ).toBeDisabled();
        await expect(
            menu.getByRole("button", { name: "Copy", exact: true }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("Shift+End");
        menu = await openEditorContextMenu(page, editor);
        await menu.getByRole("button", { name: "Cut", exact: true }).click();
        // Cut removes the selected line text from the buffer.
        await expectEditorText(editor, "const b = 2;");
        // Cut puts the removed text on the clipboard so it can be pasted elsewhere.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe("const a = 1;");

        // The menu hands focus back, so the keyboard keeps editing at the caret.
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.press("Enter");
        menu = await openEditorContextMenu(page, editor);
        await menu.getByRole("button", { name: "Paste", exact: true }).click();
        // Paste inserts the clipboard text at the caret.
        await expectEditorText(editor, "const b = 2;const a = 1;");

        // The caret stays on the pasted last line, which the comment toggles.
        menu = await openEditorContextMenu(page, editor);
        await menu
            .getByRole("button", { name: "Toggle comment", exact: true })
            .click();
        // The comment uses the JavaScript line comment syntax of the file's language.
        await expectEditorText(editor, "const b = 2;// const a = 1;");

        menu = await openEditorContextMenu(page, editor);
        await menu
            .getByRole("button", { name: "Toggle comment", exact: true })
            .click();
        // A second toggle removes the comment again.
        await expectEditorText(editor, "const b = 2;const a = 1;");

        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        menu = await openEditorContextMenu(page, editor);
        await menu
            .getByRole("button", { name: "Find in file", exact: true })
            .click();
        // Find in file opens the editor's own find panel with the one-line selection as its query.
        await expect(
            page.getByRole("searchbox", { name: "Find in file" }),
        ).toHaveValue("const a = 1;");
        await page.keyboard.press("Escape");
        await expect(
            page.getByRole("searchbox", { name: "Find in file" }),
        ).toHaveCount(0);

        menu = await openEditorContextMenu(page, editor);
        // The menu teaches the keyboard chord for the comment toggle.
        await expect(
            menu.getByRole("button", { name: "Toggle comment", exact: true }),
        ).toContainText("Alt+C");
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.press("Alt+c");
        // Alt+C toggles the comment like the menu item does, instead of typing a character.
        await expectEditorText(editor, "const b = 2;// const a = 1;");
    });

    test("should copy whole selected lines, or the cursor line, with a file and line reference", async ({
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
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });

        // CodeMirror renders line breaks between sibling elements, so DOM text is concatenated.
        await expect(editor).toHaveText("alphabetagamma");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Shift+ArrowDown");

        let menu = await openEditorContextMenu(page, editor);

        let copyReferenceButton = menu.getByRole("button", {
            name: "Copy with file reference",
        });

        await copyReferenceButton.hover();
        // The tooltip explains both the copied syntax and why it is useful with AI agents.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Copy as a path#Lline code block for AI prompts",
        );
        await copyReferenceButton.click();

        // A selection starting and ending mid-line still copies both lines in full, since the
        // reference names whole lines.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L2
beta
gamma
\`\`\``);
        // Non-modal feedback confirms the asynchronous browser clipboard write completed.
        await expect(page.getByRole("status")).toHaveText(
            "Copied lines with file reference",
        );

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowRight");
        menu = await openEditorContextMenu(page, editor);
        copyReferenceButton = menu.getByRole("button", {
            name: "Copy with file reference",
        });

        // Without a selection the action still works, on the cursor's line.
        await expect(copyReferenceButton).toBeEnabled();
        await copyReferenceButton.click();

        // Only the line holding the cursor is copied when nothing is selected.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L1
alpha
\`\`\``);
    });

    test("should search selected editor text from the file's directory", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "search-selection.txt");
        await fs.writeFile(filePath, "search-selection-token");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("search-selection-token");

        let menu = await openEditorContextMenu(page, editor);

        let searchDirectoryItem = menu.getByRole("button", {
            name: "Search in file's directory",
        });

        // Without a selection there is no text to search for.
        await expect(searchDirectoryItem).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+a");
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            "search-selection-token",
        );

        menu = await openEditorContextMenu(page, editor);

        searchDirectoryItem = menu.getByRole("button", {
            name: "Search in file's directory",
        });

        // A non-empty CodeMirror selection enables the agent content search action.
        await expect(searchDirectoryItem).toBeEnabled();
        // The menu teaches the keyboard chord for the same search.
        await expect(searchDirectoryItem).toContainText("Ctrl+Shift+S");
        await searchDirectoryItem.hover();
        // The tooltip says what is searched, which the label leaves out.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Search the selected text in file contents",
        );

        const grepRequest = page.waitForRequest((request) =>
            new URL(request.url()).pathname.includes("/grep-stream/"),
        );

        await searchDirectoryItem.click();

        const dialog = page.getByRole("dialog", {
            name: "Search device",
        });

        // The URL-owned dialog must open with the editor selection as a content search.
        await expect(
            dialog.getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue("search-selection-token");
        await expect(page).toHaveURL(/[?&]q=search-selection-token/);
        await expect(page).toHaveURL(/[?&]mode=content/);
        // The search starts from the file's directory; the dialog offers the Git root itself.
        await expect(page).not.toHaveURL(/[?&]gitroot=/);
        const requestBody: unknown = (await grepRequest).postDataJSON();
        const grepPath = new URL((await grepRequest).url()).pathname;
        // Agent identity is carried by the scoped grep URL.
        expect(grepPath).toContain(
            `/api/v1/agents/${encodeURIComponent(ctx.agentId)}/grep-stream/`,
        );
        // The grep runs in the file's directory, not the checkout above it.
        expect(decodeURIComponent(grepPath)).toContain(ctx.testDirPath);
        // The grep POST body proves editor selection bypasses the default path mode.
        expect(requestBody).toMatchObject({ query: "search-selection-token" });
    });

    test("should search the editor selection from the editor actions menu", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "search-actions-menu.txt");
        await fs.writeFile(filePath, "search-menu-token");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("search-menu-token");

        let actions = await openEditorActions(page);

        // Without a selection there is no text to search for.
        await expect(
            actions.getByRole("button", {
                name: "Search selection in file's directory",
            }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(actions).toHaveCount(0);

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+a");
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            "search-menu-token",
        );
        actions = await openEditorActions(page);
        // Phones reach the selection search through this menu, without a right click.
        await actions
            .getByRole("button", {
                name: "Search selection in file's directory",
            })
            .click();
        // The menu opens the same content search as the editor's context menu.
        await expect(
            page
                .getByRole("dialog", { name: "Search device" })
                .getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue("search-menu-token");
        await expect(page).not.toHaveURL(/[?&]gitroot=/);
    });

    test("should search the editor selection from the file's directory with Ctrl+Shift+S", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "search-shortcut.txt");
        await fs.writeFile(filePath, "search-shortcut-token");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("search-shortcut-token");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+a");
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            "search-shortcut-token",
        );
        await page.keyboard.press("ControlOrMeta+Shift+s");

        // The shortcut opens the same content search as the menu item.
        await expect(
            page
                .getByRole("dialog", { name: "Search device" })
                .getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue("search-shortcut-token");
        // Like the menu item, the shortcut starts from the file's directory.
        await expect(page).not.toHaveURL(/[?&]gitroot=/);
    });

    test("should open shell-style files in the file editor", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, ".bashrc");
        await fs.writeFile(filePath, "export FOO=1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        // Filename-based shell mapping must still produce an editable File editor.
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();
        await expectEditorText(
            page.getByLabel("File editor", { exact: true }),
            "export FOO=1",
        );
    });

    test("should keep the editor focused draft when Backspace is pressed", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "backspace-guard.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
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

    test("should keep unsaved edits across in-app navigation without asking", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "leave-and-return.txt");
        await fs.writeFile(filePath, "original buffer");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expectEditorText(editor, "original buffer");
        await fillEditor(editor, "keep this draft");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        const fileView = page.getByLabel("File view");
        await fileView
            .getByRole("link", { name: "Details", exact: true })
            .click();
        // Edited files stay open with their buffer, so leaving needs no confirmation.
        await expect(
            page.getByRole("dialog", { name: "Discard unsaved changes?" }),
        ).toBeHidden();
        await expect(
            fileView.getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await fileView.getByRole("link", { name: "Edit", exact: true }).click();
        // Coming back shows the unsaved text, still unsaved.
        await expectEditorText(editor, "keep this draft");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        // The device file was never touched by leaving.
        expect(await fs.readFile(filePath, "utf8")).toBe("original buffer");

        const unloadBlocked = await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);

            return event.defaultPrevented;
        });

        // Unsaved edits are kept on the server, so closing or reloading the tab is not blocked.
        expect(unloadBlocked).toBe(false);
    });

    test("should move focus between the editor and terminal with alt shortcuts", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "alt-focus.txt");
        await fs.writeFile(filePath, "content1");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });

        const editorViewport = page.getByRole("region", {
            name: "Editor viewport",
        });

        await expectEditorText(editor, "content1");
        await editor.focus();
        await expect(editor).toBeFocused();
        // A focused editor must show the same blue frame as a focused shell.
        await expect
            .poll(() =>
                editorViewport.evaluate(
                    (element) =>
                        getComputedStyle(element, "::after").borderColor,
                ),
            )
            .toBe("oklch(0.623 0.214 259.815)");

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

        const terminalInput = page
            .getByRole("textbox", {
                name: `agent1_src 1 for ${ctx.agentName}`,
            })
            .filter({ has: page.locator("textarea") });

        // Alt+t from the editor must reuse the same open-or-focus action as t.
        await expectTerminalFocused(terminalInput);
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
        await expectTerminalFocused(terminalInput);

        await page.keyboard.type("e");
        // A focused shell must keep e as input instead of jumping to the editor.
        await expectTerminalFocused(terminalInput);
        await expect(editor).not.toBeFocused();

        await page.keyboard.press("Alt+e");
        // Alt+e from the terminal must return keyboard ownership to CodeMirror.
        await expect(editor).toBeFocused();
        await expect
            .poll(() =>
                editorViewport.evaluate(
                    (element) =>
                        getComputedStyle(element, "::after").borderColor,
                ),
            )
            .toBe("oklch(0.623 0.214 259.815)");
        await expectEditorText(editor, "t");
    });
});
