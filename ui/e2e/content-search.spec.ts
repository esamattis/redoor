import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";

import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Agent content search", () => {
    let ctx: TestContext;
    let gitRootRepositoryPath: string;
    let gitRootNestedPath: string;
    let gitRootOutsidePath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("content-search");
        gitRootRepositoryPath = path.join(ctx.testDirPath, "git-root-search");
        gitRootNestedPath = path.join(gitRootRepositoryPath, "nested");
        gitRootOutsidePath = path.join(
            os.tmpdir(),
            `redoor-content-search-outside-${process.pid}`,
        );
        await fs.mkdir(gitRootNestedPath, { recursive: true });
        await fs.mkdir(gitRootOutsidePath, { recursive: true });
        await fs.writeFile(
            path.join(gitRootRepositoryPath, "root-only.txt"),
            "git-root-unique-value\n",
        );
        await fs.writeFile(
            path.join(gitRootNestedPath, "nested.txt"),
            "nested-unique-value\n",
        );
        await $`git -C ${gitRootRepositoryPath} init`;
        await fs.writeFile(
            path.join(ctx.testDirPath, "search-target.txt"),
            `first line
unique-search-value
last line`,
        );
        await fs.mkdir(path.join(ctx.testDirPath, ".hidden-search"));
        await fs.writeFile(
            path.join(ctx.testDirPath, ".hidden-search", "target.txt"),
            "hidden-search-value",
        );
        await fs.writeFile(
            path.join(ctx.testDirPath, ".gitignore"),
            `ignored-search.txt
`,
        );
        await fs.writeFile(
            path.join(ctx.testDirPath, "ignored-search.txt"),
            "ignored-search-value",
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(gitRootOutsidePath, { force: true, recursive: true });
    });

    test("opens from shared entry points and restores results after navigation", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const launcher = page.getByRole("button", {
            name: "Search agent content",
        });
        const home = page.getByRole("link", { name: "Agent home" });
        const up = page.getByRole("link", {
            name: "Go to the parent directory",
        });
        await expect(launcher).toHaveCount(1);
        const [homeBounds, launcherBounds, upBounds] = await Promise.all([
            home.boundingBox(),
            launcher.boundingBox(),
            up.boundingBox(),
        ]);
        // Browser chrome owns exactly one launcher and places it between Home and Up.
        expect(homeBounds?.x ?? 0).toBeLessThan(launcherBounds?.x ?? 0);
        expect(launcherBounds?.x ?? 0).toBeLessThan(upBounds?.x ?? 0);
        await launcher.hover();
        // The launcher advertises the cross-platform chord rather than hiding the workflow.
        await expect(
            page.getByRole("tooltip", {
                name: "Search agent content (Cmd/Ctrl+K)",
            }),
        ).toBeVisible();
        await launcher.click();

        const dialog = page.getByRole("dialog", {
            name: "Search agent content",
        });
        // Directory metadata must scope grep to the directory currently being browsed.
        await expect(dialog).toContainText(`Searching in ${ctx.testDirPath}`);
        const desktopBounds = await dialog.boundingBox();
        const desktopViewport = page.viewportSize();
        // Desktop search remains modal while using most of the available workspace.
        expect(desktopBounds?.width ?? 0).toBeGreaterThan(
            desktopViewport ? desktopViewport.width * 0.7 : 0,
        );
        expect(desktopBounds?.height ?? 0).toBeGreaterThan(
            desktopViewport ? desktopViewport.height * 0.7 : 0,
        );
        const searchInput = dialog.getByLabel("Search content");
        await expect(searchInput).toBeFocused();
        const regexToggle = dialog.getByRole("button", {
            name: "Use regular expressions",
        });
        await regexToggle.focus();
        const dialogTooltip = page.getByRole("tooltip", {
            name: "Use regular expressions",
        });
        await expect(dialogTooltip).toBeVisible();
        const tooltipLayer = await dialogTooltip.evaluate((tooltip) => ({
            parentRole: tooltip.parentElement?.getAttribute("role"),
            zIndex: getComputedStyle(tooltip).zIndex,
        }));
        // Portaling into the modal top layer with a raised z-index keeps the tooltip above it.
        expect(tooltipLayer).toEqual({ parentRole: "dialog", zIndex: "80" });
        await searchInput.focus();
        const historyLength = await page.evaluate(() => history.length);
        let startFirstRequest: (() => void) | undefined;
        const firstRequestStarted = new Promise<void>((resolve) => {
            startFirstRequest = resolve;
        });
        let releaseFirstRequest: (() => void) | undefined;
        const firstRequestReleased = new Promise<void>((resolve) => {
            releaseFirstRequest = resolve;
        });
        let activeRequests = 0;
        let maximumActiveRequests = 0;
        let firstRequestFailed = false;
        page.on("request", (request) => {
            if (!request.url().includes("/grep/")) return;
            activeRequests += 1;
            maximumActiveRequests = Math.max(
                maximumActiveRequests,
                activeRequests,
            );
        });
        page.on("requestfinished", (request) => {
            if (request.url().includes("/grep/")) activeRequests -= 1;
        });
        page.on("requestfailed", (request) => {
            if (!request.url().includes("/grep/")) return;
            activeRequests -= 1;
            if (
                new URL(request.url()).searchParams.get("query") === "content1"
            ) {
                firstRequestFailed = true;
            }
        });
        await page.route("**/grep/**", async (route) => {
            if (
                new URL(route.request().url()).searchParams.get("query") !==
                "content1"
            ) {
                await route.continue();
                return;
            }
            startFirstRequest?.();
            await firstRequestReleased;
            await route.continue().catch(() => undefined);
        });
        await searchInput.fill("content1");
        await firstRequestStarted;
        await searchInput.fill("unique-search-value");
        await expect(page).toHaveURL(/q=unique-search-value/);
        // Replacing query state keeps each keystroke out of browser history.
        await expect
            .poll(() => page.evaluate(() => history.length))
            .toBe(historyLength);

        const result = dialog.getByRole("button", {
            name: /Open .*search-target\.txt at line 2/,
        });
        // Grep results expose their one-based line destination.
        await expect(result).toBeVisible();
        // Superseding an in-flight query must not leave stale matches in the result set.
        await expect(
            dialog.getByRole("button", { name: /Open .*file1\.txt/ }),
        ).toHaveCount(0);
        await expect.poll(() => firstRequestFailed).toBe(true);
        releaseFirstRequest?.();
        // The obsolete HTTP request is aborted before its replacement starts.
        expect(maximumActiveRequests).toBe(1);
        await result.click();
        await expect(page).toHaveURL(/search-target\.txt\?line=2$/);

        await page.goBack();
        // The prior entry retains q so Back restores the dialog and completed search.
        await expect(dialog).toBeVisible();
        await expect(searchInput).toHaveValue("unique-search-value");
        await expect(result).toBeVisible();

        await dialog
            .getByRole("button", { name: "Close content search" })
            .click();
        await expect(dialog).toBeHidden();
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/logs`);
        await expect(
            page.getByRole("button", { name: "Search agent content" }),
        ).toBeVisible();
        await page.keyboard.press("ControlOrMeta+k");
        // The route-level shortcut also works outside the browser and falls back to agent home.
        await expect(dialog).toBeVisible();
        await expect(searchInput).toBeFocused();
        await expect(dialog).toContainText(`Searching in ${ctx.agentHome}`);
    });

    test("uses recursive search preferences when URL options are absent", async ({
        page,
    }) => {
        await page.route("**/api/v1/user/state", async (route) => {
            if (route.request().method() !== "GET") {
                await route.continue();
                return;
            }
            await route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({
                    state: {
                        showHiddenFiles: true,
                        theme: "system",
                        bookmarks: [],
                        vimMode: false,
                        wrapEditorLines: false,
                        recursiveSearchTimeoutSeconds: 17,
                        recursiveSearchIncludeHidden: true,
                        recursiveSearchRespectGitignore: false,
                    },
                }),
            });
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}?q=`,
        );

        const dialog = page.getByRole("dialog", {
            name: "Search agent content",
        });
        // Content search follows the same remembered defaults as recursive filename search.
        await expect(
            dialog.getByLabel("Search timeout in seconds"),
        ).toHaveValue("17");
        await expect(
            dialog.getByRole("button", {
                name: "Include hidden files and directories",
            }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            dialog.getByRole("button", { name: "Respect .gitignore files" }),
        ).toHaveAttribute("aria-pressed", "false");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}?q=&timeout=9&hidden=false&gitignore=true`,
        );
        // Explicit URL state overrides preferences for shareable searches.
        await expect(
            dialog.getByLabel("Search timeout in seconds"),
        ).toHaveValue("9");
        await expect(
            dialog.getByRole("button", {
                name: "Include hidden files and directories",
            }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(
            dialog.getByRole("button", { name: "Respect .gitignore files" }),
        ).toHaveAttribute("aria-pressed", "true");
    });

    test("uses file-parent scope and URL-backed grep options", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "search-target.txt");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?q=hidden-search-value&hidden=false&gitignore=true`,
        );

        const dialog = page.getByRole("dialog", {
            name: "Search agent content",
        });
        // A directly loaded q opens search and a file route searches its parent.
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(`Searching in ${ctx.testDirPath}`);
        await expect(
            dialog.getByRole("button", { name: "Use regular expressions" }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(page).not.toHaveURL(/regex=/);
        await expect(dialog.getByText("0 results.")).toBeVisible();

        await dialog
            .getByRole("button", {
                name: "Include hidden files and directories",
            })
            .click();
        // Hidden and timeout state is URL authoritative and represented by replace navigation.
        await expect(page).toHaveURL(/hidden=true/);
        await expect(
            dialog.getByRole("button", {
                name: /Open .*\.hidden-search\/target\.txt at line 1/,
            }),
        ).toBeVisible();
        await dialog.getByLabel("Search timeout in seconds").fill("9");
        await expect(page).toHaveURL(/timeout=9/);

        await dialog.getByLabel("Search content").fill("unique.search.value");
        // Literal mode is the URL default, so regex punctuation does not match content.
        await expect(dialog.getByText("0 results.")).toBeVisible();
        await dialog
            .getByRole("button", { name: "Use regular expressions" })
            .click();
        await expect(
            dialog.getByRole("button", {
                name: /Open .*search-target\.txt at line 2/,
            }),
        ).toBeVisible();
        await expect(page).toHaveURL(/regex=true/);

        await dialog.getByLabel("Search content").fill("ignored-search-value");
        await expect(dialog.getByText("0 results.")).toBeVisible();
        await dialog
            .getByRole("button", { name: "Respect .gitignore files" })
            .click();
        // Disabling ignore handling makes the ignored fixture searchable.
        await expect(
            dialog.getByRole("button", {
                name: /Open .*ignored-search\.txt at line 1/,
            }),
        ).toBeVisible();
    });

    test("searches from the git root using already loaded worktree context", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(gitRootNestedPath)}?q=git-root-unique-value`,
        );
        const dialog = page.getByRole("dialog", {
            name: "Search agent content",
        });
        const gitRootCheckbox = dialog.getByRole("checkbox", {
            name: "Search from git root",
        });
        // Nested worktree views expose the git-root control from loader git context.
        await expect(gitRootCheckbox).toBeVisible();
        await expect(gitRootCheckbox).toHaveAttribute("aria-checked", "false");
        await expect(dialog).toContainText(`Searching in ${gitRootNestedPath}`);
        // Default scope stays on the browsed directory so sibling root files are excluded.
        await expect(dialog.getByText("0 results.")).toBeVisible();

        await gitRootCheckbox.click();
        await expect(page).toHaveURL(/gitroot=true/);
        await expect(dialog).toContainText(
            `Searching in ${gitRootRepositoryPath}`,
        );
        await expect(gitRootCheckbox).toHaveAttribute("aria-checked", "true");
        await expect(
            dialog.getByRole("button", {
                name: /Open .*root-only\.txt at line 1/,
            }),
        ).toBeVisible();

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(gitRootOutsidePath)}?q=`,
        );
        // Paths outside a worktree must not offer git-root search because no extra git lookup is allowed.
        await expect(
            dialog.getByRole("checkbox", { name: "Search from git root" }),
        ).toHaveCount(0);
        await expect(dialog).toContainText(
            `Searching in ${gitRootOutsidePath}`,
        );
    });
});

test.describe("Mobile agent content search", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("content-search-mobile");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("fills the viewport", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}?q=`);

        const dialog = page.getByRole("dialog", {
            name: "Search agent content",
        });
        const bounds = await dialog.boundingBox();
        // Mobile search consumes the complete viewport so controls and results have maximum room.
        expect(bounds?.width).toBe(390);
        expect(bounds?.height).toBe(844);
    });
});
