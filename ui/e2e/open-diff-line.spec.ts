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

/** Tall enough that a middle-line jump must scroll and virtualize the ends. */
const TARGET_LINE = 250;

const TARGET_TEXT = `middle line ${String(TARGET_LINE)}`;

test.describe("Open diff line", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        if (testDirPath === "") {
            return;
        }

        await teardownTestDir(testDirPath);
        testDirPath = "";
    });

    test("opens the editor centered on a selected line from a git diff", async ({
        page,
    }) => {
        const ctx = await setupTestDir("open-diff-line");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const filePath = path.join(repositoryPath, "tall.txt");
        await fs.mkdir(repositoryPath);
        await fs.writeFile(path.join(repositoryPath, "README"), "baseline\n");

        const lines = [
            "FIRST_VISIBLE_LINE",
            ...Array.from(
                { length: 498 },
                (_, index) => `middle line ${String(index + 2)}`,
            ),
            "LAST_BUFFER_LINE",
        ];

        await fs.writeFile(filePath, `${lines.join("\n")}\n`);
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add README`;
        await $`git -C ${repositoryPath} commit -m baseline`;

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );
        const diff = page.getByRole("region", { name: "Full Git diff" });
        await expect(diff).toContainText(TARGET_TEXT);
        // The open actions follow the hovered line instead of sitting on every row.
        await diff
            .locator(`tr[data-line-new="${String(TARGET_LINE)}"]`)
            .hover();
        await diff
            .getByRole("link", {
                name: `Open line ${String(TARGET_LINE)} in editor`,
            })
            .click();

        // The Open link must leave Git so the inbound editor jump can run.
        await expect(page).toHaveURL(
            new RegExp(`[?&]line=${String(TARGET_LINE)}(?:&|$)`),
        );
        await expect(page).not.toHaveURL(/\bview=git\b/);

        const editor = page.getByLabel("File editor", { exact: true });
        const targetLine = editor.getByText(TARGET_TEXT, { exact: true });
        await expect(targetLine).toBeVisible();
        await expect(page.getByLabel("Editor caret line")).toHaveText(
            String(TARGET_LINE),
        );
        // Selecting the opened line makes the diff target obvious after navigation.
        await expect(page.getByLabel("Editor selected text")).toHaveText(
            TARGET_TEXT,
        );
        // Distant ends stay virtualized because the jump centered a middle line.
        await expect(editor.getByText("FIRST_VISIBLE_LINE")).toHaveCount(0);
        await expect(editor.getByText("LAST_BUFFER_LINE")).toHaveCount(0);

        const viewport = page.getByRole("region", { name: "Editor viewport" });
        const viewportBox = await viewport.boundingBox();
        const lineBox = await targetLine.boundingBox();
        expect(viewportBox).not.toBeNull();
        expect(lineBox).not.toBeNull();

        if (viewportBox === null || lineBox === null) {
            return;
        }

        const viewportCenter = viewportBox.y + viewportBox.height / 2;
        const lineCenter = lineBox.y + lineBox.height / 2;
        // nearest-only jumps can leave the target at the edge; center keeps it in view.
        expect(Math.abs(lineCenter - viewportCenter)).toBeLessThan(
            viewportBox.height / 4,
        );

        const pageScroll = await page.getByRole("main").evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));

        // Vertical scrolling must stay in CodeMirror after the inbound jump.
        expect(pageScroll.scrollHeight).toBeLessThanOrEqual(
            pageScroll.clientHeight + 1,
        );
    });

    test("picks a line with the arrow keys and opens it from the line toolbar", async ({
        page,
    }) => {
        const ctx = await setupTestDir("open-diff-line-keyboard");
        testDirPath = ctx.testDirPath;
        const repositoryPath = path.join(ctx.testDirPath, "repository");
        const filePath = path.join(repositoryPath, "notes.txt");
        await fs.mkdir(repositoryPath);

        const lines = Array.from(
            { length: 40 },
            (_, index) => `line ${String(index + 1)}`,
        );

        await fs.writeFile(filePath, `${lines.join("\n")}\n`);
        await $`git -C ${repositoryPath} init`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add notes.txt`;
        await $`git -C ${repositoryPath} commit -m baseline`;
        // One edit in the middle leaves folds with expand buttons above and below it.
        lines[19] = "changed line 20";
        await fs.writeFile(filePath, `${lines.join("\n")}\n`);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );

        const diff = page.getByRole("region", { name: "Full Git diff" });
        await expect(diff).toContainText("changed line 20");
        // The fold buttons sit inside the lines, ahead of the toolbar in the tab order.
        await expect(
            diff.getByRole("button", { name: "Expand all" }).first(),
        ).toBeVisible();

        const diffLines = diff.getByRole("group", { name: /^Diff lines/ });
        await diffLines.focus();
        // Keyboard focus picks the first line on screen, so the toolbar is reachable at once.
        await expect(
            diff.getByRole("toolbar", { name: "Line 17 actions" }),
        ).toBeVisible();

        await page.keyboard.press("ArrowDown");
        // Each arrow press moves the toolbar to the next line that can be opened.
        await expect(
            diff.getByRole("toolbar", { name: "Line 18 actions" }),
        ).toBeVisible();

        await page.keyboard.press("Tab");
        // Tab skips the fold buttons and lands on the picked line's open link.
        await expect(
            diff.getByRole("link", { name: "Open line 18 in editor" }),
        ).toBeFocused();

        await page.keyboard.press("Escape");
        // Escape hides the toolbar even from inside it and gives focus back to the lines.
        await expect(diff.getByRole("toolbar")).toHaveCount(0);
        await expect(diffLines).toBeFocused();

        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Tab");
        // With nothing picked, an arrow press starts again from the first line on screen.
        await expect(
            diff.getByRole("link", { name: "Open line 17 in editor" }),
        ).toBeFocused();

        await page.keyboard.press("Enter");
        // The link opens the editor at the picked line.
        await expect(page).toHaveURL(/[?&]line=17(?:&|$)/);
        await expect(page.getByLabel("Editor caret line")).toHaveText("17");
    });
});
