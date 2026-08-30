import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Recent editor files", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("editor-recent-files");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should show recent editor files inline and in a mobile dialog", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const names = [
            "recent-a.txt",
            "recent-b.txt",
            "recent-c.txt",
            "recent-d.txt",
            "recent-e.txt",
            "recent-f.txt",
            "recent-g.txt",
            "recent-h.txt",
            "recent-i.txt",
            "recent-j.txt",
            "recent-k.txt",
            "recent-l.txt",
        ];
        await Promise.all(
            names.map((name) =>
                fs.writeFile(path.join(ctx.testDirPath, name), name),
            ),
        );
        const entries = names.slice(0, 11).map((name) => ({
            name,
            path: path.join(ctx.testDirPath, name),
        }));
        const otherAgentPath = path.join(ctx.agent2Home, "other-agent.txt");
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                recentEditorFilesByAgent: {
                    [ctx.agentId]: [...entries].reverse(),
                    [ctx.agent2Id]: [
                        { name: "other-agent.txt", path: otherAgentPath },
                    ],
                },
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
            },
        });

        const currentPath = path.join(ctx.testDirPath, "recent-l.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(currentPath)}`,
        );

        const inlineNames = names.slice(6, 11).reverse();
        for (const name of inlineNames) {
            // Ordinary desktop widths leave toolbar space to the primary editor actions.
            await expect(
                page.getByRole("link", {
                    name: `Open ${name} from recent files`,
                }),
            ).not.toBeVisible();
        }
        await expect(
            page.getByRole("link", {
                name: "Open recent-l.txt from recent files",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("link", {
                name: "Open recent-a.txt from recent files",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("link", {
                name: "Open recent-f.txt from recent files",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("link", {
                name: "Open other-agent.txt from recent files",
            }),
        ).toHaveCount(0);
        await page.setViewportSize({ width: 1600, height: 900 });
        for (const name of inlineNames) {
            // Only the largest breakpoint reveals the five compact inline links.
            await expect(
                page.getByRole("link", {
                    name: `Open ${name} from recent files`,
                }),
            ).toBeVisible();
        }
        await page.setViewportSize({ width: 1280, height: 800 });

        const recentFilesButton = page.getByRole("button", {
            name: "Recent files",
            exact: true,
        });
        await recentFilesButton.focus();
        await expect(page.getByRole("tooltip")).toHaveText("Recent files");
        await recentFilesButton.click();
        const dialog = page.getByRole("dialog", { name: "Recent files" });
        await expect(dialog).toBeVisible();
        // Desktop uses the non-native anchored overlay and focuses its panel, not Close.
        await expect(dialog).toHaveJSProperty("tagName", "DIV");
        const desktopPanel = dialog.locator(":scope > div");
        await expect(desktopPanel).toBeFocused();
        await expect(
            dialog.getByRole("button", { name: "Close recent files" }),
        ).not.toBeFocused();
        const buttonBox = await recentFilesButton.boundingBox();
        const panelBox = await desktopPanel.boundingBox();
        expect(buttonBox).not.toBeNull();
        expect(panelBox).not.toBeNull();
        if (buttonBox === null || panelBox === null) {
            throw new Error("expected recent files anchor measurements");
        }
        // The compact panel is end-aligned to the button that opened it.
        expect(
            Math.abs(
                panelBox.x + panelBox.width - (buttonBox.x + buttonBox.width),
            ),
        ).toBeLessThanOrEqual(1);
        await expect(dialog.getByRole("link")).toHaveCount(10);
        await expect(
            dialog.getByRole("link", {
                name: "Open recent-f.txt from recent files",
            }),
        ).toBeVisible();

        const newestRecentPath = path.join(ctx.testDirPath, "recent-k.txt");
        const newestRecentLink = dialog.getByRole("link", {
            name: "Open recent-k.txt from recent files",
        });
        await newestRecentLink.focus();
        // The tooltip exposes the absolute target even though the link only shows its filename.
        await expect(page.getByRole("tooltip")).toHaveText(newestRecentPath);

        await dialog
            .getByRole("button", {
                name: "Remove recent-k.txt from recent files",
            })
            .click();
        await expect(newestRecentLink).toHaveCount(0);
        const expectedPersistedFiles = [
            "recent-l.txt",
            "recent-j.txt",
            "recent-i.txt",
            "recent-h.txt",
            "recent-g.txt",
            "recent-f.txt",
            "recent-e.txt",
            "recent-d.txt",
            "recent-c.txt",
            "recent-b.txt",
        ].map((name) => ({ name, path: path.join(ctx.testDirPath, name) }));
        // Server readback proves history and removals use the account user-state document.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                recentEditorFilesByAgent: {
                    [ctx.agentId]: expectedPersistedFiles,
                    [ctx.agent2Id]: [
                        { name: "other-agent.txt", path: otherAgentPath },
                    ],
                },
            });

        await page.getByRole("button", { name: "Close recent files" }).click();
        await page.setViewportSize({ width: 360, height: 844 });
        const mobileRecentLink = page.getByRole("link", {
            name: "Open recent-j.txt from recent files",
        });
        // Compact links disappear on mobile while their launcher remains available.
        await expect(mobileRecentLink).not.toBeVisible();
        await expect(recentFilesButton).toBeVisible();
        await recentFilesButton.click();
        const mobileDialog = page.getByRole("dialog", {
            name: "Recent files",
        });
        // Mobile retains the centered native modal and still avoids focusing Close.
        await expect(mobileDialog).toHaveJSProperty("tagName", "DIALOG");
        await expect(mobileDialog.locator(":scope > div")).toBeFocused();
        await expect(
            mobileDialog.getByRole("link", {
                name: "Open recent-j.txt from recent files",
            }),
        ).toBeVisible();
    });
});
