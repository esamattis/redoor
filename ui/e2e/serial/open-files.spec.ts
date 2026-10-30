// Serial: replaces the shared user settings to seed open files and asserts on the saved list.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
    dragReorderRow,
    keyboardReorder,
    waitForKeyboardSensor,
} from "../reorder";

import { ApiClient } from "#ui/api-client";
import { parseStoredBuffer } from "#ui/editor/stored-buffer";
import { BackgroundTabs } from "../background-tabs";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    simulateTabRefocus,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

test.describe.serial("Open files", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("open-files");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async () => {
        await resetOpenFileState();
    });

    test.afterEach(async () => {
        await resetOpenFileState();
    });

    async function resetOpenFileState() {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Editor tests open files on first edit, so this file must not inherit that shared list.
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                openFiles: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
                deviceOrder: [],
            },
        });
    }

    /**
     * Keeps the shown file open with a double click in the editor and waits for the background
     * user-state write, because a following page.goto() aborts a write still in flight and the
     * reloaded page would miss it.
     */
    async function keepOpen(page: Page) {
        const openPersisted = page.waitForResponse(
            (response) =>
                response.request().method() === "PUT" &&
                response.url().includes("/api/v1/user/state"),
        );

        await page.getByRole("region", { name: "Editor viewport" }).dblclick();
        await openPersisted;
    }

    test("keeps editor files open beside the navigation rail with newer files at the bottom", async ({
        page,
        browser,
    }) => {
        const firstName = "file1.txt";
        const secondName = "file2.txt";
        const firstPath = path.join(ctx.testDirPath, firstName);
        const secondPath = path.join(ctx.testDirPath, secondName);

        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(firstPath)}`,
        );

        await page.getByRole("region", { name: "Editor viewport" }).dblclick();

        const openFiles = applicationNavigation.getByRole("list", {
            name: "Open files",
        });

        const firstItem = openFiles.getByRole("listitem").filter({
            hasText: firstName,
        });

        // The left menu must show the open file beside the destinations, not in the device sidebar.
        await expect(
            firstItem.getByRole("link", { name: firstName, exact: true }),
        ).toBeVisible();

        const transfersBox = await applicationNavigation
            .getByRole("link", { name: "Transfers" })
            .boundingBox();

        const firstLinkBox = await firstItem
            .getByRole("link", { name: firstName, exact: true })
            .boundingBox();

        // Open files own the column to the right of the icon rail, so they start above its last icons.
        expect(firstLinkBox?.x ?? 0).toBeGreaterThan(
            (transfersBox?.x ?? 1) + (transfersBox?.width ?? 0),
        );
        expect(firstLinkBox?.y ?? 1).toBeLessThan(transfersBox?.y ?? 0);

        const deviceLabel = firstItem.getByText(ctx.agentName, { exact: true });
        // Operators need the owning device under the file name.
        await expect(deviceLabel).toBeVisible();
        const deviceBox = await deviceLabel.boundingBox();
        expect(deviceBox?.y ?? 0).toBeGreaterThan(firstLinkBox?.y ?? 1);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(secondPath)}`,
        );
        await page.getByRole("region", { name: "Editor viewport" }).dblclick();

        const secondItem = openFiles.getByRole("listitem").filter({
            hasText: secondName,
        });

        const secondLinkBox = await secondItem
            .getByRole("link", { name: secondName, exact: true })
            .boundingBox();

        // A newly opened file must append, not jump above files opened earlier.
        expect(secondLinkBox?.y ?? 0).toBeGreaterThan(
            (
                await firstItem
                    .getByRole("link", { name: firstName, exact: true })
                    .boundingBox()
            )?.y ?? 1,
        );

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves order lives in user state rather than local storage.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                openFiles: [
                    {
                        agentId: ctx.agentId,
                        path: firstPath,
                        name: firstName,
                        agentName: ctx.agentName,
                    },
                    {
                        agentId: ctx.agentId,
                        path: secondPath,
                        name: secondName,
                        agentName: ctx.agentName,
                    },
                ],
            });

        const backgroundTabs = await BackgroundTabs.watch(browser);
        await firstItem
            .getByRole("link", { name: firstName, exact: true })
            .click({ button: "middle" });
        // Middle-click must open the destination while preserving both open files and the current page.
        await expect
            .poll(() => backgroundTabs.urls())
            .toEqual([
                `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(firstPath)}`,
            ]);
        await backgroundTabs.close();
        await expect(
            openFiles.getByRole("link", { name: firstName, exact: true }),
        ).toBeVisible();
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(secondPath)}`,
        );
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                openFiles: [{ path: firstPath }, { path: secondPath }],
            });

        await secondItem
            .getByRole("link", { name: secondName, exact: true })
            .click();
        // The sidebar entry must open that exact open path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(secondPath)}`,
        );

        await applicationNavigation
            .getByRole("button", { name: "Close all open files" })
            .click();
        // Clear must remove the whole list, not only the open file.
        await expect(openFiles).toHaveCount(0);
        // The emptied section stays and says how to open files again, since they are the column's content.
        await expect(
            applicationNavigation.getByText(
                "No open files — edit or double-click a file in the editor to list it here",
            ),
        ).toBeVisible();
    });

    test("opens the application menu over the full-window editor to switch open files", async ({
        page,
    }) => {
        const firstUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`;
        const secondUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`;
        await page.goto(firstUrl);
        await keepOpen(page);
        await page.goto(secondUrl);
        await keepOpen(page);
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        const panel = page.getByRole("article", { name: "Editing panel" });

        const openMenu = panel.getByRole("button", {
            name: "Open application menu",
        });

        // The editor overlay covers the sidebar, so its header button must reopen the menu.
        await openMenu.click();

        const drawer = page.getByRole("dialog", { name: "Application menu" });
        const openFiles = drawer.getByRole("list", { name: "Open files" });

        const firstLink = openFiles.getByRole("link", {
            name: "file1.txt",
            exact: true,
        });

        const secondLink = openFiles.getByRole("link", {
            name: "file2.txt",
            exact: true,
        });

        await expect(firstLink).toBeVisible();
        await expect(secondLink).toBeVisible();

        await firstLink.click();
        // Navigating must replace the file content while retaining the full-window presentation.
        await expect(page).toHaveURL(`${firstUrl}?fullWindow=true`);
        await expect(
            panel.getByLabel("File editor", { exact: true }),
        ).toHaveText("content1");
        // Choosing a file dismisses the menu so the editor is unobstructed again.
        await expect(drawer).toBeHidden();
        await expect(panel).toHaveCSS("position", "fixed");

        await openMenu.click();
        await expect(drawer).toBeVisible();
        // The menu marks the file the editor is showing as the current one.
        await expect(
            drawer.getByRole("link", { name: "file1.txt", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await drawer
            .getByRole("link", { name: "file2.txt", exact: true })
            .click();
        // Switching back proves the menu still reaches every open file after navigation.
        await expect(page).toHaveURL(`${secondUrl}?fullWindow=true`);
        await expect(
            panel.getByLabel("File editor", { exact: true }),
        ).toHaveText("content2");
        await expect(panel).toHaveCSS("position", "fixed");

        await panel
            .getByRole("button", { name: "Restore editor size" })
            .click();
        // Restoring the editor returns open navigation to the normal sidebar presentation.
        await expect(panel).toHaveCSS("position", "static");
        await expect(drawer).toBeHidden();
    });

    test("opens full-window open files in background tabs and closes them from the menu", async ({
        page,
        browser,
    }) => {
        const firstUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`;
        const secondUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`;
        await page.goto(firstUrl);
        await keepOpen(page);
        await page.goto(secondUrl);
        await keepOpen(page);
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        const panel = page.getByRole("article", { name: "Editing panel" });

        await panel
            .getByRole("button", { name: "Open application menu" })
            .click();

        const drawer = page.getByRole("dialog", { name: "Application menu" });
        const openFiles = drawer.getByRole("list", { name: "Open files" });

        const backgroundTabs = await BackgroundTabs.watch(browser);
        await openFiles
            .getByRole("link", { name: "file1.txt", exact: true })
            .click({ button: "middle" });
        // Native navigation must open the file in its own tab and leave the menu and the
        // expanded editor on the original page intact.
        await expect
            .poll(() => backgroundTabs.urls())
            .toEqual([`${firstUrl}?fullWindow=true`]);
        await backgroundTabs.close();
        await expect(drawer).toBeVisible();
        await expect(
            openFiles.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(page).toHaveURL(`${secondUrl}?fullWindow=true`);
        await expect(panel).toHaveCSS("position", "fixed");
        await openFiles
            .getByRole("button", {
                name: "Close open file file1.txt",
                exact: true,
            })
            .click();
        // The explicit close button remains the way to remove an inactive open file.
        await expect(
            openFiles.getByRole("link", { name: "file1.txt", exact: true }),
        ).toHaveCount(0);

        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();

        const editor = panel.getByLabel("File editor", { exact: true });
        await editor.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" draft");

        await panel
            .getByRole("button", { name: "Open application menu" })
            .click();
        await openFiles
            .getByRole("button", {
                name: "Close open file file2.txt",
                exact: true,
            })
            .click();

        const confirmation = page.getByRole("dialog", {
            name: "Discard unsaved changes?",
        });

        // Closing a file with unsaved edits discards them, so it asks first.
        await expect(confirmation).toBeVisible();
        await confirmation
            .getByRole("button", { name: "Discard changes" })
            .click();
        // Confirming closes the file and its editor falls back to the device text.
        await expect(
            drawer.getByText(
                "No open files — edit or double-click a file in the editor to list it here",
            ),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        await expect(editor).toHaveText("content2");
        // The editor stays on the file and keeps the expanded presentation.
        await expect(page).toHaveURL(`${secondUrl}?fullWindow=true`);
        await expect(panel).toHaveCSS("position", "fixed");
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Both close buttons must persist removal in the shared user state.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ openFiles: [] });
    });

    test("opens a file on its first edit or a double click and asks before closing it with unsaved edits", async ({
        page,
    }) => {
        const fileName = "file1.txt";
        const filePath = path.join(ctx.testDirPath, fileName);

        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const openFiles = applicationNavigation.getByRole("list", {
            name: "Open files",
        });

        // Viewing a file in the editor must not open a file that has not been changed.
        await expect(openFiles).toHaveCount(0);

        const editor = page.getByLabel("File editor", { exact: true });
        await editor.click();
        await page.keyboard.type("x");
        // The first change away from the saved text opens the file without using the button.
        await expect(
            openFiles.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        const row = openFiles.getByRole("listitem", {
            name: `Open file ${fileName} on ${ctx.agentName}`,
        });

        const confirmation = page.getByRole("dialog", {
            name: "Discard unsaved changes?",
        });

        await row
            .getByRole("button", { name: `Close open file ${fileName}` })
            .click();
        // Unsaved edits are only ever discarded after this confirmation.
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("button", { name: "Cancel" }).click();
        // Cancelling keeps both the open file and its unsaved text.
        await expect(row).toBeVisible();
        await expect(editor).toContainText("x");

        await row
            .getByRole("button", { name: `Close open file ${fileName}` })
            .click();
        await confirmation
            .getByRole("button", { name: "Discard changes" })
            .click();
        // Discarding closes the file and restores the device text.
        await expect(openFiles).toHaveCount(0);
        await expect(editor).toHaveText("content1");

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // The server forgets the buffer of the closed file, so the draft cannot come back.
        await expect
            .poll(
                async () =>
                    (await api.getEditorBuffer(`${ctx.agentId}:${filePath}`))
                        .buffer,
            )
            .toBeNull();

        await editor.click();
        await page.keyboard.type("y");
        // A new edit opens the file again, since editing is what keeps a file open.
        await expect(
            openFiles.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        await row
            .getByRole("button", { name: `Close open file ${fileName}` })
            .click();
        await confirmation
            .getByRole("button", { name: "Discard changes" })
            .click();
        await expect(openFiles).toHaveCount(0);

        await page.getByRole("region", { name: "Editor viewport" }).dblclick();
        // A double click opens the file without editing it.
        await expect(row).toBeVisible();
        // The double click only selects a word, so the device text stays unchanged.
        await expect(editor).toHaveText("content1");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();

        await row
            .getByRole("button", { name: `Close open file ${fileName}` })
            .click();
        // A clean file closes at once, without a confirmation.
        await expect(openFiles).toHaveCount(0);
        await expect(confirmation).toBeHidden();
    });

    test("reorders sidebar open files by insertion and restores that order over the full-window editor", async ({
        page,
        browser,
    }) => {
        const names = ["file1.txt", "file2.txt", "file3.txt"];
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                openFiles: names.map((name) => ({
                    agentId: ctx.agentId,
                    path: path.join(ctx.testDirPath, name),
                    name,
                    agentName: ctx.agentName,
                })),
                deviceOrder: [],
            },
        });
        await page.goto(`${WEB_BASE_URL}/`);

        const openFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });

        const links = openFiles.getByRole("link");

        const linkNames = () =>
            links.evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("aria-label")),
            );

        // Three entries prove insertion shifts the middle item instead of swapopen fileg two.
        await expect.poll(linkNames).toEqual(names);

        const lastHandle = openFiles.getByRole("listitem", {
            name: `Open file file3.txt on ${ctx.agentName}`,
        });

        await lastHandle.focus();
        // The row itself is the keyboard sorting surface, with no separate grip button.
        await expect(lastHandle).toHaveAttribute(
            "aria-roledescription",
            "sortable",
        );
        await expect(
            lastHandle.getByRole("button", { name: /Reorder/ }),
        ).toHaveCount(0);
        await dragReorderRow(page, lastHandle, links.first());
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
        await expect(page).toHaveURL(`${WEB_BASE_URL}/`);
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                openFiles: [
                    {
                        name: "file3.txt",
                        path: path.join(ctx.testDirPath, "file3.txt"),
                    },
                    {
                        name: "file1.txt",
                        path: path.join(ctx.testDirPath, "file1.txt"),
                    },
                    {
                        name: "file2.txt",
                        path: path.join(ctx.testDirPath, "file2.txt"),
                    },
                ],
            });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`,
        );
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        const panel = page.getByRole("article", { name: "Editing panel" });
        await panel
            .getByRole("button", { name: "Open application menu" })
            .click();

        // The menu over the editor reads the same account order as the sidebar.
        await expect
            .poll(() =>
                page
                    .getByRole("dialog", { name: "Application menu" })
                    .getByRole("list", { name: "Open files" })
                    .getByRole("link")
                    .evaluateAll((elements) =>
                        elements.map((element) =>
                            element.getAttribute("aria-label"),
                        ),
                    ),
            )
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);

        await page.reload();
        // Full-window mode is local, so reload restores the shared order in the sidebar.
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
        const fresh = await browser.newPage();
        await fresh.goto(`${WEB_BASE_URL}/`);
        await expect
            .poll(() =>
                fresh
                    .getByRole("navigation", { name: "Application" })
                    .getByRole("list", { name: "Open files" })
                    .getByRole("link")
                    .evaluateAll((elements) =>
                        elements.map((element) =>
                            element.getAttribute("aria-label"),
                        ),
                    ),
            )
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
        await fresh.close();
    });

    test("reorders open files from the keyboard and cancels without writing", async ({
        page,
    }) => {
        const names = ["file1.txt", "file2.txt", "file3.txt"];
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                openFiles: names.map((name) => ({
                    agentId: ctx.agentId,
                    path: path.join(ctx.testDirPath, name),
                    name,
                    agentName: ctx.agentName,
                })),
            },
        });
        await page.goto(`${WEB_BASE_URL}/`);

        const openFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });

        const handle = openFiles.getByRole("listitem", {
            name: `Open file file3.txt on ${ctx.agentName}`,
        });

        let puts = 0;
        page.on("request", (request) => {
            if (
                request.method() === "PUT" &&
                request.url().includes("/api/v1/user/state")
            ) {
                puts += 1;
            }
        });
        await handle.focus();
        await page.keyboard.press("Space");
        await expect(handle).toHaveAttribute("data-dragging", "true");
        await expect(
            page.getByLabel("Open files reorder announcement"),
        ).toContainText("Picked up file3.txt");
        await waitForKeyboardSensor(page);
        await page.keyboard.press("Escape");
        await expect(handle).toHaveAttribute("data-dragging", "false");
        await expect(handle).toBeFocused();

        const linkNames = () =>
            openFiles
                .getByRole("link")
                .evaluateAll((elements) =>
                    elements.map((element) =>
                        element.getAttribute("aria-label"),
                    ),
                );

        await expect.poll(linkNames).toEqual(names);
        expect(puts).toBe(0);

        const reorderPersisted = page.waitForResponse(
            (response) =>
                response.request().method() === "PUT" &&
                response.url().includes("/api/v1/user/state"),
        );

        await keyboardReorder(page, handle, { key: "ArrowUp", times: 2 });
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
        await expect(handle).toBeFocused();
        // The new order paints before its background write lands, and the page.goto() below
        // would abort a write still in flight and reload the old order.
        await reorderPersisted;
        const editor = page.getByLabel("File editor", { exact: true });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`,
        );
        await editor.click();
        await page.keyboard.press("ArrowUp");
        // Editor arrows must type or move the caret, not reorder open files.
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
    });
    test("removes the open file and the selection of a file deleted from its details view", async ({
        page,
    }) => {
        const fileName = `delete-pinned-${Date.now()}.txt`;
        const filePath = path.join(ctx.testDirPath, fileName);
        await fs.writeFile(filePath, "pinned, selected, then deleted");

        const openFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        await page.getByRole("region", { name: "Editor viewport" }).dblclick();
        // The sidebar entry proves the file is open before the delete starts.
        await expect(
            openFiles.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        await page
            .getByLabel("File view")
            .getByRole("link", { name: "Details", exact: true })
            .click();
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: "Select", exact: true })
            .click();
        // The drawer count proves the file is selected before the delete starts.
        await expect(
            page.getByRole("tab", { name: "Selected 1" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "More", exact: true }).click();
        await page
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        const confirmation = page.getByRole("dialog", {
            name: "Delete this file?",
        });

        const permanently = confirmation.getByRole("checkbox", {
            name: "Delete permanently",
        });

        // Targets that cannot be trashed delete permanently without offering the choice.
        if ((await permanently.count()) > 0) {
            await permanently.click();
        }

        await confirmation
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        // Leaving for the parent directory shows the delete finished.
        await expect(page).toHaveURL(
            new RegExp(`/browser/${encodeFilesystemPath(ctx.testDirPath)}$`),
        );
        await expect(fs.stat(filePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
        // A deleted file must not stay in the sidebar, where its link would lead to a missing path.
        await expect(
            openFiles.getByRole("link", { name: fileName, exact: true }),
        ).toHaveCount(0);
        // A deleted file must not stay selected, where Copy or Move would act on a missing source.
        await expect(
            page.getByRole("tab", { name: "Selected 0" }),
        ).toBeVisible();

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // The server's copy proves the close was persisted, not only hidden from the sidebar.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ openFiles: [] });
    });

    /** Reads the document of a file's buffer as stored on the server, or null without one. */
    async function storedDocument(filePath: string) {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const stored = parseStoredBuffer(
            await api.getEditorBuffer(`${ctx.agentId}:${filePath}`),
        );

        return stored === null ? null : String(stored.data.state.doc);
    }

    /** Reads where the stored buffer was scrolled, as another computer would restore it. */
    async function storedScrollAnchor(filePath: string) {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const stored = parseStoredBuffer(
            await api.getEditorBuffer(`${ctx.agentId}:${filePath}`),
        );

        return stored?.data.scroll?.anchor ?? null;
    }

    /** Writes a tall file, so restoring the scroll position is observable. */
    async function writeTallFile(name: string, prefix: string) {
        const filePath = path.join(ctx.testDirPath, name);

        await fs.writeFile(
            filePath,
            Array.from(
                { length: 300 },
                (_, index) => `${prefix} line ${index + 1}`,
            ).join("\n"),
        );

        return filePath;
    }

    test("restores caret, selection, scroll and undo of each open file when switching", async ({
        page,
    }) => {
        const firstPath = await writeTallFile("switch-a.txt", "alpha");
        const secondPath = await writeTallFile("switch-b.txt", "beta");
        const firstUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(firstPath)}`;
        const editor = page.getByLabel("File editor", { exact: true });
        const caretLine = page.getByLabel("Editor caret line");
        const selectedText = page.getByLabel("Editor selected text");

        const openFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });

        await page.goto(firstUrl);
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" first");
        await page.keyboard.press("Shift+Home");
        // The edit opens the file and the selection covers the edited last line.
        await expect(selectedText).toHaveText("alpha line 300 first");
        await expect(
            openFiles.getByRole("link", { name: "switch-a.txt", exact: true }),
        ).toBeVisible();

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(secondPath)}`,
        );
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.type("second ");
        // The other file has its own caret near the top.
        await expect(caretLine).toHaveText("1");

        await openFiles
            .getByRole("link", { name: "switch-a.txt", exact: true })
            .click();
        // Switching back restores the selection and caret of the first file.
        await expect(selectedText).toHaveText("alpha line 300 first");
        await expect(caretLine).toHaveText("300");
        // The first file comes back scrolled to where it was, at its end.
        await expect(
            editor.getByText("alpha line 300 first", { exact: true }),
        ).toBeInViewport();

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+z");
        // Undo reverts the first file's own edit.
        await expect(editor).not.toContainText("first");
        await expect(editor).not.toContainText("second");

        await openFiles
            .getByRole("link", { name: "switch-b.txt", exact: true })
            .click();
        // The second file kept its edit, which undo in the first file must not touch.
        await expect(editor).toContainText("second beta line 1");
        await expect(caretLine).toHaveText("1");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+z");
        // The second file has its own undo history.
        await expect(editor).not.toContainText("second");
        // Its undo also makes the buffer clean again.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
    });

    test("writes the scroll position of a file switched away from when the page is hidden", async ({
        page,
    }) => {
        const firstPath = await writeTallFile("scroll-a.txt", "delta");
        const secondPath = await writeTallFile("scroll-b.txt", "epsilon");
        const editor = page.getByLabel("File editor", { exact: true });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(secondPath)}`,
        );
        await keepOpen(page);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(firstPath)}`,
        );
        await keepOpen(page);

        await editor.hover();
        await page.mouse.wheel(0, 10000);
        // Scrolling alone moves the view but writes nothing yet.
        await expect(
            editor.getByText("delta line 300", { exact: true }),
        ).toBeInViewport();

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" })
            .getByRole("link", { name: "scroll-b.txt", exact: true })
            .click();
        await expect(editor).toContainText("epsilon line 1");
        await page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pagehide")),
        );
        // The file no longer shown still gets its scroll written, so another computer resumes there.
        await expect
            .poll(() => storedScrollAnchor(firstPath))
            .toBeGreaterThan(0);
    });

    test("keeps unsaved edits with their undo history across a reload and on another computer", async ({
        page,
        browser,
    }) => {
        const filePath = await writeTallFile("reload-draft.txt", "gamma");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        await page.goto(fileUrl);
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" unsaved");
        // The debounced write reaches the server before the page goes away.
        await expect
            .poll(() => storedDocument(filePath))
            .toContain("gamma line 300 unsaved");

        await page.reload();
        // The unsaved text survives the reload.
        await expect(editor).toContainText("gamma line 300 unsaved");
        // It is still unsaved, so it can be saved or undone.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        // The caret came back on the edited line.
        await expect(page.getByLabel("Editor caret line")).toHaveText("300");

        const other = await browser.newContext({
            storageState: ".test-playwright-auth.json",
        });

        const otherPage = await other.newPage();
        await otherPage.goto(fileUrl);
        // Another computer continues with the same unsaved buffer.
        await expect(
            otherPage.getByLabel("File editor", { exact: true }),
        ).toContainText("gamma line 300 unsaved");
        // The caret follows, so the user picks up exactly where they left off.
        await expect(otherPage.getByLabel("Editor caret line")).toHaveText(
            "300",
        );
        await other.close();

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+z");
        // The undo history survived the reload too.
        await expect(editor).not.toContainText("unsaved");
        // Undoing to the device text leaves nothing to save.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        // The device file was never written.
        expect(await fs.readFile(filePath, "utf8")).not.toContain("unsaved");
    });

    test("dismisses the device change warning when the user keeps their edits", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "device-changed-keep.txt");
        await fs.writeFile(filePath, "device original");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        const banner = page.getByRole("alert", {
            name: "File changed on device",
        });

        await page.goto(fileUrl);
        await expect(editor).toHaveText("device original");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" browser");
        // The edit's own write lands first, so the write awaited below is the kept decision.
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device original browser");

        await fs.writeFile(filePath, "device rewrote this");
        await simulateTabRefocus(page);
        await expect(banner).toBeVisible();

        const keptPersisted = page.waitForResponse(
            (response) =>
                response.request().method() === "PUT" &&
                response.url().includes("/api/v1/user/editor-buffers/"),
        );

        await banner.getByRole("button", { name: "Keep my changes" }).click();
        // Keeping dismisses the warning while the browser edits stay unsaved.
        await expect(banner).toBeHidden();
        await expect(editor).toHaveText("device original browser");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        // Reloading before the write lands would read the old base and warn again.
        await keptPersisted;
        await page.reload();
        // The decision is stored with the buffer, so a reload does not bring the warning back.
        await expect(editor).toHaveText("device original browser");
        await expect(banner).toBeHidden();
    });

    test("keeps unsaved edits over a device change until the user discards them", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "device-changed.txt");
        await fs.writeFile(filePath, "device original");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        const banner = page.getByRole("alert", {
            name: "File changed on device",
        });

        await page.goto(fileUrl);
        await expect(editor).toHaveText("device original");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" browser");
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device original browser");

        await fs.writeFile(filePath, "device rewrote this");
        await simulateTabRefocus(page);
        // The device change is reported while the browser edits stay on screen.
        await expect(banner).toBeVisible();
        await expect(editor).toHaveText("device original browser");

        await page.reload();
        // After a reload the stored buffer still wins and the warning comes back.
        await expect(editor).toHaveText("device original browser");
        await expect(banner).toBeVisible();

        await banner
            .getByRole("button", { name: "Discard my changes" })
            .click();
        // Discarding loads the device version and leaves nothing unsaved.
        await expect(editor).toHaveText("device rewrote this");
        await expect(banner).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        // The discarded buffer is written back, so another reload shows the device text.
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device rewrote this");
    });
});
