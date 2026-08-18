import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    simulateTabRefocus,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("File Browser Listing", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("listing");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should navigate back to agent page using Agent button", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        // The icon link must return directly to the agent's published home from nested paths.
        await expect(
            page.getByRole("link", { name: "Agent home" }),
        ).toHaveAttribute("href", new URL(ctx.agentBrowserUrl).pathname);
        const backToAgentButton = page.getByRole("link", {
            name: ctx.agentName,
            exact: true,
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${ctx.agentId}$`));
    });

    test("should remember each agent tab location across switches and reloads", async ({
        page,
    }) => {
        const agent1DirectoryPath = `${ctx.testDirPath}/subdir1`;
        const agent1DirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(agent1DirectoryPath)}`;
        const agent2DirectoryPath = `${ctx.testDirPath}/subdir2/deep`;
        const agent2DirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(agent2DirectoryPath)}`;
        const agent2FilePath = `${agent2DirectoryPath}/nested3.txt`;
        const agent2FileUrl = `${WEB_BASE_URL}/agents/${ctx.agent2Id}/browser/${encodeFilesystemPath(agent2FilePath)}`;

        await page.goto(ctx.agentBrowserUrl);
        await page.goto(agent1DirectoryUrl);
        // The first tab must capture its directory before another agent becomes active.
        await expect(
            page.getByRole("link", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(agent1DirectoryPath)}`,
        );

        await page
            .getByRole("link", { name: "agent2_custom, connected" })
            .click();
        await page.goto(agent2DirectoryUrl);
        await page
            .getByRole("link", { name: "nested3.txt", exact: true })
            .click();
        // Opening a file must make that exact file the second tab's destination.
        await expect(page).toHaveURL(agent2FileUrl);

        await page
            .getByRole("link", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            })
            .click();
        // Switching back must restore the first agent's independent directory.
        await expect(page).toHaveURL(agent1DirectoryUrl);

        await page.reload();
        await page
            .getByRole("link", { name: "agent2_custom, connected" })
            .click();
        // Reloading must not discard the inactive tab's remembered file.
        await expect(page).toHaveURL(agent2FileUrl);
        await expect(page.getByLabel("File editor")).toBeVisible();

        await page
            .getByRole("link", {
                name: new RegExp(`^${ctx.agentName}, connected$`),
            })
            .click();
        // Both persisted entries must remain independent after the refresh.
        await expect(page).toHaveURL(agent1DirectoryUrl);
    });

    test("should display correct icons and sizes", async ({ page }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .locator(
                `a[href="/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}"]`,
            )
            .click();

        const dirLinks = page.getByRole("link", {
            name: /^(subdir1|subdir2|subdir3)$/,
        });
        await expect(dirLinks).toHaveCount(3);

        const fileEntries = page
            .locator("td")
            .filter({ hasText: /^(file1|file2)\.txt$/ });
        await expect(fileEntries).toHaveCount(2);

        const dirSizeColumn = page.getByRole("cell", {
            name: "Size for subdir1",
        });
        await expect(dirSizeColumn).toBeVisible();

        const fileSizeColumn = page.getByRole("cell", {
            name: "Size for file1.txt",
        });
        await expect(fileSizeColumn).not.toHaveText("-");
    });

    test("should refresh the file list when the tab is focused", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const appearedPath = path.join(
            ctx.testDirPath,
            "appeared-on-focus.txt",
        );
        await fs.writeFile(appearedPath, "new listing entry");
        await simulateTabRefocus(page);

        // Returning to the tab must pick up files created outside this page.
        await expect(
            page.getByRole("link", {
                name: "appeared-on-focus.txt",
                exact: true,
            }),
        ).toBeVisible();
    });

    test("should reload the file list from the reload button", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();

        const appearedPath = path.join(
            ctx.testDirPath,
            "appeared-from-reload.txt",
        );
        await fs.writeFile(appearedPath, "new listing entry");
        await page
            .getByRole("button", { name: "Reload directory listing" })
            .click();

        // The listing Reload action must pick up files created outside this page.
        await expect(
            page.getByRole("link", {
                name: "appeared-from-reload.txt",
                exact: true,
            }),
        ).toBeVisible();
    });

    test("renders directory toolbar actions as icons on mobile", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(directoryUrl);
        const filesActions = page.getByLabel("Files view actions");

        // Accessible names stay available so the icon-only toolbar remains operable.
        await expect(
            filesActions.getByRole("button", { name: "Hide hidden files" }),
        ).toBeVisible();
        await expect(
            filesActions.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();
        await expect(
            filesActions.getByRole("button", { name: "New", exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByRole("button", { name: "Upload", exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByRole("link", { name: "Download", exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByRole("button", {
                name: "Reload directory listing",
            }),
        ).toBeVisible();

        // Visible labels must collapse on a phone-width toolbar.
        await expect(filesActions.getByText("Hide hidden")).toBeHidden();
        await expect(
            filesActions.getByText("Paste", { exact: true }),
        ).toBeHidden();
        await expect(
            filesActions.getByText("New", { exact: true }),
        ).toBeHidden();
        await expect(
            filesActions.getByText("Upload", { exact: true }),
        ).toBeHidden();
        await expect(
            filesActions.getByText("Download", { exact: true }),
        ).toBeHidden();
        await expect(
            filesActions.getByText("Reload", { exact: true }),
        ).toBeHidden();

        await page.setViewportSize({ width: 1280, height: 800 });
        // Desktop keeps the same actions labeled so the compact treatment is viewport-only.
        await expect(filesActions.getByText("Hide hidden")).toBeVisible();
        await expect(
            filesActions.getByText("Paste", { exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByText("New", { exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByText("Upload", { exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByText("Download", { exact: true }),
        ).toBeVisible();
        await expect(
            filesActions.getByText("Reload", { exact: true }),
        ).toBeVisible();
    });

    test("shows one directory toolbar tooltip at a time and hides it on touchend", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        const filesActions = page.getByLabel("Files view actions");
        const toolbarTooltips = [
            {
                control: filesActions.getByRole("button", {
                    name: "Hide hidden files",
                }),
                text: "Hide hidden files",
            },
            {
                control: filesActions.getByRole("button", {
                    name: "Paste files or text",
                }),
                text: "Pasted text or images are created as new files in this directory.",
            },
            {
                control: filesActions.getByRole("button", {
                    name: "New",
                    exact: true,
                }),
                text: "New",
            },
            {
                control: filesActions.getByRole("button", {
                    name: "Upload",
                    exact: true,
                }),
                text: "Upload",
            },
            {
                control: filesActions.getByRole("link", {
                    name: "Download",
                    exact: true,
                }),
                text: "Downloads this directory as a .tar.gz archive.",
            },
            {
                control: filesActions.getByRole("button", {
                    name: "Reload directory listing",
                }),
                text: "Reload directory listing from the agent",
            },
        ] as const;

        for (const toolbarTooltip of toolbarTooltips) {
            await toolbarTooltip.control.hover();
            // Every compact toolbar action must explain itself.
            await expect(page.getByRole("tooltip")).toHaveText(
                toolbarTooltip.text,
            );
        }

        const pasteButton = toolbarTooltips[1].control;
        const reloadButton = toolbarTooltips[5].control;

        await page.mouse.move(0, 0);
        await pasteButton.focus();
        // Keyboard focus must expose the control's explanation.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Pasted text or images are created as new files in this directory.",
        );
        await reloadButton.hover();
        // A second trigger must replace the first tooltip instead of stacking.
        await expect(page.getByRole("tooltip")).toHaveCount(1);
        await expect(page.getByRole("tooltip")).toHaveText(
            "Reload directory listing from the agent",
        );

        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);

        await pasteButton.dispatchEvent("touchstart");
        // Touch users get the same explanation as hover without needing a cursor.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Pasted text or images are created as new files in this directory.",
        );
        await pasteButton.dispatchEvent("mouseenter");
        await pasteButton.dispatchEvent("touchend");
        // A tap's synthetic hover must not pin the tooltip after the finger lifts.
        await expect(page.getByRole("tooltip")).toHaveCount(0);
    });
});
