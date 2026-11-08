// Serial: replaces the shared user settings to seed bookmarks and asserts on the saved list.
import { test, expect } from "../fixtures";
import path from "node:path";
import { BackgroundTabs } from "../background-tabs";
import { dragReorderRow } from "../reorder";
import { ApiClient } from "#ui/api-client";
import {
    setupTestDir,
    teardownTestDir,
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    type TestContext,
} from "../helpers";

test.describe.serial("Bookmarks", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("bookmarks");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later browser tests assume the default user preferences.
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
                deviceOrder: [],
            },
        });
    });

    for (const presentation of ["sidebar", "drawer"] as const) {
        test(`folds individual and all device bookmarks in the ${presentation}`, async ({
            page,
        }) => {
            const api = new ApiClient(API_BASE_URL);
            await api.login("test-user", "test-password");

            const bookmarks = [
                {
                    agentId: ctx.agentId,
                    path: ctx.testDirPath,
                    name: "first-home",
                    entryType: "directory" as const,
                },
                {
                    agentId: ctx.agent2Id,
                    path: ctx.agent2Home,
                    name: "second-home",
                    entryType: "directory" as const,
                },
            ];

            await api.updateUserState({ state: { bookmarks } });

            if (presentation === "drawer") {
                await page.setViewportSize({ width: 390, height: 844 });
            }

            await page.goto(`${WEB_BASE_URL}/`);

            if (presentation === "drawer") {
                await page
                    .getByRole("button", {
                        name: "Open device menu",
                        exact: true,
                    })
                    .click();
            }

            const menu =
                presentation === "drawer"
                    ? page.getByRole("dialog", { name: "Device menu" })
                    : page.getByRole("complementary", { name: "Device menu" });

            const firstList = menu.getByRole("list", {
                name: `${ctx.agentName} bookmarks`,
            });

            const secondList = menu.getByRole("list", {
                name: "agent2_custom bookmarks",
            });

            // Individual folding hides only that device's paths and advertises its state.
            await menu
                .getByRole("button", {
                    name: `Fold bookmarks for ${ctx.agentName}`,
                    exact: true,
                })
                .click();
            await expect(firstList).toHaveCount(0);
            await expect(secondList).toBeVisible();
            await expect(
                menu.getByRole("button", {
                    name: `Unfold bookmarks for ${ctx.agentName}`,
                    exact: true,
                }),
            ).toHaveAttribute("aria-expanded", "false");

            // The shared control folds the remaining open group even in a mixed state.
            await menu
                .getByRole("button", {
                    name: "Fold all bookmarks",
                    exact: true,
                })
                .click();
            await expect(firstList).toHaveCount(0);
            await expect(secondList).toHaveCount(0);
            await page.reload();

            if (presentation === "drawer") {
                await page
                    .getByRole("button", {
                        name: "Open device menu",
                        exact: true,
                    })
                    .click();
            }

            // Reloading preserves the tab's folding choices without deleting saved bookmarks.
            await expect(
                menu.getByRole("button", {
                    name: "Unfold all bookmarks",
                    exact: true,
                }),
            ).toBeVisible();
            await expect(firstList).toHaveCount(0);
            await expect(secondList).toHaveCount(0);
            expect((await api.getUserState()).state).toMatchObject({
                bookmarks,
            });

            await menu
                .getByRole("button", {
                    name: "Unfold all bookmarks",
                    exact: true,
                })
                .click();
            // Expanding all restores both lists and the per-device control remains reversible.
            await expect(
                firstList.getByRole("link", {
                    name: "first-home",
                    exact: true,
                }),
            ).toBeVisible();
            await expect(
                secondList.getByRole("link", {
                    name: "second-home",
                    exact: true,
                }),
            ).toBeVisible();
            await menu
                .getByRole("button", {
                    name: `Fold bookmarks for ${ctx.agentName}`,
                    exact: true,
                })
                .click();
            await menu
                .getByRole("button", {
                    name: `Unfold bookmarks for ${ctx.agentName}`,
                    exact: true,
                })
                .click();
            await expect(firstList).toBeVisible();
        });
    }

    test("should bookmark a file from the list menu and persist it under its agent", async ({
        page,
        browser,
    }) => {
        const fileName = "file1.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        await page
            .getByRole("button", {
                name: `Actions for file ${fileName}`,
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: `Actions for file ${fileName}` })
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();

        const agentBookmarks = page.getByRole("list", {
            name: `${ctx.agentName} bookmarks`,
        });

        // The right panel must nest the bookmark under the agent that owns the path.
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("list", { name: "agent2_custom bookmarks" }),
        ).toHaveCount(0);

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Server readback proves the bookmark lives in user state rather than local storage.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                bookmarks: [
                    {
                        agentId: ctx.agentId,
                        path: filePath,
                        name: fileName,
                        entryType: "file",
                    },
                ],
            });

        await agentBookmarks
            .getByRole("link", { name: fileName, exact: true })
            .click();
        // Clicking the sidebar entry must open that exact bookmarked path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.reload();
        // Reload must restore the bookmark from the server document.
        await expect(
            page
                .getByRole("list", { name: `${ctx.agentName} bookmarks` })
                .getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();
        const backgroundTabs = await BackgroundTabs.watch(browser);
        await agentBookmarks
            .getByRole("link", { name: fileName, exact: true })
            .click({ button: "middle" });
        // Middle-click must open the bookmarked destination without removing its saved entry.
        await expect
            .poll(() => backgroundTabs.urls())
            .toEqual([
                `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
            ]);
        await backgroundTabs.close();
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ bookmarks: [{ path: filePath }] });
    });

    test("should bookmark and remove a file from the file actions menu", async ({
        page,
    }) => {
        const fileName = "file2.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=details`,
        );

        await page.getByRole("button", { name: "More", exact: true }).click();
        await page
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();

        const agentBookmarks = page.getByRole("list", {
            name: `${ctx.agentName} bookmarks`,
        });

        // The details kebab must write the same user-state list as the file-row menu.
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        await page.getByRole("button", { name: "More", exact: true }).click();
        await page
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: "Remove bookmark", exact: true })
            .click();

        // The same menu item must toggle membership so operators can unbookmark in place.
        await expect(agentBookmarks).toHaveCount(0);
    });

    test("should bookmark and remove the open file from the editor options menu", async ({
        page,
    }) => {
        const fileName = "file1.txt";
        const filePath = path.join(ctx.testDirPath, fileName);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        // Bookmark belongs in the overflow menu so the toolbar stays focused on editing.
        await expect(
            page.getByRole("button", { name: "Bookmark", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Editor actions" }).click();

        const editorActions = page.getByRole("dialog", {
            name: "Editor actions",
        });

        await editorActions
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();

        const agentBookmarks = page.getByRole("list", {
            name: `${ctx.agentName} bookmarks`,
        });

        // The editor menu must add the same file represented by the details path menu.
        await expect(
            agentBookmarks.getByRole("link", { name: fileName, exact: true }),
        ).toBeVisible();

        // Selecting the action closes the menu, matching the details view workflow.
        await expect(editorActions).not.toBeVisible();
        await page.getByRole("button", { name: "Editor actions" }).click();
        await editorActions
            .getByRole("button", { name: "Remove bookmark", exact: true })
            .click();
        // Reopening the menu exposes the removal action for the bookmarked file.
        await expect(agentBookmarks).toHaveCount(0);
    });

    test("reorders one device's bookmarks without transferring ownership", async ({
        page,
    }) => {
        const thirdName = "file3.txt";

        const agent1Bookmarks = ["file1.txt", "file2.txt", thirdName].map(
            (name) => ({
                agentId: ctx.agentId,
                path: path.join(ctx.testDirPath, name),
                name,
                entryType: "file" as const,
            }),
        );

        const agent2Bookmarks = [
            {
                agentId: ctx.agent2Id,
                path: ctx.agent2Home,
                name: "agent2-home",
                entryType: "directory" as const,
            },
            {
                agentId: ctx.agent2Id,
                path: path.join(ctx.agent2Home, "nested"),
                name: "agent2-nested",
                entryType: "directory" as const,
            },
        ];

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                bookmarks: [
                    agent1Bookmarks[0],
                    agent2Bookmarks[0],
                    agent1Bookmarks[1],
                    agent2Bookmarks[1],
                    agent1Bookmarks[2],
                ],
                deviceOrder: [],
            },
        });
        await page.goto(`${WEB_BASE_URL}/`);
        const deviceList = page.getByRole("list", { name: "Device list" });

        const firstBookmarks = deviceList
            .getByRole("listitem", { name: `Device ${ctx.agentName}` })
            .getByRole("list", { name: `${ctx.agentName} bookmarks` });

        const secondBookmarks = deviceList
            .getByRole("listitem", { name: "Device agent2_custom" })
            .getByRole("list", { name: "agent2_custom bookmarks" });

        await expect(firstBookmarks.getByRole("link")).toHaveText([
            "file1.txt",
            "file2.txt",
            thirdName,
        ]);
        await expect(secondBookmarks.getByRole("link")).toHaveText([
            "agent2-home",
            "agent2-nested",
        ]);
        let puts = 0;
        page.on("request", (request) => {
            if (
                request.method() === "PUT" &&
                request.url().includes("/api/v1/user/state")
            ) {
                puts += 1;
            }
        });

        const handle = firstBookmarks.getByRole("listitem", {
            name: `Bookmark ${thirdName} on ${ctx.agentName}`,
        });

        const otherList = secondBookmarks;
        await page.mouse.move(0, 0);
        const start = await handle.boundingBox();
        const outside = await otherList.boundingBox();

        if (!start || !outside) {
            throw new Error("Expected bookmark lists to be visible");
        }

        await page.mouse.move(
            start.x + start.width / 2,
            start.y + start.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(outside.x + 8, outside.y + 8, { steps: 12 });
        await expect(handle).toHaveAttribute("data-dragging", "true");
        await page.mouse.up();
        // A drop on another device must cancel instead of changing ownership.
        await expect(firstBookmarks.getByRole("link")).toHaveText([
            "file1.txt",
            "file2.txt",
            thirdName,
        ]);
        expect(puts).toBe(0);

        await dragReorderRow(
            page,
            handle,
            firstBookmarks.getByRole("link", {
                name: "file1.txt",
                exact: true,
            }),
        );
        await expect(firstBookmarks.getByRole("link")).toHaveText([
            thirdName,
            "file1.txt",
            "file2.txt",
        ]);
        await expect(secondBookmarks.getByRole("link")).toHaveText([
            "agent2-home",
            "agent2-nested",
        ]);
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                bookmarks: [
                    agent1Bookmarks[2],
                    agent2Bookmarks[0],
                    agent1Bookmarks[0],
                    agent2Bookmarks[1],
                    agent1Bookmarks[1],
                ],
                deviceOrder: [],
            });
        await page.reload();
        await expect(firstBookmarks.getByRole("link")).toHaveText([
            thirdName,
            "file1.txt",
            "file2.txt",
        ]);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("button", {
                name: "Actions for directory subdir1",
                exact: true,
            })
            .click();
        await page
            .getByRole("dialog", { name: "Actions for directory subdir1" })
            .getByRole("button", { name: "Bookmark", exact: true })
            .click();
        // A new bookmark still appends after a manual reorder.
        await expect(firstBookmarks.getByRole("link").last()).toHaveText(
            "subdir1",
        );
    });
});
