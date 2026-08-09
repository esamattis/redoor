import fs from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

const SERVER_LOG_PATH = path.resolve("log/playwright-redoor.log");
const AGENT_LOG_PATH = path.resolve("log/playwright-agent1_src.log");

/** Counts startup log lines so a post-restart increase proves self-exec ran. */
async function countLoadedConfigLines(): Promise<number> {
    try {
        const log = await fs.readFile(SERVER_LOG_PATH, "utf8");
        return (log.match(/Loaded server config/g) ?? []).length;
    } catch {
        return 0;
    }
}

/** Counts process startup lines so the list control proves the agent self-exec ran. */
async function countAgentStartupLines(): Promise<number> {
    try {
        const log = await fs.readFile(AGENT_LOG_PATH, "utf8");
        return (log.match(/Starting agent/g) ?? []).length;
    } catch {
        return 0;
    }
}

test.describe("Restart", () => {
    // Restarting the shared server must not interleave with other browser tests.
    test.describe.configure({ mode: "serial" });

    test("restarts the server process and keeps the UI serving", async ({
        page,
    }) => {
        const loadedBefore = await countLoadedConfigLines();
        // Baseline must exist from playwright-dev startup before we trigger restart.
        expect(loadedBefore).toBeGreaterThanOrEqual(1);

        await page.goto(`${WEB_BASE_URL}/`);
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
        // Agents in the tab strip prove the suite's external processes are connected before restart.
        await expect(
            page.getByRole("tab", { name: /agent1_src/ }),
        ).toBeVisible();
        await expect(
            page.getByRole("tab", { name: /agent2_custom/ }),
        ).toBeVisible();

        // Restart is available directly alongside server identity details.
        await page.getByRole("button", { name: "Restart" }).click();
        const dialog = page.getByRole("dialog", { name: "Restart server?" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Restart" }).click();

        // Dialog closes only after the UI sees the restarted process answer again.
        await expect(dialog).toBeHidden({ timeout: 30_000 });

        // Log growth proves run_server ran again after exec (not a no-op 200).
        await expect
            .poll(async () => countLoadedConfigLines(), {
                timeout: 15_000,
                message: "expected a second Loaded server config after restart",
            })
            .toBeGreaterThan(loadedBefore);

        // Remaining on home proves normal rendering survives restart.
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("tab", { name: /agent1_src/ })).toBeVisible(
            { timeout: 30_000 },
        );
        await expect(
            page.getByRole("tab", { name: /agent2_custom/ }),
        ).toBeVisible({ timeout: 30_000 });
        // Self-exec recreates TOML inventory as dormant rather than eagerly restarting children.
        await expect(
            page.getByRole("tab", { name: "lazy_managed, stopped" }),
        ).toBeVisible({ timeout: 30_000 });
    });

    test("restarts an agent from its list row", async ({ page }) => {
        const startupsBefore = await countAgentStartupLines();
        expect(startupsBefore).toBeGreaterThanOrEqual(1);

        await page.goto(`${WEB_BASE_URL}/agents`);
        const row = page.getByRole("row", { name: "Agent agent1_src" });
        await expect(row).toBeVisible();
        await row
            .getByRole("button", { name: "Open actions for agent1_src" })
            .click();
        await page
            .getByRole("dialog", { name: "agent1_src actions" })
            .getByRole("button", { name: "Restart" })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Restart agent agent1_src?",
        });
        await dialog.getByRole("button", { name: "Restart" }).click();

        // Closing requires the server to observe a replacement connection generation.
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        await expect
            .poll(async () => countAgentStartupLines(), {
                timeout: 15_000,
                message: "expected a second agent startup after restart",
            })
            .toBeGreaterThan(startupsBefore);
    });
});
