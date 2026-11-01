// Serial: changing the login password signs out every other browser session, including the
// shared one every spec loads from global setup, so this spec restores the password and
// writes a fresh shared session before the next spec starts.
import path from "node:path";

import { expect, request, test } from "@playwright/test";

import { WEB_BASE_URL } from "../helpers";

const USERNAME = "test-user";

const ORIGINAL_PASSWORD = "test-password";

const NEW_PASSWORD = "e2e-changed-password";

/** Path global setup stores the shared session in, resolved the same way. */
const STORAGE_PATH = path.resolve(".test-playwright-auth.json");

/**
 * Puts the original password back if the test changed it, then signs in again and saves
 * the session where the following specs load it, like global setup does.
 */
async function restorePasswordAndSharedSession(): Promise<void> {
    const context = await request.newContext({ baseURL: WEB_BASE_URL });

    try {
        const changed = await context.post("/api/v1/login", {
            data: { username: USERNAME, password: NEW_PASSWORD },
        });

        if (changed.ok()) {
            const restored = await context.put("/api/v1/auth/password", {
                data: {
                    current_password: NEW_PASSWORD,
                    new_password: ORIGINAL_PASSWORD,
                },
            });

            if (!restored.ok()) {
                throw new Error(
                    `Restoring the password failed: ${restored.status()}`,
                );
            }
        }

        const login = await context.post("/api/v1/login", {
            data: { username: USERNAME, password: ORIGINAL_PASSWORD },
        });

        if (!login.ok()) {
            throw new Error(`Signing in again failed: ${login.status()}`);
        }

        await context.storageState({ path: STORAGE_PATH });
    } finally {
        await context.dispose();
    }
}

test.describe("Change password", () => {
    test.afterEach(restorePasswordAndSharedSession);

    test("changes the login password from the server home and stays signed in", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);
        await page.getByRole("button", { name: "Change password" }).click();

        const dialog = page.getByRole("dialog", { name: "Change password" });

        await dialog
            .getByLabel("Current password", { exact: true })
            .fill(ORIGINAL_PASSWORD);
        await dialog
            .getByLabel("New password", { exact: true })
            .fill(NEW_PASSWORD);
        await dialog
            .getByLabel("Repeat new password", { exact: true })
            .fill("something-else");
        // A typo in the repeated password is caught before anything is sent.
        await expect(
            dialog.getByText("The passwords do not match."),
        ).toBeVisible();
        await expect(
            dialog.getByRole("button", { name: "Change password" }),
        ).toBeDisabled();

        await dialog
            .getByLabel("Repeat new password", { exact: true })
            .fill(NEW_PASSWORD);
        await dialog.getByRole("button", { name: "Change password" }).click();

        // The dialog closes and the toast confirms the change.
        await expect(dialog).toBeHidden();
        await expect(page.getByText(/^Password changed\./)).toBeVisible();

        // The re-issued cookie keeps this browser signed in after a reload.
        await page.reload();
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();

        const context = await request.newContext({ baseURL: WEB_BASE_URL });

        try {
            const oldLogin = await context.post("/api/v1/login", {
                data: { username: USERNAME, password: ORIGINAL_PASSWORD },
            });

            // The old password stops working at once, without a restart.
            expect(oldLogin.status()).toBe(401);

            const newLogin = await context.post("/api/v1/login", {
                data: { username: USERNAME, password: NEW_PASSWORD },
            });

            // The new password works at once.
            expect(newLogin.ok()).toBe(true);
        } finally {
            await context.dispose();
        }
    });
});
