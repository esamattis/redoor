// Serial: seeds the shared open files list and asserts on what the menu shows.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

test.describe.serial("Application menu layout", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("application-menu");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    // Playwright has no onTestFinished; afterEach is its per-test cleanup hook. Open files live in
    // the shared account state, so later files must not inherit the ones seeded here.
    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({ state: { openFiles: [] } });
    });

    /**
     * Seeds two open files on a connected device and one on a device the inventory does not know,
     * so the rows show both a live device and an unavailable one.
     */
    async function seedOpenFiles() {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                openFiles: [
                    ...["file1.txt", "file2.txt"].map((name) => ({
                        agentId: ctx.agentId,
                        path: path.join(ctx.testDirPath, name),
                        name,
                        agentName: ctx.agentName,
                    })),
                    {
                        agentId: "application-menu-missing-device",
                        path: "/var/log/app.log",
                        name: "app.log",
                        agentName: "retired-device",
                    },
                ],
            },
        });
    }

    /** Reads the open file names in display order from the row links' accessible names. */
    function openFileNames(page: Page) {
        return page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" })
            .getByRole("listitem")
            .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("aria-label")),
            );
    }

    test("puts open files and the sidebar mode beside an icon rail on desktop", async ({
        page,
    }) => {
        await seedOpenFiles();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${WEB_BASE_URL}/`);

        const navigation = page.getByRole("navigation", {
            name: "Application",
        });

        // Open files are the column's main content, listed with their device in the stored order.
        await expect
            .poll(() => openFileNames(page))
            .toEqual([
                `Open file file1.txt on ${ctx.agentName}`,
                `Open file file2.txt on ${ctx.agentName}`,
                "Open file app.log on retired-device",
            ]);
        // The count beside the label tells how many open files there are without counting rows.
        await expect(navigation.getByLabel("3 open")).toBeVisible();
        // An open file on a device the server no longer lists cannot be opened, so it is not a link.
        await expect(
            navigation.getByLabel("app.log", { exact: true }),
        ).toHaveAttribute("aria-disabled", "true");

        const homeBox = await navigation
            .getByRole("link", { name: "Server home" })
            .boundingBox();

        const logsBox = await navigation
            .getByRole("link", { name: "Server logs" })
            .boundingBox();

        const openFileBox = await navigation
            .getByRole("link", { name: "file1.txt", exact: true })
            .boundingBox();

        // The destinations stack in one narrow column at the menu's left edge.
        expect(logsBox?.x).toBe(homeBox?.x);
        expect(logsBox?.y ?? 0).toBeGreaterThan(homeBox?.y ?? 1);
        expect(homeBox?.width ?? 100).toBeLessThan(48);
        // Open files fill the column to the right of the rail instead of sitting below it.
        expect(openFileBox?.x ?? 0).toBeGreaterThan(
            (homeBox?.x ?? 1) + (homeBox?.width ?? 0),
        );

        await navigation.getByRole("link", { name: "Server logs" }).click();
        // Icon-only rail links navigate like the old labelled links and mark the current page.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/logs`);
        await expect(
            navigation.getByRole("link", { name: "Server logs" }),
        ).toHaveAttribute("aria-current", "page");
        await navigation.getByRole("link", { name: "Transfers" }).hover();
        // An icon alone is ambiguous, so the rail names each destination in a tooltip.
        await expect(page.getByRole("tooltip")).toHaveText("Transfers");

        await navigation
            .getByRole("link", { name: "file2.txt", exact: true })
            .click();
        // Clicking an open file row opens that exact file and marks the row as current.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`,
        );
        await expect(
            navigation.getByRole("link", { name: "file2.txt", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        const sidebarMode = navigation.getByRole("group", {
            name: "Sidebar mode",
        });

        await sidebarMode.getByRole("button", { name: "Hide" }).click();
        // The icon-only toggle still switches modes: Hide moves the menu into a drawer.
        await expect(navigation).toBeHidden();
        await page
            .getByRole("button", { name: "Open application menu" })
            .click();

        const drawer = page.getByRole("dialog", { name: "Application menu" });

        await drawer
            .getByRole("group", { name: "Sidebar mode" })
            .getByRole("button", { name: "Auto" })
            .click();
        // Auto on a wide window brings the persistent sidebar back and dismisses the drawer.
        await expect(drawer).toBeHidden();
        await expect(navigation).toBeVisible();
        await expect(
            sidebarMode.getByRole("button", { name: "Auto" }),
        ).toHaveAttribute("aria-pressed", "true");
    });

    test("puts destinations in a bottom bar with restart and logout behind More on phones", async ({
        page,
    }) => {
        await seedOpenFiles();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);

        const openMenu = page.getByRole("button", {
            name: "Open application menu",
        });

        await openMenu.click();

        const drawer = page.getByRole("dialog", { name: "Application menu" });

        // The drawer shows the same open files and the mode toggle as the desktop column.
        await expect
            .poll(() => openFileNames(page))
            .toEqual([
                `Open file file1.txt on ${ctx.agentName}`,
                `Open file file2.txt on ${ctx.agentName}`,
                "Open file app.log on retired-device",
            ]);
        await expect(
            drawer.getByRole("group", { name: "Sidebar mode" }),
        ).toBeVisible();

        const closeButton = drawer.getByRole("button", {
            name: "Close application menu",
        });

        // Opening starts on the close button, as it did when the button had its own row.
        await expect(closeButton).toBeFocused();

        const closeBox = await closeButton.boundingBox();

        const toggleBox = await drawer
            .getByRole("group", { name: "Sidebar mode" })
            .boundingBox();

        // The close button shares the header row instead of spending a row above it.
        expect(
            Math.abs(
                (closeBox?.y ?? 0) +
                    (closeBox?.height ?? 0) / 2 -
                    ((toggleBox?.y ?? 100) + (toggleBox?.height ?? 0) / 2),
            ),
        ).toBeLessThan(2);
        expect(closeBox?.x ?? 0).toBeGreaterThan(toggleBox?.x ?? 1);
        // Restart and logout are not loose in the drawer, so a stray tap cannot hit them.
        await expect(
            drawer.getByRole("button", { name: "Restart server" }),
        ).toHaveCount(0);
        await expect(
            drawer.getByRole("button", { name: "Log out" }),
        ).toHaveCount(0);

        const homeBox = await drawer
            .getByRole("link", { name: "Server home" })
            .boundingBox();

        const tokensBox = await drawer
            .getByRole("link", { name: "Manage access tokens" })
            .boundingBox();

        const moreBox = await drawer
            .getByRole("button", { name: "More" })
            .boundingBox();

        const lastOpenFileBox = await drawer
            .getByLabel("app.log", { exact: true })
            .boundingBox();

        // All seven buttons share one row along the bottom, below the open files list.
        expect(tokensBox?.y).toBe(homeBox?.y);
        expect(moreBox?.y).toBe(homeBox?.y);
        expect(moreBox?.x ?? 0).toBeGreaterThan(tokensBox?.x ?? 1);
        expect(homeBox?.y ?? 0).toBeGreaterThan(lastOpenFileBox?.y ?? 1);
        expect((homeBox?.y ?? 0) + (homeBox?.height ?? 0)).toBeGreaterThan(780);

        await drawer.getByRole("link", { name: "Server logs" }).click();
        // A destination in the bar navigates and closes the drawer like the old links.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/logs`);
        await expect(drawer).toBeHidden();

        await openMenu.click();
        await drawer.getByRole("button", { name: "More" }).click();

        const moreMenu = page.getByRole("dialog", { name: "More actions" });

        // The More menu holds both account and process actions.
        await expect(
            moreMenu.getByRole("button", { name: "Log out" }),
        ).toBeVisible();
        await moreMenu.getByRole("button", { name: "Restart server" }).click();

        const confirmation = page.getByRole("dialog", {
            name: "Restart server?",
        });

        // Restart from the menu still asks for confirmation before restarting.
        await expect(confirmation).toBeVisible();
        await expect(moreMenu).toBeHidden();
        await confirmation.getByRole("button", { name: "Cancel" }).click();
        await expect(confirmation).toBeHidden();

        await drawer
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        // Opening a file from the drawer navigates and gets the drawer out of the way.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file1.txt"))}`,
        );
        await expect(drawer).toBeHidden();
    });

    test("explains how to open files when the list is empty", async ({
        page,
    }) => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({ state: { openFiles: [] } });
        await page.goto(`${WEB_BASE_URL}/`);

        const navigation = page.getByRole("navigation", {
            name: "Application",
        });

        // The section stays as a hint instead of leaving the column blank.
        await expect(
            navigation.getByText(
                "No open files — edit or double-click a file in the editor to list it here",
            ),
        ).toBeVisible();
        // There is nothing to clear, so the action is not offered.
        await expect(
            navigation.getByRole("button", { name: "Close all open files" }),
        ).toHaveCount(0);
    });
});
