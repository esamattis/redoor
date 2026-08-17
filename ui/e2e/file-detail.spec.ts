import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File Detail View", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("detail");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should navigate to file detail view", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("file1.txt");
        const metadata = page.getByRole("region", { name: "Metadata" });
        // Scoping these labels verifies the metadata cards without conflicting with permission row labels.
        await expect(metadata.getByText("Size")).toBeVisible();
        await expect(metadata.getByText("Owner")).toBeVisible();
        await expect(metadata.getByText("Group")).toBeVisible();
        await expect(metadata.getByText("UID")).toBeVisible();
        await expect(metadata.getByText("GID")).toBeVisible();
        // The permissions heading verifies the new access grid is part of the file detail view.
        await expect(
            page.getByRole("heading", { name: "Permissions" }),
        ).toBeVisible();
        // A visible owner read cell proves raw mode bits are translated into understandable access rights.
        await expect(page.getByLabel("Owner Read: allowed")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Download", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", {
                name: "Go to the parent directory",
                exact: true,
            }),
        ).toBeVisible();
        const fileView = page.getByLabel("File view");
        // File details use the same explicit active-state semantics as directory views.
        await expect(
            fileView.getByRole("link", { name: "Details", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        // Editable files keep Edit as the first alternate representation in the same switch.
        await expect(
            fileView.getByRole("link", { name: "Edit", exact: true }),
        ).toBeVisible();
    });

    test("should display correct file size on detail view", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        const sizeText = await page.getByLabel("File size value").textContent();

        expect(sizeText).toBeDefined();
        expect(sizeText).not.toBe("-");
    });

    test("should diff a file against another agent", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}`,
        );

        await page.getByRole("link", { name: "Diff", exact: true }).click();

        // The comparison starts with the first other agent and the currently selected file path.
        await expect(page.getByLabel("Diff agent")).toHaveValue(ctx.agent2Id);
        await expect(page.getByLabel("Diff path")).toHaveValue(filePath);
        await page
            .getByLabel("Diff path")
            .fill(path.join(ctx.testDirPath, "file2.txt"));
        await page.getByRole("button", { name: "Generate diff" }).click();

        const diff = page.getByRole("region", { name: "File diff" });
        // Signed lines prove the form submitted both selected endpoints to the unified diff API.
        await expect(diff.getByText(/-content1/)).toBeVisible();
        await expect(diff.getByText(/\+content2/)).toBeVisible();
        // The active navigation state keeps the diff representation addressable by URL.
        await expect(page).toHaveURL(/\?view=diff$/);
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Diff", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await page
            .getByRole("button", { name: "Open target file", exact: true })
            .click();
        // Target navigation uses the selected comparison agent and leaves the source diff view behind.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(path.join(ctx.testDirPath, "file2.txt"))}`,
        );
        await expect(page.getByLabel("File editor")).toBeVisible();
    });

    test("should sync a file with explicit override", async ({ page }) => {
        const sourcePath = path.join(ctx.testDirPath, "file1.txt");
        const destinationPath = path.join(
            ctx.testDirPath,
            `synced-file-${Date.now()}.txt`,
        );
        await fs.writeFile(destinationPath, "old content");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(sourcePath)}`,
        );

        await page.getByRole("link", { name: "Sync", exact: true }).click();

        // The sync target defaults consistently with Diff while remaining editable.
        await expect(page.getByLabel("Sync agent")).toHaveValue(ctx.agent2Id);
        await page.getByLabel("Sync path").fill(destinationPath);
        await page.getByRole("button", { name: "Sync", exact: true }).click();
        // Existing files remain untouched unless replacement is explicitly enabled.
        await expect(page.getByRole("alert")).toContainText(
            "Destination already exists",
        );
        await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe(
            "old content",
        );

        const overrideExisting = page.getByRole("checkbox", {
            name: "Override existing",
        });
        await overrideExisting.click();
        // The button-based checkbox must expose that the retry may replace the destination.
        await expect(overrideExisting).toHaveAttribute("aria-checked", "true");
        await page.getByRole("button", { name: "Sync", exact: true }).click();

        // Final transfer progress, rather than copy acceptance, drives the success report.
        await expect(page.getByRole("status")).toContainText(
            "Sync completed successfully",
        );
        await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe(
            "content1",
        );
        await expect(page).toHaveURL(/\?view=sync$/);
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Sync", exact: true }),
        ).toHaveAttribute("aria-current", "page");
    });

    test("should rename a file and update the detail URL", async ({ page }) => {
        const originalName = `rename-file-${Date.now()}.txt`;
        const renamedName = `renamed-file-${Date.now()}.txt`;
        const originalPath = path.join(ctx.testDirPath, originalName);
        const renamedPath = path.join(ctx.testDirPath, renamedName);
        await fs.writeFile(originalPath, "rename content");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(originalPath)}?view=details`,
        );

        await page
            .getByRole("button", { name: "File actions", exact: true })
            .click();
        // The compact details menu keeps destructive actions away from the primary download control.
        await expect(
            page.getByRole("button", { name: "Delete file", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        const renameInput = page.getByRole("textbox", { name: "Rename file" });
        // The focused rename workflow starts with the current leaf name.
        await expect(renameInput).toHaveValue(originalName);
        await renameInput.fill(renamedName);
        await page.getByRole("button", { name: "Rename", exact: true }).click();

        // Navigation follows the renamed file so reloads do not target the stale source path.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(renamedPath)}?view=details`,
        );
        // The details heading and filesystem contents both reflect the atomic rename result.
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toHaveText(renamedName);
        await expect(fs.readFile(renamedPath, "utf8")).resolves.toBe(
            "rename content",
        );
    });

    test("should navigate back from file detail view", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        const backButton = page.getByRole("link", {
            name: "Go to the parent directory",
            exact: true,
        });
        await backButton.click();

        // This confirms returning from detail view restores the file list without matching the selection control cell.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
    });

    test("should navigate from a file with Backspace", async ({ page }) => {
        const filePath = path.join(ctx.testDirPath, "file1.txt");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=details`;
        await page.goto(fileUrl);
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");

        await page.keyboard.press("Backspace");

        // File-level Backspace returns to the containing directory rather than browser history.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
    });

    test("should navigate back to agent from file detail view", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        const backToAgentButton = page.getByRole("link", {
            name: ctx.agentName,
            exact: true,
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${ctx.agentId}$`));
    });

    test("should navigate to nested file detail view", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();

        await page
            .getByRole("link", { name: "nested1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("nested1.txt");
        await expect(page.getByText("Size")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();

        const backLink = page.getByRole("link", {
            name: "Go to the parent directory",
            exact: true,
        });
        await backLink.click();

        // These assertions verify the nested directory listing is restored after using the back link.
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "nested2.txt", exact: true }),
        ).toBeVisible();
    });

    test("should create and consume one-time shareable links", async ({
        page,
        playwright,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();
        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        await page.getByRole("link", { name: "Details", exact: true }).click();

        const shareableLinks = page.getByRole("region", {
            name: "Shareable links",
        });
        const createLinkButton = shareableLinks.getByRole("button", {
            name: "Create shareable link",
        });

        // Metadata loading must only return existing tokens and must not create one as a side effect.
        await expect(
            shareableLinks.getByRole("link", {
                name: /\?one_time_token=/,
            }),
        ).toHaveCount(0);

        await createLinkButton.click();
        await expect(createLinkButton).toBeEnabled();
        await createLinkButton.click();

        const oneTimeLinks = shareableLinks.getByRole("link", {
            name: /\?one_time_token=/,
        });
        // Two independently created links prove creation remains available after the first request succeeds.
        await expect(oneTimeLinks).toHaveCount(2);

        const firstUrl = await oneTimeLinks.nth(0).getAttribute("href");
        const secondUrl = await oneTimeLinks.nth(1).getAttribute("href");
        if (firstUrl === null || secondUrl === null) {
            throw new Error("Shareable links did not expose their URLs");
        }

        // The raw URL must carry only the one-time credential query parameter.
        expect(new URL(firstUrl).search).toMatch(/^\?one_time_token=[^&?]+$/);
        // The displayed wget command must preserve the server-provided filename.
        await expect(
            shareableLinks.getByText(
                `wget --content-disposition "${firstUrl}"`,
                { exact: true },
            ),
        ).toBeVisible();
        // The displayed curl command must request remote headers and filename handling.
        await expect(
            shareableLinks.getByText(`curl -JO "${firstUrl}"`, {
                exact: true,
            }),
        ).toBeVisible();
        // A named copy control keeps the raw link usable without relying on visual icons.
        await expect(
            shareableLinks.getByRole("button", {
                name: "Copy shareable link 1",
            }),
        ).toBeVisible();
        // Users must be warned before sharing that the credential is single-use.
        await expect(
            shareableLinks.getByText("This link works only once.", {
                exact: false,
            }),
        ).toHaveCount(2);

        const anonymous = await playwright.request.newContext();
        const firstUse = await anonymous.get(firstUrl);

        // Anonymous clients can retrieve the exact file contents on the token's first use.
        expect(await firstUse.text()).toBe("content1");
        // Content-Disposition allows browsers and command-line clients to retain the source filename.
        expect(firstUse.headers()["content-disposition"]).toContain(
            "file1.txt",
        );

        const secondUse = await anonymous.get(firstUrl);
        // Reusing the consumed credential must be rejected rather than downloading the file again.
        expect(secondUse.status()).toBe(401);
        await anonymous.dispose();

        await page.reload();

        const reloadedShareableLinks = page.getByRole("region", {
            name: "Shareable links",
        });
        // Reloaded metadata must omit the consumed token so its stale link disappears.
        await expect(
            reloadedShareableLinks.getByRole("link", {
                name: firstUrl,
                exact: true,
            }),
        ).toHaveCount(0);
        // Metadata must retain the other outstanding token across the reload.
        await expect(
            reloadedShareableLinks.getByRole("link", {
                name: secondUrl,
                exact: true,
            }),
        ).toBeVisible();

        await reloadedShareableLinks
            .getByRole("button", { name: "Create shareable link" })
            .click();
        // Creation remains repeatable even after another token has been consumed and metadata refreshed.
        await expect(
            reloadedShareableLinks.getByRole("link", {
                name: /\?one_time_token=/,
            }),
        ).toHaveCount(2);
    });
});
