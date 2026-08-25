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
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(filePath)}?view=git`,
        );
        const diff = page.getByRole("region", { name: "Full Git diff" });
        await expect(diff).toContainText(TARGET_TEXT);
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

        const editor = page.getByLabel("File editor");
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
});
