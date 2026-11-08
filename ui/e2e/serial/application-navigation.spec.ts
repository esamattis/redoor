// Serial: cycles the shared color theme, which other specs' colour assertions depend on.
import { expect, test } from "../fixtures";

import { WEB_BASE_URL } from "../helpers";

test.describe("Application navigation", () => {
    test("resizes both sidebars independently and remembers their widths", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const application = page.getByRole("complementary", {
            name: "Application menu",
        });

        const devices = page.getByRole("complementary", {
            name: "Device menu",
        });

        // The application menu starts wider so open file names have room beside its rail.
        for (const [panel, label, delta, start] of [
            [application, "Resize application menu", 80, 260],
            [devices, "Resize device menu", -100, 224],
        ] as const) {
            const handle = page.getByRole("separator", { name: label });
            const box = await handle.boundingBox();

            if (!box) {
                throw new Error(`Missing resize handle: ${label}`);
            }

            await page.mouse.move(
                box.x + box.width / 2,
                box.y + box.height / 2,
            );
            await page.mouse.down();
            await page.mouse.move(
                box.x + box.width / 2 + delta,
                box.y + box.height / 2,
                { steps: 8 },
            );
            await page.mouse.up();
            // Each inner edge follows the pointer, including the mirrored right sidebar.
            await expect
                .poll(async () => (await panel.boundingBox())?.width)
                .toBe(start + Math.abs(delta));
        }

        await page.reload();
        // Reload restores both independent preferences without changing the opposite panel.
        await expect
            .poll(async () => (await application.boundingBox())?.width)
            .toBe(340);
        await expect
            .poll(async () => (await devices.boundingBox())?.width)
            .toBe(324);

        const handle = page.getByRole("separator", {
            name: "Resize device menu",
        });

        await handle.focus();
        await handle.press("ArrowLeft");
        // Keyboard movement mirrors the right edge just like pointer movement.
        await expect
            .poll(async () => (await devices.boundingBox())?.width)
            .toBe(348);
        await handle.press("Control+ArrowLeft");
        // Browser and operating-system key combinations must retain their usual behavior.
        await expect(handle).toHaveAttribute("aria-valuenow", "348");
        await handle.hover();
        // Hovering or focusing a drag border must not display a tooltip over the content.
        await expect(page.getByRole("tooltip")).toHaveCount(0);

        for (let step = 0; step < 20; step += 1) {
            await handle.press("ArrowRight");
        }

        // Shrinking stops before navigation controls become unusably narrow.
        await expect
            .poll(async () => (await devices.boundingBox())?.width)
            .toBe(180);
        await page.setViewportSize({ width: 390, height: 844 });
        // Responsive drawers retain their own mobile sizing and expose no persistent resize handle.
        await expect(handle).toBeHidden();
        await page.getByRole("button", { name: "Open device menu" }).click();
        await expect(
            page.getByRole("dialog", { name: "Device menu" }),
        ).toBeVisible();
    });

    test("keeps both side menus visible on desktop", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        // Desktop navigation must not require opening an overlay first.
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        await expect(applicationNavigation).toBeVisible();

        const agentNavigation = page.getByRole("navigation", {
            name: "Devices",
        });

        // Agent selection persists on the opposite side of the central route content.
        await expect(agentNavigation).toBeVisible();
        const applicationBox = await applicationNavigation.boundingBox();
        const agentBox = await agentNavigation.boundingBox();
        // Physical placement matches each menu's application and agent responsibilities.
        expect(applicationBox?.x ?? 1).toBeLessThan(agentBox?.x ?? 0);

        const sidebarModeBox = await applicationNavigation
            .getByRole("group", { name: "Sidebar mode" })
            .boundingBox();

        const restartBox = await applicationNavigation
            .getByRole("button", { name: "Restart server" })
            .boundingBox();

        const logoutBox = await applicationNavigation
            .getByRole("button", { name: "Log out" })
            .boundingBox();

        // Layout preference sits in the menu header, above the rail's process restart.
        expect(sidebarModeBox?.y ?? 1).toBeLessThan(restartBox?.y ?? 0);
        // Process restart sits just above logout so account actions remain last.
        expect(restartBox?.y ?? 1).toBeLessThan(logoutBox?.y ?? 0);
        // Account actions stay anchored near the bottom edge of the full-height sidebar.
        expect((logoutBox?.y ?? 0) + (logoutBox?.height ?? 0)).toBeGreaterThan(
            680,
        );
        // The burger is reserved for viewports where the sidebar cannot remain visible.
        await expect(
            page.getByRole("button", { name: "Open application menu" }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Open device menu" }),
        ).toBeHidden();
    });

    test("hides tooltips after a click once the cursor leaves", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const themeButton = page.getByRole("button", {
            name: /Color theme:/,
        });

        await themeButton.hover();
        // Mouse hover must not show a tooltip before the shared 500ms delay elapses.
        await expect(page.getByRole("tooltip")).toHaveCount(0, {
            timeout: 350,
        });
        await expect(page.getByRole("tooltip")).toBeVisible();
        await themeButton.click();
        // Click focuses the control, but the tooltip must follow the cursor rather than stay pinned.
        await page
            .getByRole("region", { name: "Device names" })
            .getByRole("heading", { name: "Devices" })
            .hover();
        await expect(page.getByRole("tooltip")).toHaveCount(0);

        const agentLink = page
            .getByRole("region", { name: "Device names" })
            .getByRole("link")
            .first();

        await agentLink.hover();
        await expect(page.getByRole("tooltip")).toBeVisible();
        await agentLink.click();
        // The same focus-after-click trap applies to links that remain interactive after navigation.
        await page.getByRole("heading", { name: "Mount Points" }).hover();
        await expect(page.getByRole("tooltip")).toHaveCount(0);
    });

    test("shows tooltips immediately for keyboard focus", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/`);
        await page.mouse.move(0, 0);

        const themeButton = page.getByRole("button", {
            name: /Color theme:/,
        });

        await themeButton.focus();

        // The hover delay must not make keyboard users wait for a focused control's description.
        await expect(page.getByRole("tooltip")).toBeVisible();
    });

    test("keeps tooltips hidden when a clicked dialog moves focus", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("button", { name: "Restart server" })
            .click();

        const dialog = page.getByRole("dialog", { name: "Restart server?" });

        const closeButton = dialog.getByRole("button", {
            name: "Close confirmation dialog",
        });

        // The modal moves focus to its first control on open, which is the premise of this test.
        await expect(closeButton).toBeFocused();
        // Script focus after a click is not keyboard navigation, so the close tooltip must stay hidden.
        await expect(page.getByRole("tooltip")).toHaveCount(0);

        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        // Real keyboard navigation inside the same dialog must still describe the focused control.
        await expect(
            page.getByRole("tooltip", { name: "Close confirmation dialog" }),
        ).toBeVisible();
    });

    test("opens and dismisses the sidebar from outside on mobile", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);

        const openMenuButton = page.getByRole("button", {
            name: "Open application menu",
        });

        // Mobile navigation starts closed so content retains the viewport width.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeHidden();
        const triggerBox = await openMenuButton.boundingBox();
        // The mobile trigger stays on the left edge beside the drawer it controls.
        expect(triggerBox?.x ?? 390).toBeLessThan(24);
        await openMenuButton.click();

        const menuDialog = page.getByRole("dialog", {
            name: "Application menu",
        });

        // Opening the burger exposes the same application destinations in a modal drawer.
        await expect(menuDialog).toBeVisible();
        await expect(
            menuDialog.getByRole("navigation", { name: "Application" }),
        ).toBeVisible();
        await expect(openMenuButton).toHaveAttribute("aria-expanded", "true");

        await menuDialog.click({ position: { x: 380, y: 400 } });

        // A pointer press on the backdrop must dismiss the mobile drawer.
        await expect(menuDialog).toBeHidden();
        await expect(openMenuButton).toHaveAttribute("aria-expanded", "false");
    });

    test("uses drawers for both side menus on mid-sized screens", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1000, height: 800 });
        await page.goto(`${WEB_BASE_URL}/`);

        // Mid-sized layouts reserve the width for route content instead of two persistent sidebars.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeHidden();
        await expect(
            page.getByRole("navigation", { name: "Devices" }),
        ).toBeHidden();
        // Both edge drawers remain independently reachable at this breakpoint.
        await expect(
            page.getByRole("button", { name: "Open application menu" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Open device menu" }),
        ).toBeVisible();
    });

    test("selects sidebar visibility modes and keeps the choice in this tab", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const sidebarMode = page.getByRole("group", { name: "Sidebar mode" });

        // Auto is the default, and every mode is offered at once instead of cycling.
        await expect(
            sidebarMode.getByRole("button", { name: "Auto" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            sidebarMode.getByRole("button", { name: "Show" }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(
            sidebarMode.getByRole("button", { name: "Hide" }),
        ).toHaveAttribute("aria-pressed", "false");

        await sidebarMode.getByRole("button", { name: "Show" }).hover();
        // The tooltip explains what the segment does before it is chosen.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Show: always show the sidebars",
        );
        await sidebarMode.getByRole("button", { name: "Show" }).click();
        // Only the chosen segment is marked as selected.
        await expect(
            sidebarMode.getByRole("button", { name: "Show" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            sidebarMode.getByRole("button", { name: "Auto" }),
        ).toHaveAttribute("aria-pressed", "false");

        await page.setViewportSize({ width: 390, height: 844 });
        // Show keeps both edge menus in the layout on a phone-sized viewport.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeVisible();
        await expect(
            page.getByRole("navigation", { name: "Devices" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Open application menu" }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Open device menu" }),
        ).toBeHidden();

        // Hide can be picked directly without passing through another mode.
        await sidebarMode.getByRole("button", { name: "Hide" }).click();

        await page.setViewportSize({ width: 1280, height: 800 });
        // Hide keeps menus behind drawers even after returning to a wide viewport.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Open application menu" }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Open application menu" })
            .click();

        // The drawer copy of the control reflects the stored Hide preference.
        await expect(
            sidebarMode.getByRole("button", { name: "Hide" }),
        ).toHaveAttribute("aria-pressed", "true");

        await page.reload();
        // Session storage must restore Hide after a reload in the same tab.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeHidden();
        await page
            .getByRole("button", { name: "Open application menu" })
            .click();
        await expect(
            sidebarMode.getByRole("button", { name: "Hide" }),
        ).toHaveAttribute("aria-pressed", "true");
    });

    test("coordinates independently placed mobile drawers and restores focus", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);

        const applicationTrigger = page.getByRole("button", {
            name: "Open application menu",
        });

        const agentTrigger = page.getByRole("button", {
            name: "Open device menu",
        });

        await applicationTrigger.click();
        // Opening the opposite drawer closes the first rather than stacking modal surfaces.
        await agentTrigger.evaluate((trigger) => {
            if (trigger instanceof HTMLButtonElement) {
                trigger.click();
            }
        });
        await expect(
            page.getByRole("dialog", { name: "Application menu" }),
        ).toBeHidden();
        const agentDialog = page.getByRole("dialog", { name: "Device menu" });
        await expect(agentDialog).toBeVisible();
        const dialogBox = await agentDialog.locator("aside").boundingBox();
        // The agent drawer enters from and remains aligned to the viewport's right edge.
        expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBe(390);
        await page.keyboard.press("Escape");
        // Escape dismisses the active modal and returns keyboard focus to its trigger.
        await expect(agentDialog).toBeHidden();
        await expect(agentTrigger).toBeFocused();
    });

    test("hides overlay panels during touch scrolling only when content is cramped", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto(`${WEB_BASE_URL}/`);

        const dispatchGestures = () =>
            page.locator("main").evaluate((main) => {
                const dispatchTouch = (
                    type: string,
                    clientX: number,
                    clientY: number,
                ) => {
                    const event = new Event(type, { bubbles: true });
                    Object.defineProperty(event, "touches", {
                        value: [{ clientX, clientY }],
                    });
                    main.dispatchEvent(event);
                };

                dispatchTouch("touchstart", 200, 200);
                dispatchTouch("touchmove", 100, 215);

                const hiddenAfterHorizontalGesture =
                    document.documentElement.hasAttribute(
                        "data-touch-scrolling",
                    );

                dispatchTouch("touchstart", 200, 200);
                dispatchTouch("touchmove", 200, 150);

                const hiddenAtVerticalThreshold =
                    document.documentElement.hasAttribute(
                        "data-touch-scrolling",
                    );

                dispatchTouch("touchstart", 200, 200);
                dispatchTouch("touchmove", 200, 149);

                const hiddenAfterVerticalGesture =
                    document.documentElement.hasAttribute(
                        "data-touch-scrolling",
                    );

                return {
                    hiddenAfterHorizontalGesture,
                    hiddenAtVerticalThreshold,
                    hiddenAfterVerticalGesture,
                };
            });

        const spaciousStates = await dispatchGestures();
        // Horizontal content scrolling must leave the overlay controls available.
        expect(spaciousStates.hiddenAfterHorizontalGesture).toBe(false);
        // Compact chrome already leaves most of the viewport readable.
        expect(spaciousStates.hiddenAtVerticalThreshold).toBe(false);
        expect(spaciousStates.hiddenAfterVerticalGesture).toBe(false);

        const panel = page.getByRole("region", { name: "Application tools" });
        await panel.getByRole("tab", { name: "Terminal" }).click();
        await expect(
            panel.getByRole("button", { name: "Minimize bottom drawer" }),
        ).toBeVisible();
        // Force a cramped content area so the hide threshold is independent of default drawer height.
        await panel.evaluate((drawer) => {
            drawer.style.height = "500px";
        });
        await expect
            .poll(async () =>
                page
                    .locator("main")
                    .evaluate((main) =>
                        Number.parseFloat(
                            getComputedStyle(main).getPropertyValue(
                                "--bottom-chrome-height",
                            ),
                        ),
                    ),
            )
            .toBe(500);

        const crampedStates = await dispatchGestures();
        // Horizontal content scrolling must leave the overlay controls available.
        expect(crampedStates.hiddenAfterHorizontalGesture).toBe(false);
        // The full threshold is allowed before hiding overlay controls.
        expect(crampedStates.hiddenAtVerticalThreshold).toBe(false);
        // Crossing the vertical threshold hides the panels to expose more content.
        expect(crampedStates.hiddenAfterVerticalGesture).toBe(true);
        await expect
            .poll(async () => {
                const box = await panel.boundingBox();

                // Fully clipped counts as hidden; a partial slide would still report a y below the viewport.
                return box === null || box.y >= 800;
            })
            .toBe(true);
    });

    test("shows page not found inside the application chrome", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/no-such-page`);

        // Unknown addresses must say so rather than render a blank or default page.
        await expect(
            page.getByRole("heading", { name: "Page not found" }),
        ).toBeVisible();

        // The menus stay around the message, so the user is one click from a real page.
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        await expect(applicationNavigation).toBeVisible();
        await page.getByRole("link", { name: "Server home" }).first().click();
        // The way back must land on the server home.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/`);
    });

    test("marks only the current destination in the application menu", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/transfers`);

        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });

        // The router's active matching must flag the page being viewed.
        await expect(
            applicationNavigation.getByRole("link", { name: "Transfers" }),
        ).toHaveAttribute("aria-current", "page");
        // Home is an exact match, so it must not light up for other pages.
        await expect(
            applicationNavigation.getByRole("link", { name: "Server home" }),
        ).not.toHaveAttribute("aria-current", "page");
    });
});
