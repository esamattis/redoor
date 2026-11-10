import { test, expect } from "./fixtures";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    openEditorContextMenu,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe("Editor copy reference", () => {
    let ctx: TestContext;

    // The test directory may itself sit inside a checkout, so the file that must be outside any
    // repository lives in the system temp directory instead.
    const outsidePath = path.join(
        os.tmpdir(),
        `redoor-copy-reference-outside-${process.pid}`,
    );

    test.beforeAll(async () => {
        ctx = await setupTestDir("copy-reference");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(outsidePath, { force: true, recursive: true });
    });

    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
    });

    test("should copy whole selected lines, or the cursor line, with a file and line reference", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "copy-reference.txt");
        await fs.writeFile(
            filePath,
            `alpha
beta
gamma`,
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );

        const editor = page.getByLabel("File editor", { exact: true });

        // CodeMirror renders line breaks between sibling elements, so DOM text is concatenated.
        await expect(editor).toHaveText("alphabetagamma");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Shift+ArrowDown");

        let menu = await openEditorContextMenu(page, editor);

        let copyReferenceButton = menu.getByRole("button", {
            name: "Copy reference",
            exact: true,
        });

        await copyReferenceButton.hover();
        // The tooltip explains both the copied syntax and why it is useful with AI agents.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Copy as an /absolute/path#Lline code block for AI prompts",
        );
        await copyReferenceButton.click();

        // A selection starting and ending mid-line still copies both lines in full, since the
        // reference names whole lines.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L2
beta
gamma
\`\`\``);
        // Non-modal feedback confirms the asynchronous browser clipboard write completed.
        await expect(page.getByRole("status")).toHaveText("Copied reference");

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowRight");
        menu = await openEditorContextMenu(page, editor);
        copyReferenceButton = menu.getByRole("button", {
            name: "Copy reference",
            exact: true,
        });

        // Without a selection the action still works, on the cursor's line.
        await expect(copyReferenceButton).toBeEnabled();
        await copyReferenceButton.click();

        // Only the line holding the cursor is copied when nothing is selected.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`${filePath}#L1
alpha
\`\`\``);
    });

    test("should copy a repository-relative reference only for files in a repository", async ({
        page,
    }) => {
        const repositoryPath = path.join(ctx.testDirPath, "repo-reference");
        const filePath = path.join(repositoryPath, "src", "lib.txt");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "first");
        await $`git -C ${repositoryPath} init --initial-branch=main`;

        await fs.mkdir(outsidePath, { recursive: true });
        const outsideFilePath = path.join(outsidePath, "plain.txt");
        await fs.writeFile(outsideFilePath, "plain");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        let editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("first");

        let menu = await openEditorContextMenu(page, editor);

        const repoReferenceButton = menu.getByRole("button", {
            name: "Copy repo reference",
            exact: true,
        });

        await repoReferenceButton.hover();
        // The tooltip tells the repository form apart from the absolute one.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Copy as a repo/relative/path#Lline code block for AI prompts",
        );
        await repoReferenceButton.click();

        // The path is relative to the repository root, so agents working in the checkout
        // resolve it.
        await expect.poll(() =>
            page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(`\`\`\`src/lib.txt#L1
first
\`\`\``);
        // The toast names the repository form so the user knows which one was copied.
        await expect(page.getByRole("status")).toHaveText(
            "Copied repo reference",
        );

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(outsideFilePath)}`,
        );
        editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("plain");
        menu = await openEditorContextMenu(page, editor);

        // The absolute reference stays available outside a repository.
        await expect(
            menu.getByRole("button", { name: "Copy reference", exact: true }),
        ).toBeVisible();
        // Outside a repository there is no relative path to copy, so the item is hidden.
        await expect(
            menu.getByRole("button", {
                name: "Copy repo reference",
                exact: true,
            }),
        ).toHaveCount(0);
    });
});
