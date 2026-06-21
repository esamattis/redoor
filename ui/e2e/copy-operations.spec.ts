import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Copy Operations", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("copy");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should copy a file to a newly created directory within the same agent", async ({
        page,
    }) => {
        const copyTargetDirName = `copy-target-${Date.now()}`;
        const copyTargetDirPath = path.join(ctx.testDirPath, copyTargetDirName);
        const copiedFilePath = path.join(copyTargetDirPath, "file1.txt");

        await fs.rm(copyTargetDirPath, { force: true, recursive: true });

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        // Create a new directory that will serve as the copy destination.
        await page.getByRole("button", { name: "Create directory" }).click();
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toBeVisible();
        await page
            .getByRole("textbox", { name: "Directory name" })
            .fill(copyTargetDirName);
        await page
            .getByRole("dialog", { name: "Create directory" })
            .getByRole("button", { name: "Create directory", exact: true })
            .click();
        await expect(
            page.getByRole("link", { name: copyTargetDirName, exact: true }),
        ).toBeVisible();

        // Select the file to copy while still in the parent directory.
        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();

        // The selected-items panel must appear so the test can interact with the copy action.
        await expect(
            page.getByRole("button", { name: "Copy selected items" }),
        ).toBeVisible();

        // Navigate into the newly created directory to set it as the copy destination.
        await page
            .getByRole("link", { name: copyTargetDirName, exact: true })
            .click();

        // The selection persists across navigation, so the copy button remains available.
        await expect(
            page.getByRole("button", { name: "Copy selected items" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Copy selected items" }).click();

        // Polling the filesystem is more reliable than waiting on UI messages because
        // the selected-items panel disappears immediately after a successful copy.
        await expect
            .poll(async () => {
                try {
                    await fs.stat(copiedFilePath);
                    return "exists";
                } catch {
                    return "missing";
                }
            })
            .toBe("exists");

        // Reload the page because the directory listing does not auto-refresh after copy.
        await page.reload();

        // Seeing the copied file in the destination directory proves the copy landed in the right place.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const copiedContent = await fs.readFile(copiedFilePath, "utf-8");

        // Matching contents proves the copy preserved the original file bytes.
        expect(copiedContent).toBe("content1");
    });

    test("should copy a file from one agent to another agent", async ({
        page,
    }) => {
        const crossAgentCopiedPath = path.join(
            "dev_agents",
            "agent2",
            "file1.txt",
        );

        await fs.rm(crossAgentCopiedPath, { force: true });

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirName}"]`,
            )
            .click();

        // Select the file on the source agent.
        await page
            .getByRole("button", { name: "Select file file1.txt" })
            .click();

        await expect(
            page.getByRole("button", { name: "Copy selected items" }),
        ).toBeVisible();

        // Navigate to the destination agent via the top tab strip so the
        // selection state survives the client-side navigation.
        await page.getByRole("tab", { name: "agent2_custom" }).click();

        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser`,
        );

        // The selection persists across agents, so the copy button remains available.
        await expect(
            page.getByRole("button", { name: "Copy selected items" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Copy selected items" }).click();

        // Polling the filesystem is more reliable than waiting on UI messages because
        // the selected-items panel disappears immediately after a successful copy.
        await expect
            .poll(async () => {
                try {
                    await fs.stat(crossAgentCopiedPath);
                    return "exists";
                } catch {
                    return "missing";
                }
            })
            .toBe("exists");

        // Reload the page because the directory listing does not auto-refresh after copy.
        await page.reload();

        // Seeing the copied file in the destination agent proves the cross-agent copy landed in the right place.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const copiedContent = await fs.readFile(crossAgentCopiedPath, "utf-8");

        // Matching contents proves the cross-agent copy preserved the original file bytes.
        expect(copiedContent).toBe("content1");

        await fs.rm(crossAgentCopiedPath, { force: true });
    });
});
