import { expect, test } from "./fixtures";
import { ageSignIn, signInAgain, WEB_BASE_URL } from "./helpers";

test.describe("Access token settings", () => {
    test("creates, copies, edits, rotates, and deletes a device-scoped token", async ({
        page,
        context,
    }) => {
        const tokenName = `Playwright access token ${Date.now()}`;
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Manage access tokens" })
            .click();
        // The application navigation is the entry point to token management.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/settings/tokens`);
        await expect(
            page.getByRole("heading", { name: "Access tokens" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Create token" }).click();

        const createDialog = page.getByRole("dialog", {
            name: "Create access token",
        });

        // New tokens start read-only so broader access is always an explicit opt-in.
        await expect(
            createDialog.getByRole("checkbox", { name: /Read files/ }),
        ).toBeChecked();
        await expect(
            createDialog.getByRole("checkbox", { name: /Write files/ }),
        ).not.toBeChecked();
        // Shell access bypasses file permissions, so it must never be on by default.
        await expect(
            createDialog.getByRole("checkbox", { name: /Run commands/ }),
        ).not.toBeChecked();
        // All devices is the default scope, matching what `redoor remote login` grants.
        await expect(
            createDialog.getByRole("radio", { name: /All devices/ }),
        ).toBeChecked();
        // The 90 day expiry is the default for new tokens.
        await expect(createDialog.getByLabel("Token expiry")).toHaveValue(
            "90d",
        );

        const submit = createDialog.getByRole("button", {
            name: "Create token",
        });

        // A blank name cannot be submitted.
        await expect(submit).toBeDisabled();
        await createDialog.getByLabel("Token name").fill(tokenName);
        await expect(submit).toBeEnabled();

        await createDialog
            .getByRole("radio", { name: /Selected devices/ })
            .click();

        const deviceCheckboxes = createDialog
            .getByRole("group", { name: "Selected devices" })
            .getByRole("checkbox");

        // An explicit device list with no devices would grant nothing, so it is rejected.
        await expect(submit).toBeDisabled();

        const deviceName = (
            (await deviceCheckboxes.first().textContent()) ?? ""
        ).trim();

        // The device list must offer the connected devices by name.
        expect(deviceName).not.toBe("");
        await deviceCheckboxes.first().click();
        await createDialog.getByLabel("Token expiry").selectOption("30d");
        await expect(submit).toBeEnabled();

        // A sign-in older than a minute cannot create tokens, so pressing "Create token"
        // goes through the login page first and back to the form.
        await ageSignIn(page);
        await submit.click();
        await signInAgain(page);

        // The whole form lives in the URL, so it comes back open and filled in and the
        // user only presses "Create token" again.
        await expect(createDialog.getByLabel("Token name")).toHaveValue(
            tokenName,
        );
        await expect(
            createDialog.getByRole("radio", { name: /Selected devices/ }),
        ).toBeChecked();
        await expect(
            createDialog
                .getByRole("group", { name: "Selected devices" })
                .getByRole("checkbox", { name: deviceName, exact: true }),
        ).toBeChecked();
        await expect(
            createDialog.getByRole("checkbox", { name: /Read files/ }),
        ).toBeChecked();
        await expect(createDialog.getByLabel("Token expiry")).toHaveValue(
            "30d",
        );
        await submit.click();

        const secretDialog = page.getByRole("dialog", {
            name: "Token created",
        });

        const originalToken = (
            (await secretDialog
                .getByLabel("Access token contents", { exact: true })
                .textContent()) ?? ""
        ).trim();

        // Unified access tokens carry a recognisable prefix for secret scanners.
        expect(originalToken).toMatch(/^redoor_at_/);
        // MCP clients need the endpoint next to the one-time secret.
        await expect(
            secretDialog.getByLabel("MCP endpoint contents", { exact: true }),
        ).toHaveText(`${WEB_BASE_URL}/mcp`);

        const agentPrompt = secretDialog.getByLabel(
            "AI agent setup prompt contents",
            { exact: true },
        );

        // The agent prompt must be self-contained, so it embeds both the endpoint and the secret.
        await expect(agentPrompt).toContainText(`${WEB_BASE_URL}/mcp`);
        await expect(agentPrompt).toContainText(
            `Authorization: Bearer ${originalToken}`,
        );
        await secretDialog
            .getByRole("button", { name: "Copy access token" })
            .click();
        // The copy control confirms success and the clipboard holds the exact secret.
        await expect(
            secretDialog.getByRole("button", { name: "Copied!" }),
        ).toBeVisible();
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(originalToken);
        await secretDialog
            .getByRole("button", { name: "I saved the token" })
            .click();
        // The secret is shown only once and disappears with its dialog.
        await expect(page.getByText(originalToken)).toHaveCount(0);

        const card = page.getByRole("article", {
            name: tokenName,
            exact: true,
        });

        const permissionBadges = card
            .getByRole("list", { name: "Permissions" })
            .getByRole("listitem");

        // The card shows human labels, not raw permission ids.
        await expect(permissionBadges).toHaveText(["Read files"]);
        // Device-scoped tokens list the device by name rather than by id.
        await expect(card.getByLabel("Devices", { exact: true })).toHaveText(
            deviceName,
        );
        await expect(card.getByText("Active")).toBeVisible();
        // The 30 day choice survived the sign-in round trip and reached the server.
        await expect(card.getByLabel("Expires", { exact: true })).toHaveText(
            "in 30 days",
        );
        // A freshly created token has never been used by a client.
        await expect(card.getByLabel("Last used", { exact: true })).toHaveText(
            "Never",
        );

        await card.getByRole("link", { name: "Edit" }).click();
        // Editing is a dedicated page rather than a modal over the list.
        await expect(page).toHaveURL(
            new RegExp(`${WEB_BASE_URL}/settings/tokens/[^/]+/edit$`),
        );
        await expect(page.getByRole("dialog")).toHaveCount(0);

        const editForm = page.getByRole("form", {
            name: "Edit access token",
        });

        // Editing starts from the saved policy.
        await expect(editForm.getByLabel("Token name")).toHaveValue(tokenName);
        await expect(
            editForm.getByRole("radio", { name: /Selected devices/ }),
        ).toBeChecked();
        await expect(
            editForm
                .getByRole("group", { name: "Selected devices" })
                .getByRole("checkbox", { name: deviceName, exact: true }),
        ).toBeChecked();
        await editForm.getByRole("checkbox", { name: /Write files/ }).click();
        await editForm.getByRole("button", { name: "Save changes" }).click();
        // Saving returns to the list and confirms the change.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/settings/tokens?notice=updated`,
        );
        await expect(page.getByRole("status")).toContainText("Token updated");
        // The updated policy is reflected on the card without a new secret.
        await expect(permissionBadges).toHaveText([
            "Read files",
            "Write files",
        ]);
        await expect(page.getByRole("dialog")).toHaveCount(0);

        await page.reload();
        // Reload proves the edit was persisted on the server.
        await expect(permissionBadges).toHaveText([
            "Read files",
            "Write files",
        ]);
        await expect(card.getByLabel("Devices", { exact: true })).toHaveText(
            deviceName,
        );

        await card.getByRole("button", { name: "Rotate" }).click();

        const rotateDialog = page.getByRole("dialog", {
            name: "Rotate access token?",
        });

        // Rotating hands out a new secret too, so it also needs a fresh sign-in.
        await ageSignIn(page);
        await rotateDialog
            .getByRole("button", { name: "Rotate token" })
            .click();
        await signInAgain(page);
        // The token being rotated is in the URL, so its confirmation is open again.
        await rotateDialog
            .getByRole("button", { name: "Rotate token" })
            .click();

        const rotatedDialog = page.getByRole("dialog", {
            name: "Token rotated",
        });

        const rotatedToken = (
            (await rotatedDialog
                .getByLabel("Access token contents", { exact: true })
                .textContent()) ?? ""
        ).trim();

        // Rotation issues fresh secret material for the same token.
        expect(rotatedToken).toMatch(/^redoor_at_/);
        expect(rotatedToken).not.toBe(originalToken);
        await rotatedDialog
            .getByRole("button", { name: "I saved the token" })
            .click();
        // Rotation keeps the token record instead of creating a second one.
        await expect(card).toHaveCount(1);

        await card.getByRole("button", { name: "Delete" }).click();
        await page
            .getByRole("dialog", { name: "Delete access token?" })
            .getByRole("button", { name: "Delete token" })
            .click();
        // Deletion is confirmed to the user and removes the token entirely.
        await expect(page.getByRole("status")).toContainText("Token deleted");
        await expect(card).toHaveCount(0);

        await page.reload();
        // The deletion persists and neither secret ever reappears.
        await expect(
            page.getByRole("heading", { name: "Access tokens" }),
        ).toBeVisible();
        await expect(card).toHaveCount(0);
        await expect(page.getByText(originalToken)).toHaveCount(0);
        await expect(page.getByText(rotatedToken)).toHaveCount(0);
    });
});
