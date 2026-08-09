import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Authentication", () => {
    test("returns to the original path and query after login", async ({
        page,
    }) => {
        await page.context().clearCookies();
        const returnPath = "/transfers?from=authentication-test";
        await page.goto(`${WEB_BASE_URL}${returnPath}`);

        // Protected loader failures must lead to the dedicated form rather than rendering app errors.
        await expect(page).toHaveURL(/\/login\?redirect=/);
        // The continuation parameter must retain both pathname and query string.
        expect(new URL(page.url()).searchParams.get("redirect")).toBe(
            returnPath,
        );

        await page.getByLabel("Username").fill("test-user");
        await page.getByLabel("Password").fill("incorrect");
        await page.getByRole("button", { name: "Sign in" }).click();
        // Invalid credentials must remain on the public form with an accessible explanation.
        await expect(page.getByRole("alert")).toHaveText(
            "Invalid username or password",
        );
        // Passwords should be cleared after a failed attempt rather than retained in UI state.
        await expect(page.getByLabel("Password")).toHaveValue("");

        await page.getByLabel("Password").fill("test-password");
        await page.getByRole("button", { name: "Sign in" }).click();
        // Successful authentication resumes exactly where the user left off.
        await expect(page).toHaveURL(`${WEB_BASE_URL}${returnPath}`);
    });

    test("logout clears the session and returns to login", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB_BASE_URL}/login`);
        await page.getByLabel("Username").fill("test-user");
        await page.getByLabel("Password").fill("test-password");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(`${WEB_BASE_URL}/`);
        // Root is the server home, not an agents list.
        await expect(
            page.getByRole("heading", { name: "Server" }),
        ).toBeVisible();
        await expect(
            page.getByText("config.toml", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByText("TOML (username/password in config file)"),
        ).toBeVisible();
        // Build identity is baked via build.rs for support/debugability.
        await expect(
            page.getByRole("heading", { name: "Version" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Git revision" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Build mode" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Build date" }),
        ).toBeVisible();
        await expect(page.getByText("debug", { exact: true })).toBeVisible();
        // Account actions live behind the burger menu so the tab strip stays uncluttered.
        await page.getByRole("button", { name: "Open menu" }).click();
        await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Server home" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Log out" }).click();
        // Logout must leave protected chrome and display the dedicated form.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/login`);
        await expect(
            page.getByRole("heading", { name: "Sign in to Redoor" }),
        ).toBeVisible();
    });
});
