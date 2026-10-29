import { expect, test, type Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

/** Whether the diff table is wider than its box, so the reader would scroll it sideways. */
async function scrollsSideways(table: Locator) {
    return table.evaluate((element) => {
        const box = element.parentElement;

        return box !== null && box.scrollWidth > box.clientWidth;
    });
}

/** The worktree files the tests edit, so each test sees the same mixed change set. */
const files = ["src/server.ts", "src/server.test.ts", "src/my-test/helpers.ts"];

test.describe("Git diff list", () => {
    let testDirPath = "";
    let repositoryPath = "";
    let agentName = "";

    test.beforeEach(async () => {
        const ctx = await setupTestDir("git-diff-list");
        testDirPath = ctx.testDirPath;
        agentName = ctx.agentName;
        repositoryPath = path.join(ctx.testDirPath, "repository");
        await fs.mkdir(path.join(repositoryPath, "src", "my-test"), {
            recursive: true,
        });

        for (const file of files) {
            await fs.writeFile(
                path.join(repositoryPath, file),
                'export const mode = "committed";\n',
            );
        }

        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        for (const file of files) {
            await fs.writeFile(
                path.join(repositoryPath, file),
                'export const mode = "edited";\n',
            );
        }
    });

    test.afterEach(async () => {
        await teardownTestDir(testDirPath);
    });

    test("switches the diff layout of one file without changing the others", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        await page.getByRole("button", { name: "Expand all" }).click();

        const server = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.ts")}`,
        });

        const serverTest = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.test.ts")}`,
        });

        // Each file carries its own layout switch, starting from the fixed inline default.
        await expect(
            serverTest
                .getByRole("group", {
                    name: "Diff layout for src/server.test.ts",
                })
                .getByRole("button", { name: "Inline changes" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            serverTest.locator('tr[data-line-kind="modified"]'),
        ).toHaveCount(1);

        const serverLayout = server.getByRole("group", {
            name: "Diff layout for src/server.ts",
        });

        await serverLayout
            .getByRole("button", { name: "Separate lines" })
            .click();

        // The switched file lists its removed and added lines as their own rows.
        await expect(
            serverLayout.getByRole("button", { name: "Separate lines" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(server.locator('tr[data-line-kind="delete"]')).toHaveCount(
            1,
        );
        await expect(
            server.locator('tr[data-line-kind="modified"]'),
        ).toHaveCount(0);

        // The other file keeps its inline row, so the choice was only for one file.
        await expect(
            serverTest.locator('tr[data-line-kind="modified"]'),
        ).toHaveCount(1);
        await expect(
            serverTest.locator('tr[data-line-kind="delete"]'),
        ).toHaveCount(0);
    });

    test("wraps the long lines of one file without changing the others", async ({
        page,
    }) => {
        const longValue = "word ".repeat(200);

        // Both files get a line too long for the view, so either could scroll sideways.
        for (const file of ["src/server.ts", "src/server.test.ts"]) {
            await fs.writeFile(
                path.join(repositoryPath, file),
                `export const mode = "${longValue}";\n`,
            );
        }

        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        await page.getByRole("button", { name: "Expand all" }).click();

        const server = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.ts")}`,
        });

        const serverTest = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.test.ts")}`,
        });

        const serverTable = server.getByRole("table");
        const serverTestTable = serverTest.getByRole("table");

        const serverWrap = server.getByRole("button", {
            name: "Wrap diff lines for src/server.ts",
        });

        const serverTestWrap = serverTest.getByRole("button", {
            name: "Wrap diff lines for src/server.test.ts",
        });

        // Every file starts unwrapped, so long lines scroll sideways.
        await expect(serverWrap).toHaveAttribute("aria-pressed", "false");
        await expect(serverTestWrap).toHaveAttribute("aria-pressed", "false");
        await expect(serverTable).toBeVisible();
        await expect(serverTestTable).toBeVisible();
        expect(await scrollsSideways(serverTable)).toBe(true);
        expect(await scrollsSideways(serverTestTable)).toBe(true);

        await serverWrap.click();

        // The switched file fits its long line inside its box.
        await expect(serverWrap).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => scrollsSideways(serverTable)).toBe(false);

        // The other file still scrolls, so the choice was only for one file.
        await expect(serverTestWrap).toHaveAttribute("aria-pressed", "false");
        expect(await scrollsSideways(serverTestTable)).toBe(true);
    });

    test("filters files by name and excludes dashed words", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        const headers = page.getByRole("button", { name: /^Expand diff for/ });

        const filter = page.getByRole("textbox", {
            name: "Filter files by name",
        });

        // Without a filter every changed file is listed.
        await expect(headers).toHaveCount(3);

        await filter.fill("-test");

        // A dashed word hides every path containing it, test files and directories alike.
        await expect(headers).toHaveCount(1);
        await expect(
            page.getByRole("button", { name: "Expand diff for src/server.ts" }),
        ).toBeVisible();
        // The count tells that files are hidden rather than unchanged.
        await expect(page.getByText("Showing 1 of 3 files")).toBeVisible();

        await filter.fill('"-test"');

        // Quotes make the dash part of the word, so only the dashed directory matches.
        await expect(headers).toHaveCount(1);
        await expect(
            page.getByRole("button", {
                name: "Expand diff for src/my-test/helpers.ts",
            }),
        ).toBeVisible();

        await filter.fill("server -nothing");

        // Plain words must all appear, and an exclusion that matches nothing hides nothing.
        await expect(headers).toHaveCount(2);

        await filter.fill("missing");

        // An unmatched filter says so instead of looking like a clean worktree.
        await expect(headers).toHaveCount(0);
        await expect(page.getByText("No files match the filter")).toBeVisible();

        await page.getByRole("button", { name: "Clear file filter" }).click();

        // Clearing the filter lists every file again.
        await expect(headers).toHaveCount(3);
    });

    test("copies the file name, repository path or absolute path of a diff", async ({
        page,
        context,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        const absolutePath = path.join(
            repositoryPath,
            "src/my-test/helpers.ts",
        );

        const trigger = page.getByRole("button", {
            name: "Copy path of src/my-test/helpers.ts",
        });

        const options = [
            { name: "Copy file name", value: "helpers.ts" },
            { name: "Copy repository path", value: "src/my-test/helpers.ts" },
            { name: "Copy absolute path", value: absolutePath },
        ];

        for (const option of options) {
            // The menu is on the header, so a collapsed file can be copied without its patch.
            await trigger.click();
            await page
                .getByRole("dialog", { name: "Copy path" })
                .getByRole("button", { name: option.name })
                .click();

            // Each option puts its own form of the path on the clipboard.
            await expect
                .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                .toBe(option.value);
            // The menu closes on a pick, so the trigger confirms the async copy finished.
            await expect(
                page.getByRole("button", { name: "Copied!" }),
            ).toBeVisible();
            // The feedback resets before the next pick, so each copy is confirmed on its own.
            await expect(trigger).toBeVisible();
        }
    });

    test("restores expanded files, choices, filter and scroll when coming back from a file", async ({
        page,
    }) => {
        // A tall patch makes the list scroll, so a wrong height would move the restored offset.
        await fs.writeFile(
            path.join(repositoryPath, "src/server.ts"),
            Array.from(
                { length: 300 },
                (_, index) => `export const line${String(index)} = "edited";`,
            ).join("\n") + "\n",
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        const main = page.getByRole("main");

        const filter = page.getByRole("textbox", {
            name: "Filter files by name",
        });

        await filter.fill("server");
        await page
            .getByRole("button", { name: "Expand diff for src/server.ts" })
            .click();

        const server = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.ts")}`,
        });

        await server
            .getByRole("group", { name: "Diff layout for src/server.ts" })
            .getByRole("button", { name: "Separate lines" })
            .click();
        await server
            .getByRole("button", { name: "Wrap diff lines for src/server.ts" })
            .click();
        // The patch must be on screen before scrolling into it, or the offset would clamp.
        await expect(server).toContainText("line299");

        await main.evaluate((element) => {
            element.scrollTop = 1500;
        });

        // The sticky header keeps the file link on screen while its patch scrolls under it.
        const fileLink = server.getByRole("link", { name: "server.ts" });
        await fileLink.scrollIntoViewIfNeeded();
        const scrollTop = await main.evaluate((element) => element.scrollTop);

        // The offset must be inside the patch, so restoring it depends on the patch's height.
        expect(scrollTop).toBeGreaterThan(500);

        await fileLink.click();

        // Opening the file leaves the diff list, which unmounts it with all its state.
        await expect(page).not.toHaveURL(/\bview=git\b/);
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();

        await page.goBack();

        // The filter comes back, so the same files are listed.
        await expect(filter).toHaveValue("server");
        // The expanded file is expanded again and the collapsed one stays collapsed.
        await expect(
            page.getByRole("button", {
                name: "Collapse diff for src/server.ts",
            }),
        ).toHaveAttribute("aria-expanded", "true");
        await expect(
            page.getByRole("button", {
                name: "Expand diff for src/server.test.ts",
            }),
        ).toHaveAttribute("aria-expanded", "false");
        // The file's own layout and wrapping choices come back with it.
        await expect(
            server
                .getByRole("group", { name: "Diff layout for src/server.ts" })
                .getByRole("button", { name: "Separate lines" }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            server.getByRole("button", {
                name: "Wrap diff lines for src/server.ts",
            }),
        ).toHaveAttribute("aria-pressed", "true");
        // With the same list height the router puts the reader back at the same offset.
        await expect
            .poll(() => main.evaluate((element) => element.scrollTop))
            .toBe(scrollTop);
    });

    test("shows a file's new edits when coming back to its expanded diff", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`,
        );

        await page
            .getByRole("button", { name: "Expand diff for src/server.ts" })
            .click();

        const server = page.getByRole("region", {
            name: `Git diff for ${path.join(repositoryPath, "src/server.ts")}`,
        });

        await expect(server).toContainText("edited");

        await server.getByRole("link", { name: "server.ts" }).click();
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();

        // The file changes while the reader is away, like after saving it in the editor.
        await fs.writeFile(
            path.join(repositoryPath, "src/server.ts"),
            'export const mode = "rewritten";\n',
        );

        await page.goBack();

        // The cached patch is refetched on the way back instead of showing the old edit.
        await expect(server).toContainText("rewritten");
    });
});
