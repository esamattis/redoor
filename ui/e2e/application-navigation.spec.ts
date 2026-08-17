import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Application navigation", () => {
    test("keeps both side menus visible on desktop", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        // Desktop navigation must not require opening an overlay first.
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });
        await expect(applicationNavigation).toBeVisible();
        const agentNavigation = page.getByRole("navigation", {
            name: "Agents",
        });
        // Agent selection persists on the opposite side of the central route content.
        await expect(agentNavigation).toBeVisible();
        const applicationBox = await applicationNavigation.boundingBox();
        const agentBox = await agentNavigation.boundingBox();
        // Physical placement matches each menu's application and agent responsibilities.
        expect(applicationBox?.x ?? 1).toBeLessThan(agentBox?.x ?? 0);
        const restartBox = await applicationNavigation
            .getByRole("button", { name: "Restart server" })
            .boundingBox();
        const logoutBox = await applicationNavigation
            .getByRole("button", { name: "Log out" })
            .boundingBox();
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
            page.getByRole("button", { name: "Open agent menu" }),
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
        await expect(page.getByRole("tooltip")).toBeVisible();
        await themeButton.click();
        // Click focuses the control, but the tooltip must follow the cursor rather than stay pinned.
        await page
            .getByRole("region", { name: "Agent names" })
            .getByRole("heading", { name: "Agents" })
            .hover();
        await expect(page.getByRole("tooltip")).toHaveCount(0);

        const agentLink = page
            .getByRole("region", { name: "Agent names" })
            .getByRole("link")
            .first();
        await agentLink.hover();
        await expect(page.getByRole("tooltip")).toBeVisible();
        await agentLink.click();
        // The same focus-after-click trap applies to links that remain interactive after navigation.
        await page.getByRole("heading", { name: "Mount Points" }).hover();
        await expect(page.getByRole("tooltip")).toHaveCount(0);
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
            page.getByRole("navigation", { name: "Agents" }),
        ).toBeHidden();
        // Both edge drawers remain independently reachable at this breakpoint.
        await expect(
            page.getByRole("button", { name: "Open application menu" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Open agent menu" }),
        ).toBeVisible();
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
            name: "Open agent menu",
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
        const agentDialog = page.getByRole("dialog", { name: "Agent menu" });
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
});
