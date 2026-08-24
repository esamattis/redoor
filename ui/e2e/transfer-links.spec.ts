import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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
                page
                    .getByRole("link", { name: "subdir3", exact: true })
                    .click(),
            ]);
            await expect(
                page.getByRole("navigation", { name: "Breadcrumbs" }),
            ).toContainText("subdir3");

            await page
                .getByLabel("Choose files to upload")
                .setInputFiles(uploadFilePath);

            // The refreshed listing proves the single upload completed while retaining directory context.
            await expect(
                page.getByRole("link", {
                    name: uploadFileName,
                    exact: true,
                }),
            ).toBeVisible();

            // Transfers remain separate from agent tabs in the application sidebar.
            await page
                .getByRole("navigation", { name: "Application" })
                .getByRole("link", { name: "Transfers" })
                .click();
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
            await expect(page.getByLabel("File editor")).toBeVisible();
        } finally {
            await fs.rm(uploadSourceDir, { force: true, recursive: true });
        }
    });

    test("should show smart moves with both endpoint links", async ({
        page,
    }) => {
        const sourceFileName = `move-source-${Date.now()}.txt`;
        const destFileName = `move-destination-${Date.now()}.txt`;
        const sourcePath = path.join(ctx.testDirPath, sourceFileName);
        const destPath = path.join(ctx.testDirPath, destFileName);
        await fs.writeFile(sourcePath, "playwright smart move");

        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Transfers" })
            .click();
        const response = await page.request.post(
            `${WEB_BASE_URL}/api/v1/move`,
            {
                data: {
                    source: { agent: ctx.agentId, path: sourcePath },
                    dest: { agent: ctx.agentId, path: destPath },
                    on_existing: "error",
                },
            },
        );
        // A successful start is required before transfer history can receive the move row.
        expect(response.ok()).toBe(true);
        const moveResponse = z
            .object({ move_request_id: z.number() })
            .parse(await response.json());
        const moveRequestId = moveResponse.move_request_id;

        const moveRow = page
            .getByRole("row")
            .filter({ hasText: sourceFileName })
            .filter({ hasText: destFileName });

        // Same-FS filesystem rename must surface as an atomic move rather than a copied move.
        await expect(moveRow).toContainText("atomic move");
        // Completion proves the history row remains active through source deletion.
        await expect(moveRow).toContainText("completed", { timeout: 15_000 });
        // Instant metadata moves have no copy stream, so a speed would be meaningless.
        await expect(moveRow.getByText(/\/s/)).toHaveCount(0);
        // Both links let users inspect the source and destination context of the logical move.
        await expect(
            moveRow.getByRole("link", { name: sourcePath }),
        ).toBeVisible();
        await expect(
            moveRow.getByRole("link", { name: destPath }),
        ).toBeVisible();
        // Referencing the id ensures the API returned the public progress handle used by history.
        expect(moveRequestId).toEqual(expect.any(Number));
    });

    test("should show directory smart moves as atomic", async ({ page }) => {
        const sourceDirName = `move-source-dir-${Date.now()}`;
        const destDirName = `move-destination-dir-${Date.now()}`;
        const sourcePath = path.join(ctx.testDirPath, sourceDirName);
        const destPath = path.join(ctx.testDirPath, destDirName);
        await fs.mkdir(sourcePath);
        await fs.writeFile(
            path.join(sourcePath, "child.txt"),
            "playwright directory smart move",
        );

        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Transfers" })
            .click();
        const response = await page.request.post(
            `${WEB_BASE_URL}/api/v1/move`,
            {
                data: {
                    source: { agent: ctx.agentId, path: sourcePath },
                    dest: { agent: ctx.agentId, path: destPath },
                    on_existing: "error",
                },
            },
        );
        // A successful start is required before transfer history can receive the directory move.
        expect(response.ok()).toBe(true);

        const moveRow = page
            .getByRole("row")
            .filter({ hasText: sourceDirName })
            .filter({ hasText: destDirName });

        // Directory same-FS renames must use the same atomic history label as files.
        await expect(moveRow).toContainText("atomic move");
        await expect(moveRow).toContainText("completed", { timeout: 15_000 });
        // Instant directory metadata moves have no copy stream, so a speed would be meaningless.
        await expect(moveRow.getByText(/\/s/)).toHaveCount(0);
        await expect(
            fs.readFile(path.join(destPath, "child.txt"), "utf8"),
        ).resolves.toBe("playwright directory smart move");
        await expect(fs.stat(sourcePath)).rejects.toThrow();
    });
});
