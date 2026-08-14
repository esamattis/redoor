import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Application navigation", () => {
    test("keeps the sidebar visible on desktop", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        // Desktop navigation must not require opening an overlay first.
        const applicationNavigation = page.getByRole("navigation", {
            name: "Application",
        });
        await expect(applicationNavigation).toBeVisible();
        const logoutBox = await applicationNavigation
            .getByRole("button", { name: "Log out" })
            .boundingBox();
        // Account actions stay anchored near the bottom edge of the full-height sidebar.
        expect((logoutBox?.y ?? 0) + (logoutBox?.height ?? 0)).toBeGreaterThan(
            680,
        );
        // The burger is reserved for viewports where the sidebar cannot remain visible.
        await expect(
            page.getByRole("button", { name: "Open menu" }),
        ).toBeHidden();
    });

    test("opens and dismisses the sidebar from outside on mobile", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);

        const openMenuButton = page.getByRole("button", { name: "Open menu" });
        // Mobile navigation starts closed so content retains the viewport width.
        await expect(
            page.getByRole("navigation", { name: "Application" }),
        ).toBeHidden();
        const triggerBox = await openMenuButton.boundingBox();
        // The mobile trigger stays on the left edge beside the drawer it controls.
        expect(triggerBox?.x ?? 390).toBeLessThan(24);
        await openMenuButton.click();

        const menuDialog = page.getByRole("dialog", { name: "Menu" });
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
});
