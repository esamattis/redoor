import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import { z } from "zod";
import {
    encodeFilesystemPath,
    ignoreServerEvents,
    setupTestDir,
    simulateTabRefocus,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

/** The part of a diff request the tests inspect: which files it asked for. */
const gitDiffRequestSchema = z.object({ files: z.array(z.string()) });

test.describe.serial("Git browser", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let trackedPath: string;
    let untrackedPath: string;
    let ignoredPath: string;
    let binaryPath: string;
    let largePath: string;
    let deletedPath: string;
    let outsidePath: string;
    let manyChangesRepositoryPath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-browser");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        trackedPath = path.join(repositoryPath, "tracked.ts");
        untrackedPath = path.join(repositoryPath, "untracked.txt");
        ignoredPath = path.join(repositoryPath, "ignored.txt");
        binaryPath = path.join(repositoryPath, "binary.dat");
        largePath = path.join(repositoryPath, "large.txt");
        deletedPath = path.join(repositoryPath, "deleted.txt");
        outsidePath = path.join(
            os.tmpdir(),
            `redoor-git-browser-outside-${process.pid}`,
        );
        manyChangesRepositoryPath = path.join(
            ctx.testDirPath,
            "many-changes-repository",
        );

        await fs.mkdir(path.join(repositoryPath, "clean"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, ".gitignore"),
            "ignored.txt\n",
        );
        await fs.writeFile(
            trackedPath,
            'const version = "committed version";\n',
        );
        await fs.writeFile(binaryPath, "plain baseline\n");
        await fs.writeFile(largePath, "small baseline\n");
        await fs.writeFile(deletedPath, "deleted baseline\n");
        await fs.writeFile(
            path.join(repositoryPath, "clean", "stable.txt"),
            "stable\n",
        );
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        await fs.writeFile(trackedPath, 'const version = "staged version";\n');
        await $`git -C ${repositoryPath} add tracked.ts`;
        await fs.writeFile(
            trackedPath,
            'const version = "worktree version";\n',
        );
        await fs.writeFile(untrackedPath, "untracked content\n");
        await fs.writeFile(ignoredPath, "ignored content\n");
        await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
        await fs.writeFile(largePath, "L".repeat(2 * 1024 * 1024 + 1));
        await fs.rm(deletedPath);
        await fs.mkdir(manyChangesRepositoryPath, { recursive: true });

        // One more file than a single diff request may name, so the view must batch.
        for (let index = 0; index < 129; index += 1) {
            await fs.writeFile(
                path.join(manyChangesRepositoryPath, `changed-${index}.txt`),
                `baseline
`,
            );
        }

        await $`git -C ${manyChangesRepositoryPath} init`;
        await $`git -C ${manyChangesRepositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${manyChangesRepositoryPath} config user.name Playwright`;
        await $`git -C ${manyChangesRepositoryPath} add .`;
        await $`git -C ${manyChangesRepositoryPath} commit -m baseline`;

        for (let index = 0; index < 129; index += 1) {
            await fs.writeFile(
                path.join(manyChangesRepositoryPath, `changed-${index}.txt`),
                `changed
`,
            );
        }

        // A patch much taller than the viewport, to scroll past its header.
        await fs.writeFile(
            path.join(manyChangesRepositoryPath, "changed-0.txt"),
            Array.from({ length: 200 }, (_, line) => `long line ${line}`).join(`
`),
        );

        await fs.mkdir(outsidePath, { recursive: true });
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(outsidePath, { force: true, recursive: true });
    });

    test("loads diffs on expansion with sticky, collapsible file headers", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 360, height: 600 });
        // The request counts below must only see fetches this page's own clicks caused.
        await ignoreServerEvents(page);
        const diffRequests: string[][] = [];
        page.on("request", (request) => {
            if (
                request.method() === "POST" &&
                new URL(request.url()).pathname.endsWith("/git/diff")
            ) {
                const body = gitDiffRequestSchema.parse(request.postDataJSON());

                diffRequests.push(body.files);
            }
        });
        const repositoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(manyChangesRepositoryPath)}?view=git`;
        await page.goto(repositoryUrl);

        const diffRegions = page.getByRole("region", { name: /Git diff for/ });

        // Every changed file is listed by its header.
        await expect(diffRegions).toHaveCount(129);
        // The page opens collapsed, so every file offers to expand.
        await expect(
            page.getByRole("button", { name: /^Expand diff for/ }),
        ).toHaveCount(129);
        // Collapsed files fetch nothing, so opening a large change set costs no diffs.
        expect(diffRequests).toEqual([]);
        // The diffs replace the separate file list, so no status group headings remain.
        await expect(
            page.getByRole("heading", { name: /Unstaged changes/ }),
        ).toHaveCount(0);

        const longDiffPath = path.join(
            manyChangesRepositoryPath,
            "changed-0.txt",
        );

        const longDiff = page.getByRole("region", {
            name: `Git diff for ${longDiffPath}`,
        });

        const longDiffName = longDiff.getByRole("link", {
            name: "changed-0.txt",
            exact: true,
        });

        await longDiff
            .getByRole("button", { name: "Expand diff for changed-0.txt" })
            .click();
        // Expanding one file loads its patch.
        await expect(longDiff).toContainText("long line 150");
        // Only the expanded file was requested.
        expect(diffRequests).toEqual([[longDiffPath]]);

        await longDiff.getByText("long line 150").scrollIntoViewIfNeeded();
        // The header sticks while its patch scrolls, so the file being read stays named.
        await expect(longDiffName).toBeInViewport();

        // The scroll area's top padding is the overlay top bar's height, where content starts.
        const contentTop = await page
            .getByRole("main")
            .evaluate(
                (main) =>
                    main.getBoundingClientRect().top +
                    Number.parseFloat(getComputedStyle(main).paddingTop),
            );

        const stuckNameBox = await longDiffName.boundingBox();

        // The header sticks flush below the top bar, without a gap that shows patch lines above it.
        expect(stuckNameBox?.y).toBeGreaterThanOrEqual(contentTop);
        expect(stuckNameBox?.y).toBeLessThan(contentTop + 24);

        await page.getByRole("button", { name: "Expand all" }).click();
        // Expand all opens every file.
        await expect(
            page.getByRole("button", { name: /^Collapse diff for/ }),
        ).toHaveCount(129);
        // The last file's patch proves the remaining diffs loaded.
        await expect(diffRegions.last()).toContainText("baseline");
        // The 128 missing diffs came in one request that skipped the cached file.
        expect(diffRequests).toHaveLength(2);
        expect(diffRequests[1]).toHaveLength(128);
        expect(diffRequests[1]).not.toContain(longDiffPath);

        await page.getByRole("button", { name: "Collapse all" }).click();
        // Collapse all folds every file down to its header.
        await expect(
            page.getByRole("button", { name: /^Expand diff for/ }),
        ).toHaveCount(129);
        await expect(longDiff).not.toContainText("long line 150");

        await longDiff
            .getByRole("button", { name: "Expand diff for changed-0.txt" })
            .click();
        // Expanding again shows the cached patch.
        await expect(longDiff).toContainText("long line 150");
        await expect(
            longDiff.getByRole("button", {
                name: "Collapse diff for changed-0.txt",
            }),
        ).toHaveAttribute("aria-expanded", "true");
        // Diffs already loaded are not requested again.
        expect(diffRequests).toHaveLength(2);

        await longDiffName.click();
        // The header names the file itself, so it opens the file rather than its diff.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(longDiffPath)}`,
        );
    });

    test("browses status, file comparisons, refreshes, and explicit diff states", async ({
        page,
    }) => {
        const repositoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(repositoryPath)}`;
        await page.setViewportSize({ width: 360, height: 844 });
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto(`${repositoryUrl}?view=git`);

        const directoryView = page.getByLabel("Directory view");
        await expect(
            directoryView.getByRole("link", { name: "Git", exact: true }),
        ).toBeVisible();

        const directoryTabs = await directoryView
            .getByRole("link")
            .allTextContents();

        // Git must follow Sync while remaining reachable in the phone-width tab strip.
        expect(directoryTabs.slice(-2)).toEqual(["Sync", "Git"]);
        await expect(
            directoryView.getByRole("link", { name: "Git", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        const repositoryHeader = page.getByRole("region", {
            name: "Git repository",
        });

        // At the root the repository path names only the repository, as the current page.
        await expect(
            repositoryHeader
                .getByRole("navigation", { name: "Repository path" })
                .getByText(path.basename(repositoryPath), { exact: true }),
        ).toHaveAttribute("aria-current", "page");
        // The header always shows where the repository lives.
        await expect(repositoryHeader).toContainText(repositoryPath);
        // The summary counts each status group the diffs below come from.
        await expect(page.getByText("1 staged")).toBeVisible();
        await expect(page.getByText("4 unstaged")).toBeVisible();
        await expect(page.getByText("1 untracked")).toBeVisible();
        // Ignored paths stay out of directory status even though direct browsing supports them.
        await expect(
            page.getByRole("link", { name: "ignored.txt", exact: true }),
        ).toHaveCount(0);

        const directoryUrl = page.url();

        const directoryDiffs = page.getByRole("region", {
            name: /Git diff for/,
        });

        await expect(directoryDiffs).toHaveCount(5);
        // Diffs load in place without adding route search state.
        await expect(page).toHaveURL(directoryUrl);
        // Each patch is named by one header, not again by the generated diff chrome.
        await expect(
            page
                .getByRole("region", { name: `Git diff for ${trackedPath}` })
                .getByRole("heading"),
        ).toHaveCount(1);
        await expect(
            page
                .getByRole("region", { name: `Git diff for ${trackedPath}` })
                .getByRole("link", { name: "tracked.ts", exact: true }),
        ).toHaveAttribute(
            "href",
            `/agents/${ctx.agentName}/browser/${encodeFilesystemPath(trackedPath)}`,
        );
        // Patches follow the status groups, with a file in several groups shown once.
        expect(
            await directoryDiffs.evaluateAll((regions) =>
                regions.map((region) => region.getAttribute("aria-label")),
            ),
        ).toEqual([
            `Git diff for ${trackedPath}`,
            `Git diff for ${binaryPath}`,
            `Git diff for ${deletedPath}`,
            `Git diff for ${largePath}`,
            `Git diff for ${untrackedPath}`,
        ]);

        const untrackedSection = page.getByRole("region", {
            name: `Git diff for ${untrackedPath}`,
        });

        await untrackedSection
            .getByRole("button", { name: "Expand diff for untracked.txt" })
            .click();
        // Untracked content is a real empty-to-worktree patch and uses the shared diff table.
        await expect(untrackedSection).toContainText("untracked content");
        // A file deleted from the worktree opens as it is at HEAD, where it still exists.
        await expect(
            page
                .getByRole("region", { name: `Git diff for ${deletedPath}` })
                .getByRole("link", { name: "deleted.txt", exact: true }),
        ).toHaveAttribute("href", /\?rev=HEAD$/);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(trackedPath)}?view=git`,
        );
        const fullDiff = page.getByRole("region", { name: "Full Git diff" });
        // The default comparison must show current worktree content.
        await expect(fullDiff).toContainText("worktree version");
        // Source diffs use the same filename-based language support as the editor.
        await expect(
            fullDiff.locator('[data-token="keyword"]').first(),
        ).toHaveText("const");

        const modifiedRow = fullDiff.locator('tr[data-line-kind="modified"]');

        // A similar edited line shows as one row, so the change reads within the line.
        await expect(modifiedRow).toHaveCount(1);
        // Only the changed word is marked, as removed old text and inserted new text.
        await expect(modifiedRow.getByRole("deletion")).toHaveText("committed");
        await expect(modifiedRow.getByRole("insertion")).toHaveText("worktree");
        // The modified row exists in the current file, so hovering it offers the editor.
        await modifiedRow.hover();
        await expect(
            fullDiff.getByRole("link", { name: "Open line 1 in editor" }),
        ).toBeVisible();
        // Diff colours must follow the resolved app theme rather than a fixed dark palette.
        await expect(modifiedRow.getByRole("insertion")).toHaveCSS(
            "background-color",
            "rgb(171, 242, 188)",
        );
        await page.emulateMedia({ colorScheme: "dark" });
        // An already rendered diff recolours when system mode resolves to a new theme.
        await expect(modifiedRow.getByRole("insertion")).toHaveCSS(
            "background-color",
            "rgb(29, 76, 43)",
        );
        const fullDiffBox = await fullDiff.boundingBox();
        // The diff should use nearly all phone width instead of retaining desktop card padding.
        expect(fullDiffBox?.width).toBeGreaterThan(330);
        // File comparisons keep the repository root one click away in the repository path.
        await expect(
            page
                .getByRole("navigation", { name: "Repository path" })
                .getByRole("link", {
                    name: path.basename(repositoryPath),
                    exact: true,
                }),
        ).toBeVisible();
        const fileView = page.getByLabel("File view");
        const fileTabs = await fileView.getByRole("link").allTextContents();
        // File Git uses the same stable post-Sync tab position as directory Git.
        expect(fileTabs.slice(-2)).toEqual(["Sync", "Git"]);

        const stagedOnly = page.getByRole("button", {
            name: "Staged only",
            exact: true,
        });

        // The staged comparison is a visible switch that starts off.
        await expect(stagedOnly).toHaveAttribute("aria-pressed", "false");
        await stagedOnly.click();
        await expect(stagedOnly).toHaveAttribute("aria-pressed", "true");

        const stagedDiff = page.getByRole("region", {
            name: "Staged Git diff",
        });

        // Staged mode must switch query identity and display index content only.
        await expect(stagedDiff).toContainText("staged version");
        await expect(stagedDiff).not.toContainText("worktree version");

        await page
            .getByRole("button", { name: "All changes", exact: true })
            .click();
        await expect(stagedOnly).toHaveAttribute("aria-pressed", "false");
        await fs.writeFile(
            trackedPath,
            'const version = "refreshed worktree version";\n',
        );
        await simulateTabRefocus(page);
        // Focus refresh must invalidate the Git cache independently of the unchanged listing.
        await expect(
            page.getByRole("region", { name: "Full Git diff" }),
        ).toContainText("refreshed worktree version");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(untrackedPath)}?view=git`,
        );
        // Direct untracked files use the same pure-addition rendering as directory batches.
        await expect(
            page.getByRole("region", { name: "Full Git diff" }),
        ).toContainText("untracked content");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(ignoredPath)}?view=git`,
        );
        // Ignored files retain a Git tab and expose their classification directly.
        await expect(
            page.getByText(/This file is ignored by Git/),
        ).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(binaryPath)}?view=git`,
        );
        // Binary outcomes must not be mistaken for clean text files.
        await expect(page.getByText(/This is a binary file/)).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(largePath)}?view=git`,
        );
        // Bounded API outcomes receive a useful size-specific message.
        await expect(
            page.getByText(/too large to display safely/),
        ).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(deletedPath)}?view=git`,
        );
        // A deleted filesystem path must bypass creation UI and retain its HEAD deletion diff.
        await expect(
            page.getByRole("region", { name: "Full Git diff" }),
        ).toContainText("deleted baseline");
        await expect(
            page.getByRole("heading", { name: "Create missing path" }),
        ).toHaveCount(0);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(repositoryPath, "clean"))}?view=git`,
        );
        // Prefix-filtered clean directories report clean even when siblings are modified.
        await expect(page.getByText(/Working tree is clean/)).toBeVisible();

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(outsidePath)}?view=git`,
        );
        // Direct Git URLs outside a worktree return to the ordinary Files representation.
        await expect(page).not.toHaveURL(/\?view=git$/);
        await expect(
            page
                .getByLabel("Directory view")
                .getByRole("link", { name: "Git", exact: true }),
        ).toHaveCount(0);
    });
});
