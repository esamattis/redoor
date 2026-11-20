import { expect, test } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

/** More files than a commit diff lists by default (128), so the diff starts out truncated. */
const FILE_COUNT = 130;

test.describe("Show all files of a truncated diff", () => {
    let ctx: TestContext;
    let repositoryPath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-show-all-files");
        repositoryPath = path.join(ctx.testDirPath, "many-files");
        await fs.mkdir(path.join(repositoryPath, "files"), { recursive: true });
        await Promise.all(
            Array.from({ length: FILE_COUNT }, (_, index) =>
                fs.writeFile(
                    path.join(
                        repositoryPath,
                        "files",
                        `${String(index).padStart(3, "0")}.txt`,
                    ),
                    `${index}\n`,
                ),
            ),
        );
        await $`git -C ${repositoryPath} init -b main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m ${"Many files"}`;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("opts into every file of a commit with more than the default limit", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&rev=HEAD`,
        );

        const notice = page.getByRole("status").filter({
            hasText: "changed more files than are shown by default",
        });

        // The default limit cuts the diff short and says so instead of silently dropping files.
        await expect(notice).toBeVisible();
        // The first files the traversal met are listed, so the first one is there.
        await expect(
            page.getByRole("region", { name: "Commit diff for files/000.txt" }),
        ).toBeVisible();
        // The last file is past the default limit and not listed yet.
        await expect(
            page.getByRole("region", { name: "Commit diff for files/129.txt" }),
        ).toHaveCount(0);

        await notice.getByRole("link", { name: "Show all" }).click();

        // The opt-in lives in the URL, so it survives a reload and Back.
        await expect(page).toHaveURL(/allFiles=true/);
        // The file past the default limit is now listed too.
        await expect(
            page.getByRole("region", { name: "Commit diff for files/129.txt" }),
        ).toBeVisible();
        // Nothing is cut off any more, so the warning is gone.
        await expect(notice).toHaveCount(0);

        await page.getByRole("link", { name: "Working tree" }).click();

        // Leaving the revision opens another diff, which waits for the history view to go first.
        await expect(page).not.toHaveURL(/rev=/);
        // The opt-in belonged to the diff that was left, so the new one starts at the default.
        await expect(page).not.toHaveURL(/allFiles/);
    });
});
