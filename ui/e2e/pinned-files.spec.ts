import path from "node:path";
import { expect, test } from "@playwright/test";
import {
    dragReorderRow,
    keyboardReorder,
    waitForKeyboardSensor,
} from "./reorder";

import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Pinned files", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("pinned-files");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async () => {
        await resetPinnedFileState();
    });

    test.afterEach(async () => {
        await resetPinnedFileState();
    });

    async function resetPinnedFileState() {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Editor tests pin on first edit, so this file must not inherit that shared list.
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                pinnedFiles: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
                deviceOrder: [],
            },
        });
    }

    test("pins editor files under Transfers and keeps newer pins at the bottom", async ({
        page,
    }) => {
        const firstName = "file1.txt";
        const secondName = "file2.txt";
        const firstPath = path.join(ctx.testDirPath, firstName);
        const secondPath = path.join(ctx.testDirPath, secondName);
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(firstPath)}`,
        );

        const saveButton = page.getByRole("button", { name: "Save file" });
        const pinButton = page.getByRole("button", {
            name: "Pin file",
            exact: true,
        });
        const saveBox = await saveButton.boundingBox();
        const pinBox = await pinButton.boundingBox();
        // The pin control must sit immediately after save, not among later editor tools.
        expect(pinBox?.x ?? 0).toBeGreaterThan(saveBox?.x ?? 1);
        await pinButton.click();

        const pinnedFiles = applicationNavigation.getByRole("list", {
            name: "Pinned files",
        });
        const firstItem = pinnedFiles.getByRole("listitem").filter({
            hasText: firstName,
        });
        // The left menu must show the pin below Transfers, not in the device sidebar.
        await expect(
            firstItem.getByRole("link", { name: firstName, exact: true }),
        ).toBeVisible();
        const transfersBox = await applicationNavigation
            .getByRole("link", { name: "Transfers" })
            .boundingBox();
        const firstLinkBox = await firstItem
            .getByRole("link", { name: firstName, exact: true })
            .boundingBox();
        expect(firstLinkBox?.y ?? 0).toBeGreaterThan(transfersBox?.y ?? 1);

        const deviceLabel = firstItem.getByText(ctx.agentName, { exact: true });
        // Operators need the owning device under the file name, in a smaller face.
        await expect(deviceLabel).toBeVisible();
        const deviceBox = await deviceLabel.boundingBox();
        expect(deviceBox?.y ?? 0).toBeGreaterThan(firstLinkBox?.y ?? 1);
        const deviceFontSize = await deviceLabel.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize),
        );
        const fileFontSize = await firstItem
            .getByText(firstName, { exact: true })
            .evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).fontSize),
            );
        expect(deviceFontSize).toBeLessThan(fileFontSize);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(secondPath)}`,
        );
        await page
            .getByRole("button", { name: "Pin file", exact: true })
            .click();

        const secondItem = pinnedFiles.getByRole("listitem").filter({
            hasText: secondName,
        });
        const secondLinkBox = await secondItem
            .getByRole("link", { name: secondName, exact: true })
            .boundingBox();
        // A newly pinned file must append, not jump above files pinned earlier.
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
                pinnedFiles: [
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

        await firstItem
            .getByRole("button", { name: "Remove pinned file" })
            .click();
        // Removing one pin must leave the later pin in place.
        await expect(
            pinnedFiles.getByRole("link", { name: firstName, exact: true }),
        ).toHaveCount(0);
        await expect(
            secondItem.getByRole("link", { name: secondName, exact: true }),
        ).toBeVisible();

        await secondItem
            .getByRole("link", { name: secondName, exact: true })
            .click();
        // The sidebar entry must open that exact pinned path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(secondPath)}`,
        );

        await applicationNavigation
            .getByRole("button", { name: "Clear all pinned files" })
            .click();
        // Clear must remove the whole list, not only the open file.
        await expect(pinnedFiles).toHaveCount(0);
    });

    test("switches pinned files above the toolbar while keeping the editor full window", async ({
        page,
    }) => {
        const firstUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`;
        const secondUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`;
        await page.goto(firstUrl);
        await page
            .getByRole("button", { name: "Pin file", exact: true })
            .click();
        await page.goto(secondUrl);
        await page
            .getByRole("button", { name: "Pin file", exact: true })
            .click();
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        const panel = page.getByRole("article", { name: "Editing panel" });
        const pins = panel.getByRole("navigation", {
            name: "Editor pinned files",
        });
        const firstLink = pins.getByRole("link", {
            name: "file1.txt",
            exact: true,
        });
        const secondLink = pins.getByRole("link", {
            name: "file2.txt",
            exact: true,
        });
        // Both destinations must be visible on a single row above the editing actions.
        await expect(firstLink).toBeVisible();
        await expect(secondLink).toBeVisible();
        const firstBox = await firstLink.boundingBox();
        const secondBox = await secondLink.boundingBox();
        const saveBox = await panel
            .getByRole("button", { name: "Save file" })
            .boundingBox();
        if (!firstBox || !secondBox || !saveBox) {
            throw new Error("Expected pinned row and toolbar measurements");
        }
        expect(firstBox.y).toBe(secondBox.y);
        expect(secondBox.x).toBeGreaterThan(firstBox.x);
        expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(saveBox.y);

        await firstLink.click();
        // Navigating must replace the file content while retaining the full-window presentation.
        await expect(page).toHaveURL(firstUrl);
        await expect(panel.getByLabel("File editor")).toHaveText("content1");
        await expect(firstLink).toHaveAttribute("aria-current", "page");
        await expect(panel).toHaveCSS("position", "fixed");
        await expect(
            panel.getByRole("button", { name: "Restore editor size" }),
        ).toBeVisible();

        await secondLink.click();
        // Switching back proves the row remains usable after the keyed editor remounts.
        await expect(page).toHaveURL(secondUrl);
        await expect(panel.getByLabel("File editor")).toHaveText("content2");
        await expect(secondLink).toHaveAttribute("aria-current", "page");
        await expect(panel).toHaveCSS("position", "fixed");
        await panel
            .getByRole("button", { name: "Restore editor size" })
            .click();
        // Restoring the editor returns pinned navigation to the normal sidebar presentation.
        await expect(panel).toHaveCSS("position", "static");
        await expect(pins).toHaveCount(0);
    });

    test("closes full-window pins with the close button and middle click", async ({
        page,
    }) => {
        const firstUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`;
        const secondUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`;
        await page.goto(firstUrl);
        await page
            .getByRole("button", { name: "Pin file", exact: true })
            .click();
        await page.goto(secondUrl);
        await page
            .getByRole("button", { name: "Pin file", exact: true })
            .click();
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();

        const panel = page.getByRole("article", { name: "Editing panel" });
        const pins = panel.getByRole("navigation", {
            name: "Editor pinned files",
        });
        await pins
            .getByRole("link", { name: "file1.txt", exact: true })
            .click({ button: "middle" });
        // Middle-click must unpin the destination without navigating or opening another browser tab.
        await expect(
            pins.getByRole("link", { name: "file1.txt", exact: true }),
        ).toHaveCount(0);
        await expect(page).toHaveURL(secondUrl);
        expect(page.context().pages()).toHaveLength(1);
        await expect(panel).toHaveCSS("position", "fixed");

        const editor = panel.getByLabel("File editor");
        await editor.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" draft");
        await pins
            .getByRole("button", {
                name: "Close pinned file file2.txt",
                exact: true,
            })
            .click();
        // Closing the active pin must preserve its unsaved contents and expanded editor.
        await expect(pins).toHaveCount(0);
        await expect(editor).toHaveText("content2 draft");
        await expect(page).toHaveURL(secondUrl);
        await expect(panel).toHaveCSS("position", "fixed");
        await expect(
            panel.getByRole("button", { name: "Pin file", exact: true }),
        ).toBeVisible();
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Both closing gestures must persist removal in the shared user state.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ pinnedFiles: [] });
    });

    test("pins a file on its first edit and explains that in the pin tooltip", async ({
        page,
    }) => {
        const fileName = "file1.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const pinnedFiles = applicationNavigation.getByRole("list", {
            name: "Pinned files",
        });
        // Opening the editor must not pin a file that has not been changed.
        await expect(pinnedFiles).toHaveCount(0);

        const pinButton = page.getByRole("button", {
            name: "Pin file",
            exact: true,
        });
        await pinButton.hover();
        // The tooltip must explain auto-pin without replacing the button's accessible name.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Pin file. A file is pinned automatically the first time it is edited.",
        );

        const editor = page.getByLabel("File editor");
        await editor.click();
        await page.keyboard.type("x");
        // The first change away from the saved text pins the file without using the button.
        await expect(
            pinnedFiles.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Unpin file" }).click();
        await editor.click();
        await page.keyboard.type("y");
        // Later keystrokes in the same edit must not put back a pin the operator removed.
        await expect(pinnedFiles).toHaveCount(0);
    });

    test("reorders sidebar pins by insertion and restores that order in the editor", async ({
        page,
        browser,
    }) => {
        const names = ["file1.txt", "file2.txt", "file3.txt"];
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                pinnedFiles: names.map((name) => ({
                    agentId: ctx.agentId,
                    path: path.join(ctx.testDirPath, name),
                    name,
                    agentName: ctx.agentName,
                })),
                deviceOrder: [],
            },
        });
        await page.goto(`${WEB_BASE_URL}/`);
        const pinnedFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Pinned files" });
        const links = pinnedFiles.getByRole("link");
        const linkNames = () =>
            links.evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("aria-label")),
            );
        // Three entries prove insertion shifts the middle item instead of swapping two.
        await expect.poll(linkNames).toEqual(names);
        const lastHandle = pinnedFiles.getByRole("listitem", {
            name: `Pinned file file3.txt on ${ctx.agentName}`,
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
                pinnedFiles: [
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`,
        );
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();
        const editorPins = page
            .getByRole("article", { name: "Editing panel" })
            .getByRole("navigation", { name: "Editor pinned files" });
        // The editor strip reads the same account order as the sidebar.
        await expect(editorPins.getByRole("link")).toHaveText([
            "file3.txt",
            "file1.txt",
            "file2.txt",
        ]);

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
                    .getByRole("list", { name: "Pinned files" })
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

    test("reorders editor pins horizontally without resetting the draft", async ({
        page,
    }) => {
        const names = ["file1.txt", "file2.txt", "file3.txt"];
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                pinnedFiles: names.map((name) => ({
                    agentId: ctx.agentId,
                    path: path.join(ctx.testDirPath, name),
                    name,
                    agentName: ctx.agentName,
                })),
            },
        });
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`;
        await page.goto(fileUrl);
        const panel = page.getByRole("article", { name: "Editing panel" });
        const editor = panel.getByLabel("File editor");
        await editor.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" draft");
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .click();
        const pins = panel.getByRole("navigation", {
            name: "Editor pinned files",
        });
        await dragReorderRow(
            page,
            pins.getByRole("listitem", {
                name: `Pinned file file3.txt on ${ctx.agentName}`,
            }),
            pins.getByRole("link", { name: "file2.txt", exact: true }),
        );
        // The horizontal pointer move must insert the pin without navigating away from the draft.
        await expect(pins.getByRole("link")).toHaveText([
            "file1.txt",
            "file3.txt",
            "file2.txt",
        ]);
        await keyboardReorder(
            page,
            pins.getByRole("listitem", {
                name: `Pinned file file3.txt on ${ctx.agentName}`,
            }),
            { key: "ArrowRight", times: 1 },
        );
        await keyboardReorder(
            page,
            pins.getByRole("listitem", {
                name: `Pinned file file3.txt on ${ctx.agentName}`,
            }),
            { key: "ArrowLeft", times: 1 },
        );
        // Sorting must not navigate, exit full window, or drop the unsaved buffer.
        await expect(page).toHaveURL(fileUrl);
        await expect(panel).toHaveCSS("position", "fixed");
        await expect(editor).toHaveText("content1 draft");
        await expect(pins.getByRole("link")).toHaveText([
            "file1.txt",
            "file3.txt",
            "file2.txt",
        ]);
        await panel
            .getByRole("button", { name: "Restore editor size" })
            .click();
        await expect
            .poll(() =>
                page
                    .getByRole("navigation", { name: "Application" })
                    .getByRole("list", { name: "Pinned files" })
                    .getByRole("link")
                    .evaluateAll((elements) =>
                        elements.map((element) =>
                            element.getAttribute("aria-label"),
                        ),
                    ),
            )
            .toEqual(["file1.txt", "file3.txt", "file2.txt"]);
    });

    test("reorders pins from the keyboard and cancels without writing", async ({
        page,
    }) => {
        const names = ["file1.txt", "file2.txt", "file3.txt"];
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                pinnedFiles: names.map((name) => ({
                    agentId: ctx.agentId,
                    path: path.join(ctx.testDirPath, name),
                    name,
                    agentName: ctx.agentName,
                })),
            },
        });
        await page.goto(`${WEB_BASE_URL}/`);
        const pinnedFiles = page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Pinned files" });
        const handle = pinnedFiles.getByRole("listitem", {
            name: `Pinned file file3.txt on ${ctx.agentName}`,
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
            page.getByLabel("Pinned files reorder announcement"),
        ).toContainText("Picked up file3.txt");
        await waitForKeyboardSensor(page);
        await page.keyboard.press("Escape");
        await expect(handle).toHaveAttribute("data-dragging", "false");
        await expect(handle).toBeFocused();
        const linkNames = () =>
            pinnedFiles
                .getByRole("link")
                .evaluateAll((elements) =>
                    elements.map((element) =>
                        element.getAttribute("aria-label"),
                    ),
                );
        await expect.poll(linkNames).toEqual(names);
        expect(puts).toBe(0);

        await keyboardReorder(page, handle, { key: "ArrowUp", times: 2 });
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
        await expect(handle).toBeFocused();
        const editor = page.getByLabel("File editor");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`,
        );
        await editor.click();
        await page.keyboard.press("ArrowUp");
        // Editor arrows must type or move the caret, not reorder pins.
        await expect
            .poll(linkNames)
            .toEqual(["file3.txt", "file1.txt", "file2.txt"]);
    });
});
