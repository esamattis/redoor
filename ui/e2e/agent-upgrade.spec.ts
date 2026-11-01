import { expect, test, type Page } from "@playwright/test";

import type { AgentUpgradeJob } from "#bindings/AgentUpgradeJob";
import type { AgentUpgradePhase } from "#bindings/AgentUpgradePhase";
import {
    WEB_BASE_URL,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

let context: TestContext;

/**
 * Stands in for the server's background upgrade, which would replace the shared test agent's
 * binary. The test moves the job from phase to phase itself, so every state is held for as
 * long as the assertions need it.
 */
async function simulateAgentUpgrade(page: Page) {
    let job: AgentUpgradeJob | null = null;
    let dismissed = false;

    await page.route("**/api/v1/agents/*/upgrade", async (route) => {
        const method = route.request().method();

        if (method === "POST") {
            job = {
                id: "simulated",
                target_version: "99.0.0",
                source: "published_release",
                phase: { phase: "preparing" },
                started_at: Date.now(),
            };
            await route.fulfill({
                json: { upgrading: true, target_version: "99.0.0" },
            });

            return;
        }

        if (method === "DELETE") {
            job = null;
            dismissed = true;
            await route.fulfill({ status: 204 });

            return;
        }

        await route.fulfill({ json: { job } });
    });

    return {
        setPhase(phase: AgentUpgradePhase) {
            if (job) job = { ...job, phase };
        },
        wasDismissed: () => dismissed,
    };
}

test.describe.serial("Agent upgrade", () => {
    test.beforeAll(async () => {
        context = await setupTestDir("agent-upgrade");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test("follows a background upgrade until it is dismissed", async ({
        page,
    }) => {
        const upgrade = await simulateAgentUpgrade(page);
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentName}`);

        await page.getByLabel("Target version").fill("99.0.0");
        await page.getByRole("button", { name: "Upgrade to 99.0.0" }).click();

        const dialog = page.getByRole("dialog", {
            name: `Upgrade agent ${context.agentName}?`,
        });

        await dialog.getByRole("button", { name: "Upgrade" }).click();
        // The dialog only starts the upgrade; progress is shown outside it.
        await expect(dialog).toBeHidden();

        const status = page.getByRole("region", { name: "Agent upgrade" });

        await expect(status).toContainText("Upgrading to Redoor 99.0.0");

        upgrade.setPhase({
            phase: "uploading",
            sent_bytes: 512 * 1024,
            total_bytes: 1024 * 1024,
        });

        // The upload's progress is polled from the server while the binary streams.
        await expect(
            status.getByRole("progressbar", { name: "Upgrade upload" }),
        ).toHaveAttribute("aria-valuenow", "50");
        // Starting a second upgrade is blocked while one runs.
        await expect(
            page.getByRole("button", { name: "Upgrade to 99.0.0" }),
        ).toBeDisabled();

        upgrade.setPhase({ phase: "completed" });

        // The outcome stays visible until the user dismisses it.
        await expect(status).toContainText("Upgraded to Redoor 99.0.0");
        await status.getByRole("button", { name: "Dismiss" }).click();
        await expect(status).toBeHidden();
        // Dismissing tells the server to forget the finished upgrade.
        expect(upgrade.wasDismissed()).toBe(true);
    });

    test("shows why an upgrade failed", async ({ page }) => {
        const upgrade = await simulateAgentUpgrade(page);
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentName}`);

        await page.getByLabel("Target version").fill("99.0.0");
        await page.getByRole("button", { name: "Upgrade to 99.0.0" }).click();
        await page
            .getByRole("dialog", {
                name: `Upgrade agent ${context.agentName}?`,
            })
            .getByRole("button", { name: "Upgrade" })
            .click();

        const status = page.getByRole("region", { name: "Agent upgrade" });

        await expect(status).toContainText("Upgrading to Redoor 99.0.0");

        upgrade.setPhase({
            phase: "failed",
            error: "The agent reconnected running Redoor 1.0.0 instead of 99.0.0",
        });

        // The server's reason is shown so the user knows what is running.
        await expect(status).toContainText("Upgrade to Redoor 99.0.0 failed");
        await expect(status).toContainText(
            "reconnected running Redoor 1.0.0 instead of 99.0.0",
        );
    });
});
