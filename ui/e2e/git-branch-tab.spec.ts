import { expect, test } from "@playwright/test";
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

test.describe("Git branch tab", () => {
    let ctx: TestContext;
    let repositoryPath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-branch-tab");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        await fs.mkdir(path.join(repositoryPath, "src"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, "src", "main.ts"),
            "export {};",
        );
        await $`git -C ${repositoryPath} init --initial-branch=feature-x`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("names the checked-out branch or detached commit on the Git tab", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(repositoryPath, "src"))}`,
        );
        const directoryView = page.getByLabel("Directory view");

        const branchTab = directoryView.getByRole("link", {
            name: "Git, branch feature-x",
            exact: true,
        });

        // A directory below the repository root still names the repository's branch.
        await expect(branchTab).toHaveText("feature-x");

        await branchTab.click();
        // The tab still opens the Git view, which then becomes the current page.
        await expect(branchTab).toHaveAttribute("aria-current", "page");
        await expect(page).toHaveURL(/\?view=git$/);

        await $`git -C ${repositoryPath} checkout --detach`;

        const headCommit = (
            await $`git -C ${repositoryPath} rev-parse HEAD`
        ).stdout.trim();

        const shortCommit = headCommit.slice(0, 12);
        await page.reload();

        const detachedTab = directoryView.getByRole("link", {
            name: `Git, detached at ${shortCommit}`,
            exact: true,
        });

        // Without a branch, the tab names the commit HEAD is on instead.
        await expect(detachedTab).toHaveText(shortCommit);
    });
});
