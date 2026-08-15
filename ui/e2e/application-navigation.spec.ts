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
        const logoutBox = await applicationNavigation
            .getByRole("button", { name: "Log out" })
            .boundingBox();
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

    test("keeps overlay panels visible during horizontal touch scrolling", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const gestureStates = await page.locator("main").evaluate((main) => {
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
                document.documentElement.hasAttribute("data-touch-scrolling");

            dispatchTouch("touchstart", 200, 200);
            dispatchTouch("touchmove", 185, 100);
            const hiddenAfterVerticalGesture =
                document.documentElement.hasAttribute("data-touch-scrolling");

            return {
                hiddenAfterHorizontalGesture,
                hiddenAfterVerticalGesture,
            };
        });

        // Horizontal content scrolling must leave the overlay controls available.
        expect(gestureStates.hiddenAfterHorizontalGesture).toBe(false);
        // Vertical scrolling still hides the panels to expose more content.
        expect(gestureStates.hiddenAfterVerticalGesture).toBe(true);
    });
});
