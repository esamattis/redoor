import { expect, test } from "@playwright/test";

import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe("Agent view navigation", () => {
    let context: TestContext;

    test.beforeAll(async () => {
        context = await setupTestDir("agent-view-navigation");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test("switches connected agent views and selects an agent from the mobile drawer", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentId}`);

        const agentView = page.getByLabel("Agent view");
        const detailsLink = agentView.getByRole("link", {
            name: "Details",
            exact: true,
        });
        // Agent details must be represented as the current contextual top tab.
        await expect(detailsLink).toHaveAttribute("aria-current", "page");

        await agentView
            .getByRole("link", { name: "Files", exact: true })
            .click();
        // Files must open the connected agent's published browser location.
        await expect(page).toHaveURL(context.agentBrowserUrl);
        await page.getByRole("link", { name: "Agent", exact: true }).click();
        // Returning to the agent page must restore the Details tab as current.
        await expect(page).toHaveURL(new RegExp(`/agents/${context.agentId}$`));
        await expect(detailsLink).toHaveAttribute("aria-current", "page");

        await page.getByRole("button", { name: "Open agent menu" }).click();
        const agentDialog = page.getByRole("dialog", { name: "Agent menu" });
        await agentDialog
            .getByRole("link", { name: "agent2_custom, connected" })
            .click();
        // Selecting an agent must navigate and dismiss the mobile drawer.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${context.agent2Id}/browser/`),
        );
        await expect(agentDialog).toBeHidden();
    });
});
