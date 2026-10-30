import { expect, test, type Page } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

const UPGRADE_URL = `${WEB_BASE_URL}/api/v1/server/upgrade`;

const SERVER_INFO_URL = `${WEB_BASE_URL}/api/v1/server`;

/**
 * Stands in for a real upgrade, which would replace the shared test binary: the endpoint
 * answers like a finished install, one server info request fails like the restarting server,
 * and later ones report `version` like the replacement process.
 */
async function simulateUpgrade(page: Page, version: string) {
    let upgraded = false;
    let restartObserved = false;

    await page.route(UPGRADE_URL, async (route) => {
        upgraded = true;
        await route.fulfill({
            json: {
                output: "install: done",
                processes: [
                    {
                        pid: 4242,
                        command: "redoor agent ws://example.test",
                        outcome: {
                            type: "left_running",
                            hint: "restart it to run the new version",
                        },
                    },
                ],
            },
        });
    });

    await page.route(SERVER_INFO_URL, async (route) => {
        if (!upgraded) {
            await route.continue();

            return;
        }

        if (!restartObserved) {
            restartObserved = true;
            await route.abort("connectionrefused");

            return;
        }

        const response = await route.fetch();
        await route.fulfill({
            response,
            json: { ...(await response.json()), version },
        });
    });
}

test.describe("Server update", () => {
    test("updates the server from the home page and reports the new version", async ({
        page,
    }) => {
        await simulateUpgrade(page, "99.0.0");
        await page.goto(`${WEB_BASE_URL}/`);

        const upgradeRequest = page.waitForRequest(
            (request) =>
                request.url() === UPGRADE_URL && request.method() === "POST",
        );

        // The button sits beside the version it replaces.
        await page.getByRole("button", { name: "Update" }).click();

        const dialog = page.getByRole("dialog", {
            name: "Update the server?",
        });

        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Update" }).click();

        // The UI asks for the latest release rather than a pinned version.
        expect((await upgradeRequest).postDataJSON()).toEqual({
            target_version: null,
        });
        // The dialog only closes after the replacement server answered again.
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        // The toast names the new version, which proves the cache was refreshed.
        await expect(page.getByText(/to 99\.0\.0\./)).toBeVisible();
        // Processes the update could not restart are named so the user restarts them.
        await expect(page.getByText(/Restart PID 4242 manually/)).toBeVisible();

        const manualRestarts = page.getByRole("list", {
            name: "Processes to restart manually",
        });

        // The command line tells the user which process the PID is.
        await expect(
            manualRestarts.getByText("4242: redoor agent ws://example.test"),
        ).toBeVisible();
        // The server's hint explains why the update could not restart it.
        await expect(
            manualRestarts.getByText("restart it to run the new version"),
        ).toBeVisible();
        // The version row shows the replacement process's version.
        await expect(page.getByText("99.0.0", { exact: true })).toBeVisible();
    });

    test("keeps the dialog open with the reason when the install fails", async ({
        page,
    }) => {
        await page.route(UPGRADE_URL, async (route) => {
            await route.fulfill({
                status: 500,
                json: {
                    error: "Upgrade failed (exit status: 1):\ninstall: error: download failed",
                },
            });
        });
        await page.goto(`${WEB_BASE_URL}/`);

        await page.getByRole("button", { name: "Update" }).click();

        const dialog = page.getByRole("dialog", {
            name: "Update the server?",
        });

        await dialog.getByRole("button", { name: "Update" }).click();

        // A failed install leaves the old server running, so the user sees why and can retry.
        await expect(dialog.getByText(/download failed/)).toBeVisible();
        await expect(dialog).toBeVisible();
    });
});
