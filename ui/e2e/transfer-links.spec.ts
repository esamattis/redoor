import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Transfer Path Links", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("links");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should navigate to browser view from transfer path link", async ({
        page,
    }) => {
        const uploadSourceDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-transfer-link-"),
        );
        const uploadFileName = `link-test-${Date.now()}.txt`;
        const uploadFilePath = path.join(uploadSourceDir, uploadFileName);
        await fs.writeFile(uploadFilePath, "transfer link test content");

        try {
            await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
            await page
                .locator(
                    `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
                )
                .click();
            await page.getByRole("link", { name: "subdir3" }).click();

            await page
                .getByLabel("Choose files to upload")
                .setInputFiles(uploadFilePath);

            // Wait for upload completion feedback before switching pages.
            await expect(
                page.getByText(`Uploaded ${uploadFileName}`),
            ).toBeVisible();

            // Navigate to the transfers history page via the top tab strip.
            await page.getByRole("tab", { name: "Transfers" }).click();
            await expect(page).toHaveURL(new RegExp("/transfers$"));

            // Find the completed upload transfer row.
            const transferRow = page
                .getByRole("row")
                .filter({ hasText: uploadFileName })
                .filter({ hasText: "completed" })
                .last();
            await expect(transferRow).toBeVisible();

            // The path in the transfer row should link to the browser view.
            const pathLink = transferRow
                .getByRole("link")
                .filter({ hasText: uploadFileName });
            await expect(pathLink).toBeVisible();

            await pathLink.click();

            // Should navigate to the file detail view in the browser.
            await expect(page).toHaveURL(
                new RegExp(
                    `/agents/${ctx.agentId}/browser/.*${uploadFileName}$`,
                ),
            );
            await expect(
                page.getByRole("heading", { name: "File name" }),
            ).toContainText(uploadFileName);
        } finally {
            await fs.rm(uploadSourceDir, { force: true, recursive: true });
        }
    });
});
