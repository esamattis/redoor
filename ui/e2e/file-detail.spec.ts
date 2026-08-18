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

    test("should copy, diff, and view from the unified Sync view", async ({
        page,
    }) => {
        const wideMarker = "W".repeat(240);
        const sourcePath = path.join(
            ctx.testDirPath,
            `sync-source-${Date.now()}.txt`,
        );
        const destinationPath = path.join(
            ctx.testDirPath,
            `sync-dest-${Date.now()}.txt`,
        );
        await fs.writeFile(sourcePath, `left-${wideMarker}\n`);
        await fs.writeFile(destinationPath, `right-${wideMarker}\n`);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(sourcePath)}?view=diff`,
        );

        // Legacy diff bookmarks must replace-redirect onto the unified Sync workspace.
        await expect(page).toHaveURL(/\?view=sync$/);
        await expect(
            page.getByRole("link", { name: "Diff", exact: true }),
        ).toHaveCount(0);
        // Conflict policy stays off the page until a destination actually exists.
        await expect(
            page.getByRole("checkbox", { name: "Override existing" }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Sync agent")).toHaveValue(ctx.agent2Id);
        await page.getByLabel("Sync path").fill(destinationPath);
        await page.getByRole("button", { name: "Copy", exact: true }).click();

        const confirmation = page.getByRole("dialog", {
            name: "Copy file?",
        });
        // Copy must not probe conflicts or start a transfer until it is explicitly confirmed.
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("button", { name: "Cancel" }).click();
        await expect(
            page.getByRole("dialog", {
                name: "Destination items already exist",
            }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await confirmation
            .getByRole("button", { name: "Confirm copy" })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // An existing destination must ask for a policy instead of starting the copy.
        await expect(dialog).toBeVisible();
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();

        // Final transfer progress, rather than copy acceptance, drives the success report.
        await expect(page.getByRole("status")).toContainText(
            "Copy completed successfully",
        );
        await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe(
            `left-${wideMarker}\n`,
        );

        await fs.writeFile(destinationPath, `right-${wideMarker}\n`);
        await page.getByRole("button", { name: "Diff", exact: true }).click();

        const diff = page.getByRole("region", { name: "File diff" });
        // Signed fragments prove both endpoints reached the unified-diff API through Sync.
        await expect(diff.getByText(/left-/)).toBeVisible();
        await expect(diff.getByText(/right-/)).toBeVisible();
        const overflow = await diff.evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
        }));
        // A wide hunk must scroll inside the labeled region instead of clipping the page.
        expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Sync", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        // A real href lets middle-click open the destination in a new tab.
        await expect(
            page.getByRole("link", { name: "view", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(destinationPath)}`,
        );
        await page.getByRole("link", { name: "view", exact: true }).click();
        // Target navigation uses the selected destination agent and leaves the source Sync view behind.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(destinationPath)}`,
        );
        await expect(page.getByLabel("File editor")).toBeVisible();
    });

    test("should reverse file sync operations and diff ordering", async ({
        page,
    }) => {
        const currentPath = path.join(
            ctx.testDirPath,
            `sync-direction-current-${Date.now()}.txt`,
        );
        const selectedPath = path.join(
            ctx.testDirPath,
            `sync-direction-selected-${Date.now()}.txt`,
        );
        const changedSelectedPath = path.join(
            ctx.testDirPath,
            `sync-direction-changed-${Date.now()}.txt`,
        );
        await fs.writeFile(currentPath, "current endpoint\n");
        await fs.writeFile(selectedPath, "selected endpoint\n");
        await fs.writeFile(changedSelectedPath, "changed selected endpoint\n");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(currentPath)}?view=sync`,
        );
        await page.getByLabel("Sync path").fill(selectedPath);

        await page.getByLabel("Sync path").fill("~/file1.txt");
        // Tilde paths must navigate relative to the selected agent's home, not the current agent's home.
        await expect(
            page.getByRole("link", { name: "view", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(path.join(ctx.agent2Home, "file1.txt"))}`,
        );
        await page.getByLabel("Sync path").fill(selectedPath);

        const forwardDirection = page.getByRole("radio", {
            name: "Current path to selected path",
        });
        const reverseDirection = page.getByRole("radio", {
            name: "Selected path to current path",
        });
        // Existing Sync behavior remains selected by default for bookmarked workflows.
        await expect(forwardDirection).toBeChecked();
        const forwardDiffRequest = page.waitForRequest(
            (request) =>
                request.url().endsWith("/api/v1/diff") &&
                request.method() === "POST",
        );
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        const forwardDiffBody = (await forwardDiffRequest).postDataJSON();
        // The default direction sends the browser file as the ordered left input.
        expect(forwardDiffBody).toMatchObject({
            left: { agent: ctx.agentId, path: currentPath },
            right: { agent: ctx.agent2Id, path: selectedPath },
        });
        const forwardDiff = page.getByRole("region", { name: "File diff" });
        // Rendered signs must describe the current endpoint as the source side.
        const forwardCurrentRow = forwardDiff
            .getByRole("row")
            .filter({ hasText: "current endpoint" });
        const forwardSelectedRow = forwardDiff
            .getByRole("row")
            .filter({ hasText: "selected endpoint" });
        await expect(
            forwardCurrentRow.getByText("-", { exact: true }),
        ).toBeVisible();
        await expect(
            forwardSelectedRow.getByText("+", { exact: true }),
        ).toBeVisible();

        await reverseDirection.check();
        // Changing direction removes a result whose signs describe the old endpoint order.
        await expect(
            page.getByRole("region", { name: "File diff" }),
        ).toHaveCount(0);
        const reverseDiffRequest = page.waitForRequest(
            (request) =>
                request.url().endsWith("/api/v1/diff") &&
                request.method() === "POST",
        );
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        const reverseDiffBody = (await reverseDiffRequest).postDataJSON();
        // Reverse mode swaps the API inputs so deletion and addition signs follow transfer direction.
        expect(reverseDiffBody).toMatchObject({
            left: { agent: ctx.agent2Id, path: selectedPath },
            right: { agent: ctx.agentId, path: currentPath },
        });
        const reverseDiff = page.getByRole("region", { name: "File diff" });
        // Reversing the endpoint order must reverse the visible removal and addition rows.
        const reverseSelectedRow = reverseDiff
            .getByRole("row")
            .filter({ hasText: "selected endpoint" });
        const reverseCurrentRow = reverseDiff
            .getByRole("row")
            .filter({ hasText: "current endpoint" });
        await expect(
            reverseSelectedRow.getByText("-", { exact: true }),
        ).toBeVisible();
        await expect(
            reverseCurrentRow.getByText("+", { exact: true }),
        ).toBeVisible();

        await page.getByLabel("Sync path").fill(changedSelectedPath);
        // Editing either endpoint also clears comparisons that no longer describe the form.
        await expect(
            page.getByRole("region", { name: "File diff" }),
        ).toHaveCount(0);
        // View always targets the selected endpoint even when that endpoint is the source.
        await expect(
            page.getByRole("link", { name: "view", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(changedSelectedPath)}`,
        );
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await page
            .getByRole("dialog", { name: "Copy file?" })
            .getByRole("button", { name: "Confirm copy" })
            .click();
        const dialog = page.getByRole("dialog", {
            name: "Destination items already exist",
        });
        // Reverse conflict detection probes the current browser path, not the selected source.
        await expect(dialog).toBeVisible();
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        await dialog.getByRole("button", { name: "Continue copying" }).click();
        await expect(page.getByRole("status")).toContainText(
            "Copy completed successfully",
        );
        // Disk contents prove the selected endpoint was copied back to the current endpoint.
        await expect(fs.readFile(currentPath, "utf8")).resolves.toBe(
            "changed selected endpoint\n",
        );

        await fs.writeFile(changedSelectedPath, "moved selected endpoint\n");
        let releaseMoveRequest: (() => void) | undefined;
        const moveRequestBlocked = new Promise<void>((resolve) => {
            releaseMoveRequest = resolve;
        });
        await page.route("**/api/v1/move", async (route) => {
            await moveRequestBlocked;
            await route.continue();
        });
        await page.getByRole("button", { name: "Move", exact: true }).click();
        const moveConfirmation = page.getByRole("dialog", {
            name: "Move file?",
        });
        // Move requires an explicit destructive confirmation before conflict handling.
        await expect(moveConfirmation).toBeVisible();
        await moveConfirmation
            .getByRole("button", { name: "Confirm move" })
            .click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("radio", { name: "Replace existing" }).check();
        await dialog.getByRole("button", { name: "Continue moving" }).click();
        // Endpoint order cannot change while the reverse move request is in flight.
        await expect(forwardDirection).toBeDisabled();
        await expect(reverseDirection).toBeDisabled();
        await expect(page.getByLabel("Sync agent")).toBeDisabled();
        await expect(page.getByLabel("Sync path")).toBeDisabled();
        releaseMoveRequest?.();
        await expect(page.getByRole("status")).toContainText(
            "Move completed successfully",
        );
        // Reverse Move removes the selected source after replacing the current destination.
        await expect(fs.readFile(currentPath, "utf8")).resolves.toBe(
            "moved selected endpoint\n",
        );
        await expect(fs.access(changedSelectedPath)).rejects.toThrow();
    });

    test("should copy to a missing path and move to a new path from Sync", async ({
        page,
    }) => {
        const sourcePath = path.join(
            ctx.testDirPath,
            `sync-missing-source-${Date.now()}.txt`,
        );
        const copyDestinationPath = path.join(
            ctx.testDirPath,
            `sync-missing-dest-${Date.now()}.txt`,
        );
        const moveSourcePath = path.join(
            ctx.testDirPath,
            `sync-move-source-${Date.now()}.txt`,
        );
        const moveDestinationPath = path.join(
            ctx.testDirPath,
            `sync-move-dest-${Date.now()}.txt`,
        );
        await fs.writeFile(sourcePath, "copy-missing\n");
        await fs.writeFile(moveSourcePath, "move-new\n");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(sourcePath)}?view=sync`,
        );

        await page.getByLabel("Sync path").fill(copyDestinationPath);
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await page
            .getByRole("dialog", { name: "Copy file?" })
            .getByRole("button", { name: "Confirm copy" })
            .click();
        // A missing destination must start immediately instead of asking for a conflict policy.
        await expect(
            page.getByRole("dialog", {
                name: "Destination items already exist",
            }),
        ).toHaveCount(0);
        await expect(page.getByRole("status")).toContainText(
            "Copy completed successfully",
        );
        await expect(fs.readFile(copyDestinationPath, "utf8")).resolves.toBe(
            "copy-missing\n",
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(moveSourcePath)}?view=sync`,
        );
        await page.getByLabel("Sync path").fill(moveDestinationPath);
        await page.getByRole("button", { name: "Move", exact: true }).click();
        await page
            .getByRole("dialog", { name: "Move file?" })
            .getByRole("button", { name: "Confirm move" })
            .click();
        // Move to a new path is a primary Sync action and must not reuse the copy-only dialog path.
        await expect(
            page.getByRole("dialog", {
                name: "Destination items already exist",
            }),
        ).toHaveCount(0);
        await expect(page.getByRole("status")).toContainText(
            "Move completed successfully",
        );
        await expect(fs.readFile(moveDestinationPath, "utf8")).resolves.toBe(
            "move-new\n",
        );
        await expect(fs.access(moveSourcePath)).rejects.toThrow();
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
