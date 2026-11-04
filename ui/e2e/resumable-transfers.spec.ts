import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Resumable transfer workflow", () => {
    let ctx: TestContext;
    test.beforeAll(async () => {
        ctx = await setupTestDir("resumable-transfers");
    });
    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("offers Resume and Start over when a browser copy has a partial", async ({
        page,
    }) => {
        await fs.writeFile(
            path.join(ctx.testDirPath, "subdir1", "file1.txt"),
            "existing conflict",
        );
        await page.route("**/api/v1/copy/preflight", (route) =>
            route.fulfill({
                json: {
                    resume_candidate: {
                        partial_bytes: 80 * 1024 * 1024,
                        total_bytes: 256 * 1024 * 1024,
                        updated_at: Math.floor(Date.now() / 1000),
                    },
                },
            }),
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", { name: "Select file file1.txt" })
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();
        const dialog = page.getByRole("dialog");
        // Resume choice must coexist with the independent destination conflict policy.
        await expect(
            dialog.getByRole("radio", { name: /^Resume/ }),
        ).toBeChecked();
        await expect(
            dialog.getByRole("combobox", { name: "If file1.txt exists" }),
        ).toHaveValue("rename");
        await dialog.getByRole("radio", { name: /^Start over/ }).click();
        await expect(
            dialog.getByRole("radio", { name: /^Start over/ }),
        ).toBeChecked();
        await page.getByRole("button", { name: "Close copy dialog" }).click();
        await page.getByRole("button", { name: "Clear selection" }).click();
    });

    test("pauses an active copy, discovers its partial and resumes it", async ({
        page,
    }) => {
        let state: "idle" | "active" | "paused" | "completed" = "idle";

        const source = {
            agent: ctx.agentId,
            path: `${ctx.testDirPath}/file1.txt`,
        };

        const dest = {
            agent: ctx.agent2Id,
            path: `${ctx.testDirPath}/subdir2/file1.txt`,
        };

        const transfer = {
            request_id: 981234,
            agent_id: ctx.agent2Id,
            path: dest.path,
            source,
            dest,
            direction: "copy",
            total_bytes: 256 * 1024 * 1024,
            transferred_bytes: 80 * 1024 * 1024,
            started_at: Math.floor(Date.now() / 1000),
            ended_at: null,
            state: "active",
            cancelable: true,
            pausable: true,
            verifying: false,
            resumed_bytes: 0,
            error: null,
            atomic: false,
        };

        const partial = {
            dest_agent_id: dest.agent,
            key: "a".repeat(64),
            source,
            dest,
            operation: "copy",
            partial_bytes: transfer.transferred_bytes,
            total_bytes: transfer.total_bytes,
            updated_at: transfer.started_at,
        };

        await page.route("**/api/v1/transfers/progress", (route) =>
            route.fulfill({
                json: {
                    transfers:
                        state === "paused" || state === "idle"
                            ? []
                            : [
                                  {
                                      ...transfer,
                                      request_id:
                                          state === "completed"
                                              ? transfer.request_id + 1
                                              : transfer.request_id,
                                      transferred_bytes:
                                          state === "completed"
                                              ? transfer.total_bytes
                                              : transfer.transferred_bytes,
                                      state:
                                          state === "completed"
                                              ? "completed"
                                              : "active",
                                      pausable: state === "active",
                                      cancelable: state === "active",
                                  },
                              ],
                },
            }),
        );
        await page.route("**/api/v1/partials", (route) =>
            route.fulfill({
                json: { partials: state === "paused" ? [partial] : [] },
            }),
        );
        await page.route(
            `**/api/v1/transfers/${transfer.request_id}/pause`,
            async (route) => {
                // Pause must use the dedicated durable acknowledgement endpoint.
                expect(route.request().method()).toBe("POST");
                state = "paused";
                await route.fulfill({
                    json: { transfer_id: transfer.request_id },
                });
            },
        );
        await page.route("**/api/v1/partials/resume", async (route) => {
            // The UI sends an opaque key, leaving trusted endpoint selection to the server.
            expect(route.request().postDataJSON()).toMatchObject({
                dest_agent_id: dest.agent,
                key: partial.key,
            });
            state = "completed";
            await route.fulfill({
                json: { transfer_id: transfer.request_id + 1 },
            });
        });
        await page.route("**/api/v1/copy/preflight", (route) =>
            route.fulfill({ json: { resume_candidate: null } }),
        );
        await page.route("**/api/v1/copy", async (route) => {
            // Browser selection must start a cross-agent copy through the typed REST request.
            expect(route.request().postDataJSON()).toMatchObject({
                source,
                dest,
                resume: "auto",
            });
            state = "active";
            await route.fulfill({
                json: { copy_request_id: transfer.request_id },
            });
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", { name: "Select file file1.txt" })
            .click();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agent2Name}/browser/${ctx.testDirUrlPath}/subdir2`,
        );
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();

        const admission = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/copy") &&
                response.request().method() === "POST",
        );

        await page
            .getByRole("dialog")
            .getByRole("button", { name: "Copy selected item", exact: true })
            .click();
        await admission;
        await page.goto(`${WEB_BASE_URL}/transfers`);
        await page.getByRole("button", { name: "Pause transfer" }).click();

        const inventory = page.getByRole("region", {
            name: "Resumable transfers",
        });

        // Durable discovery replaces the vanished active progress row.
        await expect(inventory).toContainText("file1.txt");
        await expect(
            page.getByRole("button", { name: "Pause transfer" }),
        ).toHaveCount(0);
        await inventory.getByRole("button", { name: /^Resume/ }).click();
        // Resume invalidates both durable inventory and active/history progress.
        await expect(inventory).toContainText("No resumable transfers");
        await expect(
            page.getByRole("row").filter({ hasText: "file1.txt" }),
        ).toContainText("completed");
    });
});
