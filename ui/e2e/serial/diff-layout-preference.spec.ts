// Serial: changes the shared user settings to pick the starting diff layout.
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import { expect, test } from "../fixtures";

import { ApiClient } from "#ui/api-client";
import { defaultUserState } from "#ui/user-state";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
} from "../helpers";
import type { TestContext } from "../helpers";

test.describe.serial("Diff layout preference", () => {
    let ctx: TestContext;
    let api: ApiClient;
    let filePath = "";

    test.beforeAll(async () => {
        ctx = await setupTestDir("diff-layout-preference");
        api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const repositoryPath = path.join(ctx.testDirPath, "repository");

        filePath = path.join(repositoryPath, "notes.ts");
        await fs.mkdir(repositoryPath, { recursive: true });
        await fs.writeFile(filePath, 'export const mode = "committed";\n');
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        await fs.writeFile(filePath, 'export const mode = "edited";\n');
    });

    test.afterAll(async () => {
        await api.updateUserState({ state: defaultUserState });
        await teardownTestDir(ctx.testDirPath);
    });

    test("starts diffs with inline changes once chosen on the preferences page", async ({
        page,
    }) => {
        await api.updateUserState({ state: defaultUserState });

        const diffUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`;
        const diff = page.getByRole("region", { name: "Full Git diff" });

        const layout = diff.getByRole("group", {
            name: "Diff layout for notes.ts",
        });

        await page.goto(diffUrl);

        // Without the preference a diff starts with separate removed and added rows.
        await expect(
            layout.getByRole("button", { name: "Separate lines" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(diff.locator('tr[data-line-kind="delete"]')).toHaveCount(
            1,
        );

        await page.goto(`${WEB_BASE_URL}/settings/preferences`);

        const inlineDefault = page.getByRole("button", {
            name: "Show inline changes by default",
        });

        await expect(inlineDefault).toHaveAttribute("aria-pressed", "false");
        await inlineDefault.click();

        // The preference must reach the user state so it applies in every browser.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({ inlineDiffChanges: true });

        await page.goto(diffUrl);

        // The diff now starts with the edited line as one row marking the changed words.
        await expect(
            layout.getByRole("button", { name: "Inline changes" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(diff.locator('tr[data-line-kind="modified"]')).toHaveCount(
            1,
        );
    });
});
