import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
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
            await page.goto(ctx.agentBrowserUrl);
            await page
                .locator(
                    `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
                )
                .click();
            const uploadDestinationUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(`${ctx.testDirPath}/subdir3`)}`;
            await Promise.all([
                page.waitForURL(uploadDestinationUrl),
                page.getByRole("link", { name: "subdir3" }).click(),
            ]);
            await expect(
                page.getByRole("navigation", { name: "Breadcrumbs" }),
            ).toContainText("subdir3");

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
            await expect(pathLink).toHaveCount(0, { timeout: 15_000 });

            // The source link disappearing proves the pending route committed instead of only updating browser history.
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
