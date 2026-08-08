import fs from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

const SERVER_LOG_PATH = path.resolve("log/playwright-redoor.log");

/** Counts startup log lines so a post-reload increase proves self-exec ran. */
async function countLoadedConfigLines(): Promise<number> {
    try {
        const log = await fs.readFile(SERVER_LOG_PATH, "utf8");
        return (log.match(/Loaded server config/g) ?? []).length;
    } catch {
        return 0;
    }
}

test.describe("Reload config", () => {
    // Restarting the shared server must not interleave with other browser tests.
    test.describe.configure({ mode: "serial" });

    test("restarts the server process and keeps the UI serving", async ({
        page,
    }) => {
        const loadedBefore = await countLoadedConfigLines();
        // Baseline must exist from playwright-dev startup before we trigger reload.
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

        // Configuration reload is isolated behind its burger-menu destination.
        await page.getByRole("button", { name: "Open menu" }).click();
        await page
            .getByRole("dialog", { name: "Menu" })
            .getByRole("link", { name: "Reload config" })
            .click();
        // The dedicated page must expose the restart action before opening confirmation.
        await expect(
            page.getByRole("heading", { name: "Reload config" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Reload config" }).click();
        const dialog = page.getByRole("dialog", { name: "Reload config?" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Reload config" }).click();

        // Dialog closes only after the UI sees the restarted process answer again.
        await expect(dialog).toBeHidden({ timeout: 30_000 });

        // Log growth proves run_server ran again after exec (not a no-op 200).
        await expect
            .poll(async () => countLoadedConfigLines(), {
                timeout: 15_000,
                message: "expected a second Loaded server config after reload",
            })
            .toBeGreaterThan(loadedBefore);

        // Returning home through the menu proves normal navigation survives restart.
        await page.getByRole("button", { name: "Open menu" }).click();
        await page
            .getByRole("dialog", { name: "Menu" })
            .getByRole("link", { name: "Server home" })
            .click();
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("tab", { name: /agent1_src/ })).toBeVisible(
            { timeout: 30_000 },
        );
        await expect(
            page.getByRole("tab", { name: /agent2_custom/ }),
        ).toBeVisible({ timeout: 30_000 });
    });
});
