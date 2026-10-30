import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe("Git status column", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let outsidePath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-status-column");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        // The test directory may itself sit inside a checkout, so the plain directory lives
        // in the system temp directory instead.
        outsidePath = path.join(
            os.tmpdir(),
            `redoor-git-status-column-outside-${process.pid}`,
        );
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(path.join(outsidePath, "plain.txt"), "plain");

        await fs.mkdir(path.join(repositoryPath, "src"), { recursive: true });
        await fs.writeFile(path.join(repositoryPath, ".gitignore"), "*.log");
        await fs.writeFile(path.join(repositoryPath, "clean.txt"), "clean");
        await fs.writeFile(path.join(repositoryPath, "notes.txt"), "baseline");
        await fs.writeFile(path.join(repositoryPath, "src", "main.ts"), "one");
        await $`git -C ${repositoryPath} init --initial-branch=main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        await fs.writeFile(path.join(repositoryPath, "notes.txt"), "edited");
        await fs.writeFile(path.join(repositoryPath, "debug.log"), "ignored");
        await fs.writeFile(path.join(repositoryPath, "src", "main.ts"), "two");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(outsidePath, { force: true, recursive: true });
    });

    test("marks changed, ignored and clean entries of a repository directory", async ({
        page,
    }) => {
        await page.goto(deviceBrowserUrl(ctx.agentName, repositoryPath));

        // The column is there inside a worktree, announced by its header.
        await expect(
            page.getByRole("columnheader", { name: "Git status" }),
        ).toBeVisible();

        const modified = page
            .getByRole("row", { name: "File entry notes.txt" })
            .getByRole("img", { name: "Modified" });

        // An unstaged edit shows the modified symbol with a matching accessible name.
        await expect(modified).toBeVisible();
        // Hovering the symbol explains it in words as well.
        await modified.hover();
        await expect(page.getByRole("tooltip")).toHaveText("Modified");

        // A file matched by .gitignore says so.
        await expect(
            page
                .getByRole("row", { name: "File entry debug.log" })
                .getByRole("img", { name: "Ignored by .gitignore" }),
        ).toBeVisible();

        // A directory holding a change is marked with what it contains.
        await expect(
            page
                .getByRole("row", { name: "Directory entry src" })
                .getByRole("img", { name: "Contains 1 changed" }),
        ).toBeVisible();

        // A clean tracked file has no symbol at all.
        await expect(
            page
                .getByRole("cell", { name: "Git status of clean.txt" })
                .getByRole("img"),
        ).toHaveCount(0);
    });

    test("sorts changed entries before clean ones by Git status", async ({
        page,
    }) => {
        await page.goto(deviceBrowserUrl(ctx.agentName, repositoryPath));

        const notesSymbol = page
            .getByRole("row", { name: "File entry notes.txt" })
            .getByRole("img", { name: "Modified" });

        // The order only follows the status once the status is known.
        await expect(notesSymbol).toBeVisible();
        await page
            .getByRole("button", { name: "Sort by Git status ascending" })
            .click();

        const fileRows = page.getByRole("row", { name: /^File entry / });

        // The modified file leads, ahead of the alphabetically earlier clean file.
        await expect(fileRows.first()).toHaveAccessibleName(
            "File entry notes.txt",
        );
        // The ignored file comes after every clean one.
        await expect(fileRows.last()).toHaveAccessibleName(
            "File entry debug.log",
        );
    });

    test("leaves the column out outside a repository", async ({ page }) => {
        await page.goto(deviceBrowserUrl(ctx.agentName, outsidePath));

        await expect(
            page.getByRole("row", { name: "File entry plain.txt" }),
        ).toBeVisible();
        // Plain directories have no Git state, so the column would only take room.
        await expect(
            page.getByRole("columnheader", { name: "Git status" }),
        ).toHaveCount(0);
    });
});
