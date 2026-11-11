import { expect, test } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe("Diff copy reference", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("diff-copy-reference");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
    });

    test("copies the selected diff lines as absolute and repository references", async ({
        page,
    }) => {
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const filePath = path.join(repositoryPath, "src", "changed.txt");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
            filePath,
            `one
two
three
`,
        );
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        await fs.writeFile(
            filePath,
            `one
two changed
three
four
`,
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );

        const diff = page.getByRole("region", { name: "Full Git diff" });
        await expect(diff).toContainText("four");

        // Selects from the start of line 2 to the end of line 4 of the current version, across
        // the changed, unchanged and added rows.
        const selectLines = () =>
            diff.evaluate((element) => {
                const start = element.querySelector(
                    'tr[data-line-new="2"] td:last-child',
                );

                const end = element.querySelector(
                    'tr[data-line-new="4"] td:last-child',
                );

                const selection = document.getSelection();

                if (start === null || end === null || selection === null) {
                    throw new Error("The diff rows to select are missing");
                }

                const range = document.createRange();
                range.setStart(start, 0);
                range.setEnd(end, end.childNodes.length);
                selection.removeAllRanges();
                selection.addRange(range);
            });

        await selectLines();

        const copyReference = page.getByRole("button", {
            name: "Copy reference",
            exact: true,
        });

        await expect(copyReference).toBeVisible();
        // Content search matches single lines, so a multi-line selection offers no search.
        await expect(
            page.getByRole("button", { name: "Search selected text" }),
        ).toHaveCount(0);

        await copyReference.click();

        // The lines are quoted as the file has them now, without the removed text, and named
        // by the file's absolute path and the first selected line.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L2
two changed
three
four
\`\`\``);
        // Non-modal feedback confirms the asynchronous clipboard write completed.
        await expect(page.getByRole("status")).toHaveText("Copied reference");
        // Copying clears the selection, so the toolbar gets out of the way of the diff.
        await expect(copyReference).toHaveCount(0);

        await selectLines();
        await page
            .getByRole("button", { name: "Copy repo reference", exact: true })
            .click();

        // The repository form names the file relative to the repository root.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`src/changed.txt#L2
two changed
three
four
\`\`\``);
        // The toast names the repository form so the user knows which one was copied.
        await expect(page.getByRole("status")).toHaveText(
            "Copied repo reference",
        );
    });

    test("keeps a blank line the selection runs through at its start", async ({
        page,
    }) => {
        const repositoryPath = path.join(ctx.testDirPath, "blank-line");
        const filePath = path.join(repositoryPath, "blank.txt");
        await fs.mkdir(repositoryPath, { recursive: true });
        await fs.writeFile(
            filePath,
            `one
removed

three
`,
        );
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        await fs.writeFile(
            filePath,
            `one

three
`,
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );

        const diff = page.getByRole("region", { name: "Full Git diff" });
        await expect(diff).toContainText("removed");

        // Selects from the removed line to the end of line 3, so the blank line 2 is the first
        // current-version row and the selection runs through all of it.
        await diff.evaluate((element) => {
            const start = element.querySelector(
                'tr[data-line-old="2"] td:last-child',
            );

            const end = element.querySelector(
                'tr[data-line-new="3"] td:last-child',
            );

            const selection = document.getSelection();

            if (start === null || end === null || selection === null) {
                throw new Error("The diff rows to select are missing");
            }

            const range = document.createRange();
            range.setStart(start, 0);
            range.setEnd(end, end.childNodes.length);
            selection.removeAllRanges();
            selection.addRange(range);
        });

        await page
            .getByRole("button", { name: "Copy reference", exact: true })
            .click();

        // The blank line has no text to select, but it lies inside the selection, so the
        // reference starts at it instead of skipping to the next line.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L2

three
\`\`\``);
    });
});
