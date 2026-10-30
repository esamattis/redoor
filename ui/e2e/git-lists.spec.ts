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

test.describe.serial("Git commit, branch and tag lists", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let manyCommitsPath: string;
    let firstCommit: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-lists");
        repositoryPath = path.join(ctx.testDirPath, "lists-repository");
        await fs.mkdir(path.join(repositoryPath, "src"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "first";\n',
        );
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "first notes\n",
        );
        await $`git -C ${repositoryPath} init -b main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m ${"Initial import"}`;
        await $`git -C ${repositoryPath} tag v1`;
        firstCommit = (
            await $`git -C ${repositoryPath} rev-parse HEAD`
        ).stdout.trim();

        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "second notes\n",
        );
        await $`git -C ${repositoryPath} commit -am ${"Rewrite notes"}`;
        await fs.writeFile(
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "second";\n',
        );
        await $`git -C ${repositoryPath} commit -am ${"Bump version"}`;
        await $`git -C ${repositoryPath} branch feature ${firstCommit}`;

        // One commit more than a page, so the list has to load more.
        manyCommitsPath = path.join(ctx.testDirPath, "many-commits");
        await fs.mkdir(manyCommitsPath);
        await $`git -C ${manyCommitsPath} init -b main`;
        await $`git -C ${manyCommitsPath} config user.email playwright@redoor.test`;
        await $`git -C ${manyCommitsPath} config user.name Playwright`;
        await $({
            cwd: manyCommitsPath,
        })`bash -c ${'for i in $(seq 1 101); do git commit --allow-empty -q -m "Commit $i"; done'}`;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("lists the commits that changed a file and opens one", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "app.ts"))}?view=git`,
        );

        const gitTabs = page.getByLabel("Git view");
        await gitTabs.getByRole("link", { name: "Commits" }).click();

        // The list is a Git view tab kept in the URL.
        await expect(page).toHaveURL(/view=git&gitTab=commits/);
        await expect(
            gitTabs.getByRole("link", { name: "Commits" }),
        ).toHaveAttribute("aria-current", "page");

        const commits = page.getByRole("group", { name: "Commit history" });

        // Only commits that changed the file are listed, newest first.
        await expect(commits.getByRole("listitem")).toHaveCount(2);
        await expect(commits.getByRole("listitem").first()).toContainText(
            "Bump version",
        );
        await expect(commits).not.toContainText("Rewrite notes");
        await expect(page.getByText("Only commits that changed")).toContainText(
            "src/app.ts",
        );

        await commits.getByRole("link", { name: "Initial import" }).click();

        // A commit opens the same file at that commit, showing what the commit changed.
        await expect(page).toHaveURL(new RegExp(`rev=${firstCommit}`));
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toContainText("Initial import");
        await expect(
            page.getByRole("region", { name: "Commit diff for src/app.ts" }),
        ).toContainText('version = "first"');

        await gitTabs.getByRole("link", { name: "Commits" }).click();

        // History at a revision starts at that commit and marks it as the one being viewed.
        await expect(commits.getByRole("listitem")).toHaveCount(1);
        await expect(commits.getByRole("listitem").first()).toHaveAttribute(
            "aria-current",
            "true",
        );
    });

    test("opens a branch and a tag from their lists", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=branches`,
        );

        const branches = page.getByRole("list", { name: "Branches" });

        // Both branches are listed and only the checked-out one is marked.
        await expect(branches.getByRole("listitem")).toHaveCount(2);
        await expect(
            branches.getByRole("listitem").filter({ hasText: "HEAD" }),
        ).toContainText("main");

        await branches
            .getByRole("link", { name: "feature", exact: true })
            .click();

        // A branch opens the browsed path at that branch, by its unambiguous full name.
        await expect(page).toHaveURL(/rev=refs(%2F|\/)heads(%2F|\/)feature/);
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toContainText("Initial import");
        // The banner shows the short branch name people type.
        await expect(
            page
                .getByRole("region", { name: "Git revision" })
                .getByLabel("Revision"),
        ).toHaveText("feature");

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=tags`,
        );

        const tags = page.getByRole("list", { name: "Tags" });
        await tags.getByRole("link", { name: "v1", exact: true }).click();

        // A tag opens the browsed path at the tagged commit.
        await expect(page).toHaveURL(/rev=refs(%2F|\/)tags(%2F|\/)v1/);
        await expect(
            page
                .getByRole("region", { name: "Git revision" })
                .getByLabel("Revision"),
        ).toHaveText("v1");
    });

    test("sorts branches by name and keeps the order for tags", async ({
        page,
    }) => {
        // A branch whose commit is newer than every other, so the two orders differ.
        // Raw Unix seconds for 2100-01-01, a format every git version accepts.
        const futureDate = "@4102444800 +0000";

        const futureCommit = (
            await $({
                env: {
                    ...process.env,
                    GIT_AUTHOR_DATE: futureDate,
                    GIT_COMMITTER_DATE: futureDate,
                },
            })`git -C ${repositoryPath} commit-tree -p HEAD -m ${"Future"} HEAD^{tree}`
        ).stdout.trim();

        // Later tests do not count this repository's branches, so it is left for teardown.
        await $`git -C ${repositoryPath} branch zeta ${futureCommit}`;

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=branches`,
        );

        const branches = page.getByRole("list", { name: "Branches" });

        // The default branch leads and is marked, even though zeta has a newer commit.
        await expect(branches.getByRole("listitem").first()).toContainText(
            "main",
        );
        await expect(branches.getByRole("listitem").first()).toContainText(
            "Default",
        );
        // The newest of the other branches follows.
        await expect(branches.getByRole("listitem").nth(1)).toContainText(
            "zeta",
        );

        await page
            .getByRole("group", { name: "Sort branches" })
            .getByRole("button", { name: "Name" })
            .click();

        // The order is kept in the URL, main stays first and the rest follow by name.
        await expect(page).toHaveURL(/refSort=name/);
        await expect(branches.getByRole("listitem").nth(1)).toContainText(
            "feature",
        );
        await expect(branches.getByRole("listitem").first()).toContainText(
            "main",
        );

        await page
            .getByLabel("Git view")
            .getByRole("link", { name: "Tags" })
            .click();

        // Switching to tags keeps the chosen order.
        await expect(page).toHaveURL(/gitTab=tags/);
        await expect(page).toHaveURL(/refSort=name/);
        await expect(
            page
                .getByRole("group", { name: "Sort tags" })
                .getByRole("button", { name: "Name" }),
        ).toHaveAttribute("aria-pressed", "true");

        await page
            .getByRole("group", { name: "Sort tags" })
            .getByRole("button", { name: "Recent" })
            .click();

        // The default order stays out of the URL.
        await expect(page).not.toHaveURL(/refSort=/);
    });

    test("compares the checkout with a branch it split from", async ({
        page,
    }) => {
        // A branch that moved on after main split from it, so comparing tips directly would
        // show its commit reverted, while the merge-base comparison must leave it out.
        await $`git -C ${repositoryPath} checkout -q -b side ${firstCommit}`;
        await fs.writeFile(
            path.join(repositoryPath, "side.txt"),
            "only on side\n",
        );
        await $`git -C ${repositoryPath} add side.txt`;
        await $`git -C ${repositoryPath} commit -m ${"Side work"}`;
        await $`git -C ${repositoryPath} checkout -q main`;

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=branches`,
        );

        const branches = page.getByRole("list", { name: "Branches" });

        // The checked-out branch has nothing to compare with itself.
        await expect(
            branches.getByRole("link", { name: "Compare checkout with main" }),
        ).toHaveCount(0);

        await branches
            .getByRole("link", { name: "Compare checkout with side" })
            .click();

        // The comparison is a symmetric range kept in the URL, so it can be shared and reloaded.
        await expect(page).toHaveURL(
            /rev=refs(%2F|\/)heads(%2F|\/)side(\.|%2E){3}HEAD/,
        );
        // The header says whose work is shown against which branch.
        await expect(
            page.getByRole("heading", { name: "What HEAD adds to side" }),
        ).toBeVisible();
        // Both of main's own commits are in the diff, measured from where the branches split.
        await expect(
            page.getByRole("region", { name: "Commit diff for notes.txt" }),
        ).toContainText("second notes");
        await expect(
            page.getByRole("region", { name: "Commit diff for src/app.ts" }),
        ).toBeVisible();
        // The side branch's own file is not listed as deleted, as a tip-to-tip diff would.
        await expect(
            page.getByRole("region", { name: "Commit diff for side.txt" }),
        ).toHaveCount(0);
    });

    test("loads more commits beyond the first page", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, manyCommitsPath)}?view=git&gitTab=commits`,
        );

        const commits = page.getByRole("group", { name: "Commit history" });

        // The first page stops at 100 rows.
        await expect(commits.getByRole("listitem")).toHaveCount(100);
        await expect(commits.getByRole("listitem").first()).toContainText(
            "Commit 101",
        );

        await page.getByRole("button", { name: "Load more commits" }).click();

        // The next page appends the remaining oldest commit and the button goes away.
        await expect(commits.getByRole("listitem")).toHaveCount(101);
        await expect(
            commits
                .getByRole("listitem")
                .last()
                .getByRole("link", { name: "Commit 1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Load more commits" }),
        ).toHaveCount(0);
    });

    test("copies full commit hashes and branch names", async ({
        page,
        context,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=commits`,
        );

        const firstCommitRow = page
            .getByRole("group", { name: "Commit history" })
            .getByRole("listitem")
            .filter({ hasText: "Initial import" });

        await firstCommitRow
            .getByRole("button", {
                name: `Copy commit hash ${firstCommit.slice(0, 12)}`,
            })
            .click();

        // The button confirms the copy so a phone user knows the tap worked.
        await expect(
            firstCommitRow.getByRole("button", { name: "Copied!" }),
        ).toBeVisible();
        // The row shows a short hash, but the clipboard gets the full one for the terminal.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(firstCommit);

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=branches`,
        );

        await page
            .getByRole("list", { name: "Branches" })
            .getByRole("button", { name: "Copy branch name feature" })
            .click();

        // A branch is copied by the short name people type, not its full ref.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe("feature");
    });
});
