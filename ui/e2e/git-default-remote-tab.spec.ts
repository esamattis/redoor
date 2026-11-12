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

test.describe("Git view comparison with the default remote branch", () => {
    let ctx: TestContext;
    let upstreamPath: string;
    let checkoutPath: string;
    let localOnlyPath: string;

    /** Runs git in a repository with a fixed identity, so commits never need host config. */
    async function git(repository: string, ...args: string[]) {
        return $`git -C ${repository} -c user.email=playwright@redoor.test -c user.name=Playwright ${args}`;
    }

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-default-remote-tab");
        upstreamPath = path.join(ctx.testDirPath, "upstream");
        checkoutPath = path.join(ctx.testDirPath, "checkout");
        localOnlyPath = path.join(ctx.testDirPath, "local-only");

        await fs.mkdir(upstreamPath);
        await git(upstreamPath, "init", "-q", "-b", "main");
        await fs.writeFile(path.join(upstreamPath, "base.txt"), "base\n");
        await git(upstreamPath, "add", ".");
        await git(upstreamPath, "commit", "-q", "-m", "Initial import");

        await $`git clone -q ${upstreamPath} ${checkoutPath}`;
        await git(checkoutPath, "checkout", "-q", "-b", "feature");
        await fs.writeFile(
            path.join(checkoutPath, "early.txt"),
            "early work\n",
        );
        await git(checkoutPath, "add", ".");
        await git(checkoutPath, "commit", "-q", "-m", "Early work");

        // Main squashes the branch's early work under a new commit id, then moves on.
        await fs.writeFile(
            path.join(upstreamPath, "early.txt"),
            "early work\n",
        );
        await git(upstreamPath, "add", ".");
        await git(upstreamPath, "commit", "-q", "-m", "Squash early work");
        await fs.writeFile(
            path.join(upstreamPath, "unrelated.txt"),
            "unrelated main work\n",
        );
        await git(upstreamPath, "add", ".");
        await git(upstreamPath, "commit", "-q", "-m", "Unrelated main work");

        await git(checkoutPath, "fetch", "-q");
        await fs.writeFile(
            path.join(checkoutPath, "feature.txt"),
            "own branch work\n",
        );
        await git(checkoutPath, "add", ".");
        await git(checkoutPath, "commit", "-q", "-m", "Own branch work");

        await fs.mkdir(localOnlyPath);
        await git(localOnlyPath, "init", "-q", "-b", "main");
        await git(localOnlyPath, "commit", "-q", "--allow-empty", "-m", "Only");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("shows only what the branch adds to origin/main", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, checkoutPath)}?view=git`,
        );

        const gitTabs = page.getByLabel("Git view");
        const tab = gitTabs.getByRole("link", { name: "vs origin/main" });
        await tab.click();

        // The tab opens the merge-preview range against the remote-tracking branch.
        await expect(page).toHaveURL(
            /rev=refs(%2F|\/)remotes(%2F|\/)origin(%2F|\/)main(\.|%2E){3}HEAD/,
        );
        await expect(
            page.getByRole("heading", {
                name: "What HEAD adds to origin/main",
            }),
        ).toBeVisible();
        // While exactly that range is open the tab, not Changes, is the active one.
        await expect(tab).toHaveAttribute("aria-current", "page");
        await expect(
            gitTabs.getByRole("link", { name: "Changes" }),
        ).not.toHaveAttribute("aria-current", "page");

        // The branch's own work is listed.
        await expect(
            page.getByRole("region", { name: "Commit diff for feature.txt" }),
        ).toContainText("own branch work");
        // The squashed early work is already on main, so it cancels out.
        await expect(
            page.getByRole("region", { name: "Commit diff for early.txt" }),
        ).toHaveCount(0);
        // Main's unrelated commit is not shown reversed as a deletion.
        await expect(
            page.getByRole("region", { name: "Commit diff for unrelated.txt" }),
        ).toHaveCount(0);
        // The header says the diff is a merge preview and how fresh origin/main is.
        await expect(
            page.getByText("As if merged into origin/main now."),
        ).toBeVisible();
        await expect(page.getByText(/origin\/main fetched/)).toBeVisible();

        await gitTabs.getByRole("link", { name: "Changes" }).click();

        // Changes leaves the range for the working tree's own changes.
        await expect(page).not.toHaveURL(/rev=/);
        await expect(
            gitTabs.getByRole("link", { name: "Changes" }),
        ).toHaveAttribute("aria-current", "page");
    });

    test("explains when there is no default remote branch", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, localOnlyPath)}?view=git`,
        );

        const tab = page
            .getByLabel("Git view")
            .getByRole("link", { name: "vs upstream" });

        await tab.click();

        // The tab stays in place and explains instead of opening a range.
        await expect(page).toHaveURL(/gitTab=upstream/);
        await expect(tab).toHaveAttribute("aria-current", "page");
        await expect(page.getByText("No default remote branch.")).toBeVisible();
    });
});
