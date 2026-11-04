import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    confirmSelectedTransfer,
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Git history copies and downloads", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let firstCommit: string;
    const crossDeviceTargets: string[] = [];

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-history-transfers");
        repositoryPath = path.join(ctx.testDirPath, "history-repository");
        await fs.mkdir(path.join(repositoryPath, "src"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "first";\n',
        );
        await fs.writeFile(
            path.join(repositoryPath, "src", "retired.ts"),
            "export const retired = true;\n",
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
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "second";\n',
        );
        await fs.rm(path.join(repositoryPath, "src", "retired.ts"));
        await $`git -C ${repositoryPath} add -A`;
        await $`git -C ${repositoryPath} commit -m ${"Bump version"}`;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await Promise.all(
            crossDeviceTargets.map((target) =>
                fs.rm(target, { force: true, recursive: true }),
            ),
        );
    });

    test("restores an older file version into the working directory", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src"))}?rev=v1`,
        );
        await page
            .getByRole("checkbox", { name: "Select file app.ts" })
            .click();
        // The committed entry is now part of the selection.
        await expect(
            page.getByRole("checkbox", { name: "Unselect file app.ts" }),
        ).toHaveAttribute("aria-checked", "true");

        await page
            .getByRole("region", { name: "Git revision" })
            .getByRole("link", { name: "Working tree" })
            .click();
        await expect(page).toHaveURL(/\/src$/);

        // The working file is a different source than its committed version.
        await expect(
            page.getByRole("checkbox", { name: "Select file app.ts" }),
        ).toHaveAttribute("aria-checked", "false");
        // A commit cannot be deleted, so the selection offers neither Move nor Delete.
        await expect(
            page.getByRole("button", {
                name: "Move selected items to this directory",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Delete selected items" }),
        ).toHaveCount(0);

        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Copy selected item?",
        });

        const resolution = dialog.getByRole("combobox", {
            name: "If app.ts exists",
        });

        // Restoring over the working file is a conflict, not copying a file onto itself.
        await expect(resolution).toBeVisible();
        // The dialog names the commit the item is copied from.
        await expect(
            dialog.getByLabel(`At commit ${firstCommit.slice(0, 12)}`),
        ).toBeVisible();
        await resolution.selectOption("override");

        const copyRequest = page.waitForRequest(
            (request) =>
                request.url() === `${WEB_BASE_URL}/api/v1/copy` &&
                request.method() === "POST",
        );

        await dialog
            .getByRole("button", { name: "Copy selected item", exact: true })
            .click();
        // The copy reads the commit the tag resolved to, not the moving tag name.
        expect((await copyRequest).postDataJSON().source_rev).toBe(firstCommit);
        // A finished copy unselects its item.
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // The working file now holds the committed content again.
        await expect(
            fs.readFile(path.join(repositoryPath, "src", "app.ts"), "utf8"),
        ).resolves.toBe('export const version = "first";\n');
    });

    test("renames versions of one file copied into the same directory", async ({
        page,
    }) => {
        const destination = path.join(ctx.testDirPath, "both-versions");
        await fs.mkdir(destination);

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src"))}?rev=v1`,
        );
        await page
            .getByRole("checkbox", { name: "Select file app.ts" })
            .click();
        await page.goto(
            deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src")),
        );
        await page
            .getByRole("checkbox", { name: "Select file app.ts" })
            .click();
        await page.goto(deviceBrowserUrl(ctx.agentName, destination));
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();

        const dialog = page.getByRole("dialog", {
            name: "Copy selected items?",
        });

        const nameFields = dialog.getByRole("textbox", {
            name: "Name for app.ts",
        });

        // Two versions of app.ts would land on one path in an empty directory.
        await expect(nameFields).toHaveCount(2);
        // The second version gets a free name of its own instead of colliding.
        await expect(nameFields.nth(1)).not.toHaveValue("app.ts");
        await dialog
            .getByRole("button", { name: "Copy selected items", exact: true })
            .click();
        // Both copies finish and unselect their items.
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // Each version is kept under its own name.
        await expect
            .poll(async () => (await fs.readdir(destination)).length)
            .toBe(2);
    });

    test("copies a committed directory to another device", async ({ page }) => {
        test.setTimeout(60_000);

        const destination = path.join(
            ctx.agent2Home,
            `history-copy-${Date.now()}`,
        );

        crossDeviceTargets.push(destination);
        await fs.mkdir(destination, { recursive: true });

        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?rev=v1`,
        );
        await page
            .getByRole("checkbox", { name: "Select directory src" })
            .click();
        await page.goto(deviceBrowserUrl(ctx.agent2Name, destination));
        await page
            .getByRole("button", {
                name: "Copy selected items to this directory",
            })
            .click();
        await confirmSelectedTransfer(page, "Copy");
        // A finished copy unselects its item.
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });
        // The file deleted since the tag exists in the copy of the tagged tree.
        await expect(
            fs.readFile(path.join(destination, "src", "retired.ts"), "utf8"),
        ).resolves.toBe("export const retired = true;\n");
    });

    test("downloads a file as committed at a revision", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "retired.ts"))}?view=details&rev=v1`,
        );

        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download" }).click();
        const download = await downloadEvent;
        // The browser saves the file under its own name.
        expect(download.suggestedFilename()).toBe("retired.ts");

        const downloadedPath = await download.path();
        // The bytes are the committed blob of a file deleted since.
        await expect(fs.readFile(downloadedPath, "utf8")).resolves.toBe(
            "export const retired = true;\n",
        );
    });

    test("downloads a committed directory as a .tar.gz", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src"))}?rev=v1`,
        );

        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download" }).click();
        const download = await downloadEvent;
        // Directories download as gzip-compressed tar archives.
        expect(download.suggestedFilename()).toBe("src.tar.gz");

        // Extracted inside the test directory, which the suite's teardown removes.
        const extractPath = path.join(ctx.testDirPath, "extracted-archive");
        await fs.mkdir(extractPath);
        await $`tar -xzf ${await download.path()} -C ${extractPath}`;
        // The archive holds the tagged tree under the directory's own name.
        await expect(
            fs.readFile(path.join(extractPath, "src", "retired.ts"), "utf8"),
        ).resolves.toBe("export const retired = true;\n");
        await expect(
            fs.readFile(path.join(extractPath, "src", "app.ts"), "utf8"),
        ).resolves.toBe('export const version = "first";\n');
    });
});
