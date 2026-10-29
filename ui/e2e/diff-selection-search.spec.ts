import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

/** One word, so a double click selects all of it. */
const TOKEN = "diffselectiontoken";

test.describe("Diff selection search", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        if (testDirPath === "") {
            return;
        }

        await teardownTestDir(testDirPath);
        testDirPath = "";
    });

    test("searches text selected in a diff from the git repository root", async ({
        page,
    }) => {
        const ctx = await setupTestDir("diff-selection-search");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const nestedPath = path.join(repositoryPath, "src");
        const filePath = path.join(nestedPath, "changed.txt");
        await fs.mkdir(nestedPath, { recursive: true });
        await fs.writeFile(filePath, "first line\n");
        // Only a search from the repository root reaches this file outside the diffed folder.
        await fs.writeFile(path.join(repositoryPath, "README"), `${TOKEN}\n`);
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        await fs.writeFile(filePath, `first line\nconst ${TOKEN} = 1\n`);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );

        const diff = page.getByRole("region", { name: "Full Git diff" });

        const searchButton = page.getByRole("button", {
            name: "Search selected text",
        });

        await expect(diff).toContainText(TOKEN);
        // The button only appears for a selection, so it never covers an untouched diff.
        await expect(searchButton).toHaveCount(0);

        await diff.getByText(TOKEN).dblclick();
        await expect(searchButton).toBeVisible();
        await searchButton.click();

        const dialog = page.getByRole("dialog", { name: "Search device" });

        // The dialog opens on the selected word as a content search.
        await expect(
            dialog.getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue(TOKEN);
        await expect(page).toHaveURL(new RegExp(`[?&]q=${TOKEN}(?:&|$)`));
        await expect(page).toHaveURL(/[?&]mode=content(?:&|$)/);
        await expect(page).toHaveURL(/[?&]gitroot=true(?:&|$)/);
        // The scope is the repository root rather than the diffed file's folder.
        await expect(dialog).toContainText(`Search in ${repositoryPath}`);
        await expect(
            dialog.getByRole("link", { name: /Open .*README at line 1/ }),
        ).toBeVisible();
    });

    test("searches text selected in a commit message", async ({ page }) => {
        const ctx = await setupTestDir("commit-message-selection-search");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const nestedPath = path.join(repositoryPath, "src");
        await fs.mkdir(nestedPath, { recursive: true });
        await fs.writeFile(path.join(nestedPath, "changed.txt"), "content\n");
        await fs.writeFile(path.join(repositoryPath, "README"), `${TOKEN}\n`);
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m ${"Add the files"} -m ${`Mentions ${TOKEN} in the body`}`;

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(nestedPath)}?view=git&rev=HEAD`,
        );

        const body = page.getByText(`Mentions ${TOKEN} in the body`);

        const searchButton = page.getByRole("button", {
            name: "Search selected text",
        });

        await expect(body).toBeVisible();

        // Selecting the commit body offers the same search as a selection in its diffs.
        await body.dblclick({ position: { x: 100, y: 5 } });
        await expect(searchButton).toBeVisible();
        await searchButton.click();

        const dialog = page.getByRole("dialog", { name: "Search device" });

        // The double-clicked word from the body seeds a content search from the repository root.
        await expect(
            dialog.getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue(TOKEN);
        await expect(page).toHaveURL(/[?&]mode=content(?:&|$)/);
        await expect(page).toHaveURL(/[?&]gitroot=true(?:&|$)/);
        await expect(dialog).toContainText(`Search in ${repositoryPath}`);
    });
});
