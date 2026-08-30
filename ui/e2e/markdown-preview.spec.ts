import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Markdown preview", () => {
    let ctx: TestContext;
    let markdownPath: string;
    let markdownUrl: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("markdown-preview");
        markdownPath = path.join(ctx.testDirPath, "README.md");
        markdownUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(markdownPath)}`;
        await fs.writeFile(
            markdownPath,
            `# Preview heading

Preview body
`,
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("opens markdown from the listing in preview", async ({ page }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("link", { name: "README.md", exact: true })
            .click();

        // The canonical query makes the initial representation reload-safe and shareable.
        await expect(page).toHaveURL(`${markdownUrl}?preview=true`);
        const preview = page.getByRole("region", { name: "Markdown preview" });
        // Rendered semantics prove the source is displayed as markdown rather than plain text.
        await expect(
            preview.getByRole("heading", { name: "Preview heading" }),
        ).toBeVisible();
        await expect(preview).toContainText("Preview body");
        // The compact toolbar control remains identifiable without repeating a text label.
        await expect(
            page.getByRole("button", { name: "Preview", exact: true }),
        ).toHaveText("");
        // A separate trailing action gives the rendered card an obvious editor exit.
        await expect(
            page.getByRole("button", { name: "Close markdown preview" }),
        ).toBeVisible();
        // CodeMirror remains mounted while CSS keeps it out of the visible preview.
        await expect(page.getByLabel("File editor")).toBeAttached();
        await expect(page.getByLabel("File editor")).not.toBeVisible();
    });

    test("toggles without losing the editor draft or caret", async ({
        page,
    }) => {
        await page.goto(markdownUrl);
        const toggle = page.getByRole("button", {
            name: "Preview",
            exact: true,
        });
        await toggle.click();

        // False is explicit so reloading an intentional editor view does not reopen preview.
        await expect(page).toHaveURL(`${markdownUrl}?preview=false`);
        const editor = page.getByLabel("File editor");
        await expect(editor).toBeVisible();
        await editor.fill(`# Draft heading

Draft body`);
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");

        await toggle.click();

        await expect(page).toHaveURL(`${markdownUrl}?preview=true`);
        // Preview consumes the live draft instead of refetching the saved file.
        await expect(
            page
                .getByRole("region", { name: "Markdown preview" })
                .getByRole("heading", { name: "Draft heading" }),
        ).toBeVisible();
        await expect(
            page
                .getByRole("region", { name: "Markdown preview" })
                .getByText("Draft body", { exact: true }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "Close markdown preview" })
            .click();

        // The same mounted CodeMirror retains both draft contents and caret state.
        await expect(editor).toContainText("# Draft heading");
        await expect(editor).toContainText("Draft body");
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");
    });

    test("keeps non-markdown files in the editor", async ({ page }) => {
        const textPath = path.join(ctx.testDirPath, "plain.txt");
        await fs.writeFile(textPath, "Plain text");
        const textUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${encodeFilesystemPath(textPath)}`;

        await page.goto(textUrl);

        // Other editable formats retain the existing canonical URL and controls.
        await expect(page).toHaveURL(textUrl);
        await expect(page.getByLabel("File editor")).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Preview", exact: true }),
        ).toHaveCount(0);
    });

    test("keeps markdown line bookmarks in the editor", async ({ page }) => {
        await page.goto(`${markdownUrl}?line=3`);

        // A line target takes precedence over the default preview so its caret jump remains useful.
        await expect(page).toHaveURL(`${markdownUrl}?line=3`);
        await expect(page.getByLabel("File editor")).toBeVisible();
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");
        await expect(
            page.getByRole("region", { name: "Markdown preview" }),
        ).not.toBeVisible();
    });
});
