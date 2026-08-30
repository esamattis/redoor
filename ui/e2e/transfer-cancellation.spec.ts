import { expect, test } from "@playwright/test";

import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Transfer cancellation", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("transfer-cancellation");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("confirms and cancels an active transfer from history", async ({
        page,
    }) => {
        let canceled = false;
        const transfer = {
            request_id: 987654,
            agent_id: ctx.agentId,
            path: `${ctx.testDirPath}/large-upload.bin`,
            source: null,
            dest: null,
            direction: "upload",
            total_bytes: 8_388_608,
            transferred_bytes: 1_048_576,
            started_at: Math.floor(Date.now() / 1000) - 2,
            ended_at: null,
            state: "active",
            cancelable: true,
            error: null,
            atomic: false,
        };
        await page.route("**/api/v1/transfers/progress", async (route) => {
            await route.fulfill({
                json: {
                    transfers: [
                        canceled
                            ? {
                                  ...transfer,
                                  state: "canceled",
                                  cancelable: false,
                                  ended_at: Math.floor(Date.now() / 1000),
                              }
                            : transfer,
                    ],
                },
            });
        });
        await page.route(
            `**/api/v1/transfers/${transfer.request_id}`,
            async (route) => {
                // Cancellation is the DELETE operation on the transfer resource itself.
                expect(route.request().method()).toBe("DELETE");
                canceled = true;
                await route.fulfill({
                    json: {
                        transfer_id: transfer.request_id,
                        status: "accepted",
                    },
                });
            },
        );

        await page.goto(`${WEB_BASE_URL}/transfers`);
        const row = page
            .getByRole("row")
            .filter({ hasText: "large-upload.bin" });
        await expect(
            row.getByRole("button", { name: "Cancel transfer" }),
        ).toBeVisible();
        await row.getByRole("button", { name: "Cancel transfer" }).click();
        const dialog = page.getByRole("dialog", { name: "Cancel transfer?" });
        // Confirmation prevents an icon-only misclick from stopping a live operation.
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel transfer" }).click();

        // The terminal canceled label is distinct from an error and remains in history.
        await expect(row).toContainText("canceled");
        await expect(
            page.getByRole("status").filter({
                hasText: "Transfer cancellation requested",
            }),
        ).toBeVisible();
        // Terminal rows must no longer offer a repeated destructive action.
        await expect(
            row.getByRole("button", { name: "Cancel transfer" }),
        ).toHaveCount(0);
    });
});
