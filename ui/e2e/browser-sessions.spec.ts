import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Browser sessions", () => {
    test("lists signed-in browsers and signs one out", async ({
        page,
        browser,
    }) => {
        // A unique user agent finds this test's browser among the sessions of parallel specs.
        const userAgent = `Playwright other browser ${Date.now()}`;
        const other = await browser.newContext({ userAgent });

        const login = await other.request.post(`${WEB_BASE_URL}/api/v1/login`, {
            data: { username: "test-user", password: "test-password" },
            headers: { "X-Forwarded-For": "198.51.100.23" },
        });

        expect(login.status()).toBe(200);

        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Manage browser sessions" })
            .click();
        // The application navigation is the entry point to the session list.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/settings/sessions`);
        await expect(
            page.getByRole("heading", { name: "Sessions" }),
        ).toBeVisible();

        const sessions = page.getByRole("list", { name: "Sessions" });

        // The page's own session is marked, so the user does not sign out themselves.
        await expect(
            sessions.getByText("This browser", { exact: true }),
        ).toHaveCount(1);

        const card = sessions
            .getByRole("article")
            .filter({ hasText: userAgent });

        // The other browser is listed with its full user agent ...
        await expect(card).toHaveCount(1);
        // ... and with the client address its proxy claimed.
        await expect(
            card.getByRole("definition").filter({ hasText: "198.51.100.23" }),
        ).toBeVisible();

        await card.getByRole("button", { name: "Sign out" }).click();
        const dialog = page.getByRole("dialog", { name: "Sign out session?" });

        const signOut = page.waitForResponse(
            (response) =>
                response.request().method() === "DELETE" &&
                response.url().includes("/api/v1/sessions/"),
        );

        await dialog.getByRole("button", { name: "Sign out" }).click();
        // The server confirmed the sign-out.
        expect((await signOut).status()).toBe(200);
        // The user is told it worked.
        await expect(page.getByText("Session signed out.")).toBeVisible();
        // The signed-out browser leaves the list.
        await expect(card).toHaveCount(0);

        const me = await other.request.get(`${WEB_BASE_URL}/api/v1/auth/me`);

        // The signed-out browser must sign in again.
        expect(me.status()).toBe(401);
        await other.close();
    });
});
