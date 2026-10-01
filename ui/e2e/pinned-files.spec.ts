import path from "node:path";
import { expect, test } from "@playwright/test";

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
});
