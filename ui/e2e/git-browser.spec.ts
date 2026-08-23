import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    simulateTabRefocus,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

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

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-browser");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        trackedPath = path.join(repositoryPath, "tracked.txt");
        untrackedPath = path.join(repositoryPath, "untracked.txt");
        ignoredPath = path.join(repositoryPath, "ignored.txt");
        binaryPath = path.join(repositoryPath, "binary.dat");
        largePath = path.join(repositoryPath, "large.txt");
        deletedPath = path.join(repositoryPath, "deleted.txt");
        outsidePath = path.join(
            os.tmpdir(),
            `redoor-git-browser-outside-${process.pid}`,
        );

        await fs.mkdir(path.join(repositoryPath, "clean"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, ".gitignore"),
            "ignored.txt\n",
        );
        await fs.writeFile(trackedPath, "committed version\n");
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

        await fs.writeFile(trackedPath, "staged version\n");
        await $`git -C ${repositoryPath} add tracked.txt`;
        await fs.writeFile(trackedPath, "worktree version\n");
        await fs.writeFile(untrackedPath, "untracked content\n");
        await fs.writeFile(ignoredPath, "ignored content\n");
        await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
        await fs.writeFile(largePath, "L".repeat(2 * 1024 * 1024 + 1));
        await fs.rm(deletedPath);
        await fs.mkdir(outsidePath, { recursive: true });
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(outsidePath, { force: true, recursive: true });
    });

    test("browses status, file comparisons, refreshes, and explicit diff states", async ({
        page,
    }) => {
        const repositoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(repositoryPath)}`;
        await page.setViewportSize({ width: 360, height: 844 });
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
        // Structured status must expose staged, unstaged, and untracked groups.
        await expect(
            page.getByRole("heading", { name: /Staged changes/ }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: /Unstaged changes/ }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: /Untracked files/ }),
        ).toBeVisible();
        // Ignored paths stay out of directory status even though direct browsing supports them.
        await expect(
            page.getByRole("link", { name: "ignored.txt", exact: true }),
        ).toHaveCount(0);

        await page
            .getByRole("link", { name: "tracked.txt", exact: true })
            .first()
            .click();
        const fullDiff = page.getByRole("region", { name: "Full Git diff" });
        // The default comparison must show current worktree content.
        await expect(fullDiff).toContainText("worktree version");
        const fileView = page.getByLabel("File view");
        const fileTabs = await fileView.getByRole("link").allTextContents();
        // File Git uses the same stable post-Sync tab position as directory Git.
        expect(fileTabs.slice(-2)).toEqual(["Sync", "Git"]);

        await page.getByRole("radio", { name: /^Staged / }).check();
        const stagedDiff = page.getByRole("region", {
            name: "Staged Git diff",
        });
        // Staged mode must switch query identity and display index content only.
        await expect(stagedDiff).toContainText("staged version");
        await expect(stagedDiff).not.toContainText("worktree version");

        await page.getByRole("radio", { name: /^Full / }).check();
        await fs.writeFile(trackedPath, "refreshed worktree version\n");
        await simulateTabRefocus(page);
        // Focus refresh must invalidate the Git cache independently of the unchanged listing.
        await expect(
            page.getByRole("region", { name: "Full Git diff" }),
        ).toContainText("refreshed worktree version");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(untrackedPath)}?view=git`,
        );
        // Direct untracked files explain why no synthetic patch exists.
        await expect(page.getByText(/This file is untracked/)).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(ignoredPath)}?view=git`,
        );
        // Ignored files retain a Git tab and expose their classification directly.
        await expect(
            page.getByText(/This file is ignored by Git/),
        ).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(binaryPath)}?view=git`,
        );
        // Binary outcomes must not be mistaken for clean text files.
        await expect(page.getByText(/This is a binary file/)).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(largePath)}?view=git`,
        );
        // Bounded API outcomes receive a useful size-specific message.
        await expect(
            page.getByText(/too large to display safely/),
        ).toBeVisible();
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(deletedPath)}?view=git`,
        );
        // A deleted filesystem path must bypass creation UI and retain its HEAD deletion diff.
        await expect(
            page.getByRole("region", { name: "Full Git diff" }),
        ).toContainText("deleted baseline");
        await expect(
            page.getByRole("heading", { name: "Create missing path" }),
        ).toHaveCount(0);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(path.join(repositoryPath, "clean"))}?view=git`,
        );
        // Prefix-filtered clean directories report clean even when siblings are modified.
        await expect(page.getByText(/Working tree is clean/)).toBeVisible();

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(outsidePath)}?view=git`,
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
