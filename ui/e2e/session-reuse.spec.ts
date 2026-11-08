import { expect, test } from "./fixtures";

import { WEB_BASE_URL } from "./helpers";

test.describe("Session reuse", () => {
    test("tells a browser whose cookie was used elsewhere why it was signed out", async ({
        browser,
        playwright,
    }) => {
        // A context of its own, so revoking its session cannot sign out the other specs.
        const context = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });

        const login = await context.request.post(
            `${WEB_BASE_URL}/api/v1/login`,
            { data: { username: "test-user", password: "test-password" } },
        );

        expect(login.status()).toBe(200);

        const page = await context.newPage();
        await page.goto(`${WEB_BASE_URL}/`);
        await expect(
            page.getByRole("heading", { name: "Server" }),
        ).toBeVisible();

        const cookie = (await context.cookies()).find(
            (candidate) => candidate.name === "redoor_session",
        );

        const sessionId = cookie?.value.split(".", 1)[0] ?? "";
        // The cookie names a session id and its current secret.
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

        // A second browser presenting the session with a secret it no longer has, as a
        // copied profile does once the original browser rotated past it.
        const copy = await playwright.request.newContext();

        const stale = await copy.get(`${WEB_BASE_URL}/api/v1/auth/me`, {
            headers: { Cookie: `redoor_session=${sessionId}.bWFkZS11cA` },
        });

        // The server signs the session out for both browsers and says why.
        expect(stale.status()).toBe(401);
        expect((await stale.json()).code).toBe("session_reused");
        await copy.dispose();

        await page.reload();
        // The original browser lands on the login page, keeping its way back ...
        await expect(page).toHaveURL(/\/login\?.*reason=reused/);
        // ... and is told why it was signed out and what to check.
        await expect(
            page
                .getByRole("alert")
                .filter({ hasText: "used from another browser" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "signed-in sessions" }),
        ).toBeVisible();
        await context.close();
    });
});
