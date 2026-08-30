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

test.describe.serial("Agent search", () => {
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
        const nestedPathSearchDirectory = path.join(
            ctx.testDirPath,
            "nested-path-search",
        );
        await fs.mkdir(nestedPathSearchDirectory);
        await fs.writeFile(
            path.join(nestedPathSearchDirectory, "nested-path-target.txt"),
            "nested-path-target",
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

    test("searches paths by default and only requests the active mode", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}?timeout=9&hidden=true&gitignore=false`;
        const requests: URL[] = [];
        const requestBodies = new Map<URL, string | null>();
        page.on("request", (request) => {
            const url = new URL(request.url());
            if (
                url.pathname.includes("/api/v1/find") ||
                url.pathname.includes("/api/v1/grep")
            ) {
                requests.push(url);
                requestBodies.set(url, request.postData());
            }
        });
        await page.goto(directoryUrl);
        await page.getByRole("button", { name: "Search agent" }).click();

        const dialog = page.getByRole("dialog", { name: "Search agent" });
        const pathInput = dialog.getByRole("searchbox", {
            name: "Search file paths",
        });
        await pathInput.fill("nested-path-target");
        const nestedPath = path.join(
            ctx.testDirPath,
            "nested-path-search",
            "nested-path-target.txt",
        );
        const pathResult = dialog.getByRole("link", {
            name: `Open path ${nestedPath}`,
        });
        // Path mode recursively discovers files that are absent from the loaded directory listing.
        await expect(pathResult).toBeVisible();
        await expect(pathResult).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(nestedPath)}`,
        );
        const [pathResultBounds, pathTextBounds] = await Promise.all([
            pathResult.boundingBox(),
            pathResult.getByText(nestedPath, { exact: true }).boundingBox(),
        ]);
        // The path begins beside the leading icon instead of inheriting centered button content.
        expect(
            (pathTextBounds?.x ?? 0) - (pathResultBounds?.x ?? 0),
        ).toBeLessThan(60);
        const pathRequest = requests.find((request) =>
            request.pathname.includes("/api/v1/find"),
        );
        // The shared dialog forwards URL-owned traversal options in the path API JSON body.
        expect(pathRequest && requestBodies.get(pathRequest)).toBe(
            JSON.stringify({
                agent: ctx.agentId,
                path: ctx.testDirPath,
                query: "nested-path-target",
                timeout: 9,
                include_hidden: true,
                respect_gitignore: false,
                case_sensitivity: "smart",
            }),
        );
        // Default mode enables only the fuzzy path endpoint.
        expect(
            requests.some((request) =>
                request.pathname.includes("/api/v1/grep"),
            ),
        ).toBe(false);

        const smartCaseButton = dialog.getByRole("button", {
            name: "Case: smart",
        });
        // The shared default is exposed by an icon-only control with an accessible state label.
        await expect(smartCaseButton).toBeVisible();
        const smartCaseIcon = await smartCaseButton.innerHTML();
        await smartCaseButton.click();
        await expect(page).toHaveURL(/[?&]case=sensitive/);
        const sensitiveCaseButton = dialog.getByRole("button", {
            name: "Case: sensitive",
        });
        await expect(sensitiveCaseButton).toBeVisible();
        const sensitiveCaseIcon = await sensitiveCaseButton.innerHTML();
        // Each mode needs its own glyph so the current case rule is visible at a glance.
        expect(sensitiveCaseIcon).not.toBe(smartCaseIcon);
        await sensitiveCaseButton.click();
        await expect(page).toHaveURL(/[?&]case=insensitive/);
        const insensitiveCaseButton = dialog.getByRole("button", {
            name: "Case: insensitive",
        });
        const insensitiveCaseIcon = await insensitiveCaseButton.innerHTML();
        expect(insensitiveCaseIcon).not.toBe(sensitiveCaseIcon);
        expect(insensitiveCaseIcon).not.toBe(smartCaseIcon);
        await insensitiveCaseButton.click();
        await expect(page).toHaveURL(/[?&]case=smart/);

        await dialog
            .getByRole("button", { name: "Search file contents" })
            .click();
        const contentResult = dialog.getByRole("link", {
            name: `Open ${nestedPath} at line 1`,
        });
        await expect(contentResult).toBeVisible();
        // A real destination href preserves native middle-click and context-menu navigation.
        await expect(contentResult).toHaveAttribute(
            "href",
            `/agents/${ctx.agentId}/browser/${encodeFilesystemPath(nestedPath)}?line=1`,
        );
        const searchRequestCount = requests.filter((request) =>
            request.pathname.includes("/api/v1/find"),
        ).length;
        const grepRequestCount = requests.filter((request) =>
            request.pathname.includes("/api/v1/grep"),
        ).length;

        await dialog
            .getByRole("searchbox", { name: "Search file contents" })
            .fill("unique-search-value");
        await expect(
            dialog.getByRole("link", {
                name: /Open .*search-target\.txt at line 2/,
            }),
        ).toBeVisible();
        const contextInput = dialog.getByLabel("Context lines above and below");
        // Content search requests and displays the same default context on both sides.
        await expect(contextInput).toHaveValue("4");
        const searchTargetResult = dialog.getByRole("link", {
            name: /Open .*search-target\.txt at line 2/,
        });
        await expect(searchTargetResult.getByText("first line")).toBeVisible();
        await expect(searchTargetResult.getByText("last line")).toBeVisible();
        const contentRequest = requests.find((request) =>
            requestBodies
                .get(request)
                ?.includes('"query":"unique-search-value"'),
        );
        // One context control maps to both grep context directions.
        expect(contentRequest && requestBodies.get(contentRequest)).toContain(
            '"before_context":4,"after_context":4',
        );
        await contextInput.fill("1");
        await expect(page).toHaveURL(/[?&]context=1/);
        await expect
            .poll(() =>
                [...requestBodies.values()].some((body) =>
                    body?.includes(
                        '"query":"unique-search-value","timeout":9,"include_hidden":true,"respect_gitignore":false,"fixed_string":true,"case_sensitivity":"smart","before_context":1,"after_context":1',
                    ),
                ),
            )
            .toBe(true);
        // Content mode starts only grep requests while the path query remains disabled.
        expect(
            requests.filter((request) =>
                request.pathname.includes("/api/v1/find"),
            ),
        ).toHaveLength(searchRequestCount);
        expect(
            requests.filter((request) =>
                request.pathname.includes("/api/v1/grep"),
            ).length,
        ).toBeGreaterThan(grepRequestCount);

        await dialog.getByRole("button", { name: "Search file paths" }).click();
        const grepRequestsAfterSwitch = requests.filter((request) =>
            request.pathname.includes("/api/v1/grep"),
        ).length;
        await pathInput.fill("nested-path-target");
        await expect(pathResult).toBeVisible();
        // Returning to path mode does not leak another request to the inactive grep endpoint.
        expect(
            requests.filter((request) =>
                request.pathname.includes("/api/v1/grep"),
            ),
        ).toHaveLength(grepRequestsAfterSwitch);
        await pathResult.click();
        await expect(page).toHaveURL(/nested-path-target\.txt$/);
    });

    test("opens from shared entry points and restores results after navigation", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const launcher = page.getByRole("button", {
            name: "Search agent",
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
                name: "Search agent (s, Cmd/Ctrl+K)",
            }),
        ).toBeVisible();
        await launcher.click();

        const dialog = page.getByRole("dialog", {
            name: "Search agent",
        });
        // Directory metadata must scope grep to the directory currently being browsed.
        await expect(dialog).toContainText(
            `Current folder: ${ctx.testDirPath}`,
        );
        const desktopBounds = await dialog.boundingBox();
        const desktopViewport = page.viewportSize();
        // Desktop search remains modal while using most of the available workspace.
        expect(desktopBounds?.width ?? 0).toBeGreaterThan(
            desktopViewport ? desktopViewport.width * 0.7 : 0,
        );
        expect(desktopBounds?.height ?? 0).toBeGreaterThan(
            desktopViewport ? desktopViewport.height * 0.7 : 0,
        );
        const pathInput = dialog.getByRole("searchbox", {
            name: "Search file paths",
        });
        // Agent search starts in path mode rather than unexpectedly grepping file contents.
        await expect(pathInput).toBeFocused();
        await dialog
            .getByRole("button", { name: "Search file contents" })
            .click();
        const searchInput = dialog.getByRole("searchbox", {
            name: "Search file contents",
        });
        await expect(searchInput).toBeFocused();
        await expect(page).toHaveURL(/[?&]mode=content/);
        await page.goBack();
        // Mode is URL-owned so Back restores the default path workflow without closing search.
        await expect(pathInput).toBeVisible();
        await page.goForward();
        await expect(searchInput).toBeVisible();
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
            if (!request.url().includes("/api/v1/grep")) return;
            activeRequests += 1;
            maximumActiveRequests = Math.max(
                maximumActiveRequests,
                activeRequests,
            );
        });
        page.on("requestfinished", (request) => {
            if (request.url().includes("/api/v1/grep")) activeRequests -= 1;
        });
        page.on("requestfailed", (request) => {
            if (!request.url().includes("/api/v1/grep")) return;
            activeRequests -= 1;
            if (request.postData()?.includes('"query":"content1"') === true) {
                firstRequestFailed = true;
            }
        });
        await page.route("**/api/v1/grep", async (route) => {
            if (
                route.request().postData()?.includes('"query":"content1"') !==
                true
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

        const result = dialog.getByRole("link", {
            name: /Open .*search-target\.txt at line 2/,
        });
        // Grep results expose their one-based line destination.
        await expect(result).toBeVisible();
        // Superseding an in-flight query must not leave stale matches in the result set.
        await expect(
            dialog.getByRole("link", { name: /Open .*file1\.txt/ }),
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

        await dialog.getByRole("button", { name: "Close search" }).click();
        await expect(dialog).toBeHidden();
        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/logs`);
        await expect(
            page.getByRole("button", { name: "Search agent" }),
        ).toBeVisible();
        await page.keyboard.press("ControlOrMeta+k");
        // The route-level shortcut also works outside the browser and falls back to agent home.
        await expect(dialog).toBeVisible();
        await expect(
            dialog.getByRole("searchbox", { name: "Search file paths" }),
        ).toBeFocused();
        await expect(dialog).toContainText(`Current folder: ${ctx.agentHome}`);
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
            name: "Search agent",
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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?q=hidden-search-value&mode=content&hidden=false&gitignore=true`,
        );

        const dialog = page.getByRole("dialog", {
            name: "Search agent",
        });
        // A directly loaded q opens search and a file route searches its parent.
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(
            `Current folder: ${ctx.testDirPath}`,
        );
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
            dialog.getByRole("link", {
                name: /Open .*\.hidden-search\/target\.txt at line 1/,
            }),
        ).toBeVisible();
        await dialog.getByLabel("Search timeout in seconds").fill("9");
        await expect(page).toHaveURL(/timeout=9/);

        await dialog
            .getByRole("searchbox", { name: "Search file contents" })
            .fill("unique.search.value");
        // Literal mode is the URL default, so regex punctuation does not match content.
        await expect(dialog.getByText("0 results.")).toBeVisible();
        await dialog
            .getByRole("button", { name: "Use regular expressions" })
            .click();
        await expect(
            dialog.getByRole("link", {
                name: /Open .*search-target\.txt at line 2/,
            }),
        ).toBeVisible();
        await expect(page).toHaveURL(/regex=true/);

        await dialog
            .getByRole("searchbox", { name: "Search file contents" })
            .fill("ignored-search-value");
        await expect(dialog.getByText("0 results.")).toBeVisible();
        await dialog
            .getByRole("button", { name: "Respect .gitignore files" })
            .click();
        // Disabling ignore handling makes the ignored fixture searchable.
        await expect(
            dialog.getByRole("link", {
                name: /Open .*ignored-search\.txt at line 1/,
            }),
        ).toBeVisible();
    });

    test("searches from the git root using already loaded worktree context", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(gitRootNestedPath)}?q=git-root-unique-value&mode=content`,
        );
        const dialog = page.getByRole("dialog", {
            name: "Search agent",
        });
        const gitRootButton = dialog.getByRole("button", {
            name: "Search from git root",
        });
        // Nested worktree views expose the git-root control from loader git context.
        await expect(gitRootButton).toBeVisible();
        await expect(gitRootButton).toHaveAttribute("aria-pressed", "false");
        await expect(dialog).toContainText(
            `Current folder: ${gitRootNestedPath}`,
        );
        // Default scope stays on the browsed directory so sibling root files are excluded.
        await expect(dialog.getByText("0 results.")).toBeVisible();

        await gitRootButton.click();
        await expect(page).toHaveURL(/gitroot=true/);
        await expect(dialog).toContainText(
            `Current folder: ${gitRootRepositoryPath}`,
        );
        await expect(gitRootButton).toHaveAttribute("aria-pressed", "true");
        await expect(
            dialog.getByRole("link", {
                name: /Open .*root-only\.txt at line 1/,
            }),
        ).toBeVisible();

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(gitRootOutsidePath)}?q=&mode=content`,
        );
        // Paths outside a worktree must not offer git-root search because no extra git lookup is allowed.
        await expect(
            dialog.getByRole("button", { name: "Search from git root" }),
        ).toHaveCount(0);
        await expect(dialog).toContainText(
            `Current folder: ${gitRootOutsidePath}`,
        );
    });
});

test.describe("Mobile agent search", () => {
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
            name: "Search agent",
        });
        const bounds = await dialog.boundingBox();
        // Mobile search consumes the complete viewport so controls and results have maximum room.
        expect(bounds?.width).toBe(390);
        expect(bounds?.height).toBe(844);
    });
});
