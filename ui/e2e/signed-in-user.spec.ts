import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Signed-in user", () => {
    test("shows who is signed in on the home page and in the account menu", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const signedIn = "Signed in as test-user with Password";
        // The shared Playwright session signed in with the config file password.
        await expect(page.getByLabel(signedIn).first()).toBeVisible();
        // A config file password can be changed from the home page.
        await expect(
            page.getByRole("button", { name: "Change password" }),
        ).toBeVisible();

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("button", { name: "Account" })
            .click();

        const menu = page.getByRole("dialog", { name: "Account" });
        // The account menu names the user and the method too.
        await expect(menu.getByLabel(signedIn)).toBeVisible();
        // And offers the password change for a password session.
        await expect(
            menu.getByRole("button", { name: "Change password" }),
        ).toBeVisible();
    });

    test("does not offer a password change to a single sign-on session", async ({
        page,
    }) => {
        // The shared session signed in with a password, so the answer is held to an OIDC one.
        await page.route("**/api/v1/auth/me", (route) =>
            route.fulfill({
                json: { name: "operator", method: "oidc", token_id: null },
            }),
        );
        await page.goto(`${WEB_BASE_URL}/`);

        // The method is named so the user knows which password they signed in with.
        await expect(
            page.getByLabel("Signed in as operator with Single sign-on"),
        ).toBeVisible();
        // The password belongs to the identity provider, so no form is offered.
        await expect(
            page.getByRole("button", { name: "Change password" }),
        ).toHaveCount(0);
        await page.unrouteAll({ behavior: "wait" });
    });
});
