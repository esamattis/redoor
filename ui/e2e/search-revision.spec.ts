import { expect, test } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

test.describe("Search on a Git revision page", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        if (testDirPath === "") {
            return;
        }

        await teardownTestDir(testDirPath);
        testDirPath = "";
    });

    test("searches the browsed folder and copies its path", async ({
        page,
        context,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const ctx = await setupTestDir("search-revision");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        await fs.mkdir(repositoryPath, { recursive: true });
        await fs.writeFile(path.join(repositoryPath, "file.txt"), "content\n");
        await $`git -C ${repositoryPath} init --initial-branch=main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git&rev=HEAD`,
        );
        await expect(page.getByText("baseline").first()).toBeVisible();
        await page.keyboard.press("s");

        const dialog = page.getByRole("dialog", { name: "Search device" });
        // The revision's folder is the browsed one, not the agent's home.
        await expect(dialog).toContainText(`Search in ${repositoryPath}`);

        await dialog
            .getByRole("button", { name: "Copy search folder path" })
            .click();
        await page.getByRole("button", { name: /Copy absolute path/ }).click();
        // The pick lands the searched folder on the clipboard.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(repositoryPath);
    });
});
