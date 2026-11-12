import { expect, test } from "./fixtures";

import { WEB_BASE_URL } from "./helpers";

test.describe("Session length", () => {
    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: "wait" });
    });

    test("signs in for the length picked on the login page", async ({
        page,
    }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB_BASE_URL}/login`);
        const length = page.getByLabel("Stay signed in for");
        // The shortest session is the default, so a forgotten choice is the safe one.
        await expect(length).toHaveValue("hour");

        await length.selectOption({ label: "1 week" });
        // The choice lives in the URL, so a failed provider sign-in that returns here keeps it.
        await expect(page).toHaveURL(/[?&]session=week/);

        await page.getByLabel("Username").fill("test-user");
        await page.getByLabel("Password").fill("test-password");
        const login = page.waitForRequest("**/api/v1/login");
        await page.getByRole("button", { name: "Sign in" }).click();
        // The password form sends the picked length with the credentials.
        expect((await login).postDataJSON()).toMatchObject({
            session_length: "week",
        });
        await expect(
            page.getByRole("heading", { name: "Server" }),
        ).toBeVisible();

        const cookie = (await page.context().cookies()).find(
            (candidate) => candidate.name === "redoor_session",
        );

        const yearFromNow = Date.now() / 1000 + 365 * 24 * 60 * 60;
        // Every cookie outlasts the longest session; the server enforces the picked length.
        expect(cookie?.expires).toBeGreaterThan(yearFromNow - 120);
        expect(cookie?.expires).toBeLessThanOrEqual(yearFromNow + 5);

        const me = await page.request.get(`${WEB_BASE_URL}/api/v1/auth/me`);
        const week = 7 * 24 * 60 * 60;
        const expiresIn = (await me.json()).session.expires_in_seconds;
        // The server keeps the session for the picked week.
        expect(expiresIn).toBeGreaterThan(week - 120);
        expect(expiresIn).toBeLessThanOrEqual(week);
    });

    test("warns before the session ends and renews it on interaction", async ({
        page,
    }) => {
        // Only the initial read is near expiry; confirmation must see the renewed session.
        let renewed = false;
        await page.route("**/api/v1/auth/me", (route) =>
            route.fulfill({
                json: {
                    name: "test-user",
                    method: "password",
                    token_id: null,
                    session: {
                        expires_at: new Date(Date.now() + 30_000).toISOString(),
                        expires_in_seconds: renewed ? 3600 : 30,
                    },
                },
            }),
        );
        await page.goto(`${WEB_BASE_URL}/`);

        const warning = page.getByText(
            "You will be signed out in about a minute",
        );

        // Less than a minute is left, so the user is told before being signed out.
        await expect(warning).toBeVisible();

        await page.route("**/api/v1/session/activity", async (route) => {
            const response = await route.fetch();
            renewed = true;
            await route.fulfill({ response });
        });
        const activity = page.waitForResponse("**/api/v1/session/activity");
        // A key press is an interaction that does not dismiss the toast by itself.
        await page.keyboard.press("Shift");
        // Any interaction reports activity to the server ...
        expect((await activity).status()).toBe(200);
        // ... which moves the expiry away, so the warning goes.
        await expect(warning).toHaveCount(0);
    });
});
