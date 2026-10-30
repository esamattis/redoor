import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe("Editor Git gutter", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let outsidePath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-gutter");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        // The test directory may itself sit inside a checkout, so the plain file lives in the
        // system temp directory instead.
        outsidePath = path.join(
            os.tmpdir(),
            `redoor-git-gutter-outside-${process.pid}`,
        );
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(path.join(outsidePath, "plain.txt"), "plain\n");

        await fs.mkdir(repositoryPath, { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "one\ntwo\nthree\n",
        );
        await $`git -C ${repositoryPath} init --initial-branch=main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        // The last line's change is staged, the first line's is not.
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "one\ntwo\nTHREE\n",
        );
        await $`git -C ${repositoryPath} add notes.txt`;
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "ONE\ntwo\nTHREE\n",
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(outsidePath, { force: true, recursive: true });
    });

    test("marks staged and unstaged lines and follows typing", async ({
        page,
    }) => {
        await page.goto(
            deviceBrowserUrl(
                ctx.agentName,
                path.join(repositoryPath, "notes.txt"),
            ),
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toContainText("ONE");

        // The gutter is hidden from assistive technology like the line numbers, so its
        // marks are found by the change they carry.
        const unstagedModified = page.locator(
            '[data-git-line-change="modified"][data-git-line-staged="false"]',
        );

        const stagedModified = page.locator(
            '[data-git-line-change="modified"][data-git-line-staged="true"]',
        );

        const unstagedAdded = page.locator(
            '[data-git-line-change="added"][data-git-line-staged="false"]',
        );

        // The edited first line differs from the index, so it is an unstaged change.
        await expect(unstagedModified).toHaveCount(1);
        // The staged last line differs from HEAD only, and is marked as staged.
        await expect(stagedModified).toHaveCount(1);
        await expect(unstagedAdded).toHaveCount(0);

        await editor.click();
        await page.keyboard.press("Control+End");
        // Ending with a newline inserts a line instead of filling the empty last one.
        await page.keyboard.type("four");
        await page.keyboard.press("Enter");

        // A line typed into the buffer is marked as added without saving the file.
        await expect(unstagedAdded).toHaveCount(1);
        // The earlier marks stay where they were.
        await expect(unstagedModified).toHaveCount(1);
        await expect(stagedModified).toHaveCount(1);
    });

    test("shows no marks for a file outside a repository", async ({ page }) => {
        await page.goto(
            deviceBrowserUrl(
                ctx.agentName,
                path.join(outsidePath, "plain.txt"),
            ),
        );

        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toContainText("plain");

        // Outside a repository there is nothing to compare with, so no line is marked new.
        await expect(page.locator("[data-git-line-change]")).toHaveCount(0);
    });
});
