import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

/**
 * 60 numbered lines with line 30 edited and `needle` written on one unchanged line, so the
 * needle sits in a fold the patch carries but the page does not show.
 */
function fileWithNeedle(needleLine: number, edited: boolean) {
    return Array.from({ length: 60 }, (_, index) => {
        const number = index + 1;

        if (number === needleLine) {
            return `needle ${String(number)}\n`;
        }

        return edited && number === 30
            ? `edited ${String(number)}\n`
            : `line ${String(number)}\n`;
    }).join("");
}

/** How many ranges a named CSS highlight holds, or null when it is not registered. */
async function highlightSize(page: Page, name: string) {
    return page.evaluate(
        (highlight) => CSS.highlights.get(highlight)?.size ?? null,
        name,
    );
}

test.describe("Diff search", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        await teardownTestDir(testDirPath);
    });

    test("finds text in folds of collapsed files and steps between them", async ({
        page,
    }) => {
        const ctx = await setupTestDir("diff-search");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        await fs.mkdir(repositoryPath);

        // The needle is above the edit in one file and below it in the other, so both
        // directions of revealing a fold are used.
        const needles = { "alpha.txt": 10, "beta.txt": 50 };

        for (const [name, line] of Object.entries(needles)) {
            await fs.writeFile(
                path.join(repositoryPath, name),
                fileWithNeedle(line, false),
            );
        }

        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        for (const [name, line] of Object.entries(needles)) {
            await fs.writeFile(
                path.join(repositoryPath, name),
                fileWithNeedle(line, true),
            );
        }

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        const region = (name: string) =>
            page.getByRole("region", {
                name: `Git diff for ${path.join(repositoryPath, name)}`,
            });

        // The worktree list starts collapsed, so no patch is on the page to find in.
        await expect(
            page.getByRole("button", { name: "Expand diff for alpha.txt" }),
        ).toBeVisible();
        await expect(page.locator("tr[data-line-new]")).toHaveCount(0);

        await page.keyboard.press("Control+f");

        const input = page.getByRole("searchbox", { name: "Search in diffs" });
        const status = page.getByRole("status", { name: "Diff search status" });

        // Ctrl+F opens the diff search instead of the browser's find in page.
        await expect(input).toBeFocused();

        await input.fill("needle");

        // Both collapsed files were loaded and searched, and the first match became current.
        await expect(status).toHaveText("1 of 2");

        // Stepping to the match expands its file and reveals the folded line it is on.
        await expect(
            region("alpha.txt").locator('tr[data-line-new="10"]'),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Collapse diff for alpha.txt" }),
        ).toBeVisible();

        // Only the current match's file expands; the other one only says it has a match.
        await expect(
            page.getByRole("button", { name: "Expand diff for beta.txt" }),
        ).toBeVisible();
        await expect(region("beta.txt")).toContainText("1 match");

        // The match is marked on the page as the current one.
        await expect
            .poll(() => highlightSize(page, "diff-search-current"))
            .toBe(1);

        await input.press("Enter");

        // Enter steps to the next file's match, opening the fold below its edit.
        await expect(status).toHaveText("2 of 2");
        await expect(
            region("beta.txt").locator('tr[data-line-new="50"]'),
        ).toBeVisible();

        // Both matches are rendered now, so both are marked.
        await expect.poll(() => highlightSize(page, "diff-search")).toBe(2);

        await input.press("Escape");

        // Closing removes the marks, so no stale highlight outlives the search.
        await expect(input).toHaveCount(0);
        await expect.poll(() => highlightSize(page, "diff-search")).toBeNull();

        await page.getByRole("button", { name: "Search in diffs" }).click();

        // The floating button reopens the search with the query kept, for phones without
        // a keyboard shortcut.
        await expect(input).toHaveValue("needle");
        await expect(status).toHaveText("2 matches");
    });
});
