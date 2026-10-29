// Serial: opening files in the background writes the shared user settings' open files list.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { $ } from "zx";

import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

/** Far enough down that showing it needs the editor to scroll. */
const TARGET_LINE = 250;

test.describe.serial("Open in background", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("open-in-background");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async () => {
        await resetOpenFiles();
    });

    test.afterEach(async () => {
        await resetOpenFiles();
    });

    /** Starts every test without open files, which other specs may have left behind. */
    async function resetOpenFiles() {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                openFiles: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
                deviceOrder: [],
            },
        });
    }

    /** The sidebar list of open files, which the background buttons add to. */
    function openFilesList(page: Page) {
        return page
            .getByRole("navigation", { name: "Application" })
            .getByRole("list", { name: "Open files" });
    }

    test("opens a file from a diff without leaving it and shows the chosen line on the first visit", async ({
        page,
    }) => {
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const fileName = "tall.txt";
        const filePath = path.join(repositoryPath, fileName);
        await fs.mkdir(repositoryPath);

        const lines = Array.from(
            { length: 500 },
            (_, index) => `line ${String(index + 1)}`,
        );

        await fs.writeFile(filePath, `${lines.join("\n")}\n`);
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add ${fileName}`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        lines[TARGET_LINE - 1] = "changed target line";
        await fs.writeFile(filePath, `${lines.join("\n")}\n`);

        const diffUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(repositoryPath)}?view=git`;
        await page.goto(diffUrl);

        const section = page.getByRole("region", {
            name: `Git diff for ${filePath}`,
        });

        // A collapsed diff still offers the header button, since opening needs no patch.
        await section
            .getByRole("button", {
                name: `Open ${fileName} in the background`,
                exact: true,
            })
            .click();
        // The file joins the open files list while the diff stays on screen.
        await expect(
            openFilesList(page).getByRole("link", {
                name: fileName,
                exact: true,
            }),
        ).toBeVisible();
        await expect(page).toHaveURL(diffUrl);
        // The header button now says the file is open instead of offering to open it.
        await expect(
            section.getByRole("button", {
                name: `${fileName} is open`,
                exact: true,
            }),
        ).toBeVisible();

        await section
            .getByRole("button", { name: `Expand diff for ${fileName}` })
            .click();
        await expect(section).toContainText("changed target line");

        const rowButton = section.getByRole("button", {
            name: `Show line ${String(TARGET_LINE)} when ${fileName} is visited`,
            exact: true,
        });

        // Row buttons of an open file offer to move it to their line rather than open it.
        await expect(rowButton).toBeVisible();
        await rowButton.click();

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // The line request is stored with the open file, so it survives a reload or another computer.
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                openFiles: [{ path: filePath, reveal: { line: TARGET_LINE } }],
            });

        // The list shows the chosen line right away, confirming the click before any visit.
        await expect(
            openFilesList(page).getByLabel(
                `Caret line ${String(TARGET_LINE)}`,
                { exact: true },
            ),
        ).toBeVisible();

        await openFilesList(page)
            .getByRole("link", { name: fileName, exact: true })
            .click();

        const editor = page.getByLabel("File editor", { exact: true });
        // The first visit selects the line chosen in the diff.
        await expect(page.getByLabel("Editor caret line")).toHaveText(
            String(TARGET_LINE),
        );
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            "changed target line",
        );
        // The editor scrolled to the line instead of leaving it below the viewport.
        await expect(
            editor.getByText("changed target line", { exact: true }),
        ).toBeInViewport();

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await expect(page.getByLabel("Editor caret line")).toHaveText("1");
        // The list follows the caret once its buffer is written, so it shows where the file was left.
        await expect(
            openFilesList(page).getByLabel("Caret line 1", { exact: true }),
        ).toBeVisible();
        await page.goto(diffUrl);
        await expect(section).toBeVisible();
        await openFilesList(page)
            .getByRole("link", { name: fileName, exact: true })
            .click();
        // The request was applied once, so a later visit keeps the user's own place.
        await expect(page.getByLabel("Editor caret line")).toHaveText("1");
    });

    test("opens a content search result at its line while the search stays open", async ({
        page,
    }) => {
        const fileName = "search-background.txt";
        const filePath = path.join(ctx.testDirPath, fileName);

        await fs.writeFile(
            filePath,
            `first line
second line
background-search-needle
fourth line
`,
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}?q=background-search-needle&mode=content`,
        );

        const results = page.getByLabel("Search results");

        const openButton = results.getByRole("button", {
            name: `Open ${fileName} at line 3 in the background`,
            exact: true,
        });

        await openButton.click();
        // The button shows that the file is open now, without closing the search.
        await expect(
            results.getByRole("button", {
                name: `Show line 3 when ${fileName} is visited`,
                exact: true,
            }),
        ).toBeVisible();
        await expect(page).toHaveURL(/q=background-search-needle/);

        await page.getByRole("button", { name: "Close search" }).click();
        await openFilesList(page)
            .getByRole("link", { name: fileName, exact: true })
            .click();
        // Visiting the file selects the matched line.
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            "background-search-needle",
        );
    });
});
