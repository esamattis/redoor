import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Git worktree list", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let featurePath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-worktrees");
        repositoryPath = path.join(ctx.testDirPath, "worktrees-repository");
        featurePath = path.join(ctx.testDirPath, "feature-checkout");
        await fs.mkdir(repositoryPath, { recursive: true });
        await fs.writeFile(path.join(repositoryPath, "notes.txt"), "notes\n");
        await $`git -C ${repositoryPath} init -b main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m ${"Initial import"}`;
        await $`git -C ${repositoryPath} worktree add -b feature ${featurePath}`;

        // The feature checkout holds both kinds of uncommitted work.
        await fs.writeFile(path.join(featurePath, "notes.txt"), "edited\n");
        await fs.writeFile(path.join(featurePath, "draft.txt"), "draft\n");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("lists worktrees with their branches and changes and opens one", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git`,
        );

        const gitTabs = page.getByLabel("Git view");
        await gitTabs.getByRole("link", { name: "Worktrees" }).click();

        // The list is a Git view tab kept in the URL.
        await expect(page).toHaveURL(/view=git&gitTab=worktrees/);

        const worktrees = page.getByRole("list", { name: "Worktrees" });
        const rows = worktrees.getByRole("listitem");

        // Both checkouts are listed, the main one first and marked as the current one.
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText("worktrees-repository");
        await expect(rows.first()).toContainText("Main");
        await expect(rows.first()).toHaveAttribute("aria-current", "true");
        await expect(rows.first()).toContainText("main");
        await expect(rows.first()).toContainText("Clean");

        // The linked checkout names its branch and splits tracked edits from new files.
        await expect(rows.nth(1)).toContainText("feature");
        await expect(rows.nth(1)).toContainText("1 changed");
        await expect(rows.nth(1)).toContainText("1 untracked");

        await rows
            .nth(1)
            .getByRole("link", { name: "feature-checkout", exact: true })
            .click();

        // A worktree opens its own Git changes, whose header names its branch.
        await expect(page).toHaveURL(/feature-checkout/);
        await expect(
            page.getByRole("region", { name: "Git repository" }),
        ).toContainText("feature");
        await expect(
            page.getByRole("link", { name: "draft.txt" }),
        ).toBeVisible();

        await gitTabs.getByRole("link", { name: "Worktrees" }).click();

        // From the linked checkout the main worktree still leads, and the current mark moves.
        await expect(rows.first()).toContainText("worktrees-repository");
        await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    });
});
