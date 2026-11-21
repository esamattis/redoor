import { expect, test } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    encodeFilesystemPath,
    ignoreServerEvents,
    setupTestDir,
    simulateTabRefocus,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";
import type { TestContext } from "./helpers";

test.describe.serial("Markdown preview", () => {
    let ctx: TestContext;
    let markdownPath: string;
    let markdownUrl: string;
    let markdownDirectoryUrl: string;
    let repositoryPath: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("markdown-preview");
        repositoryPath = path.join(ctx.testDirPath, "repository");
        const markdownDirectory = path.join(repositoryPath, "docs");
        await fs.mkdir(markdownDirectory, { recursive: true });
        await $`git -C ${repositoryPath} init`;
        markdownPath = path.join(markdownDirectory, "README.md");
        markdownUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(markdownPath)}`;
        markdownDirectoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(markdownDirectory)}`;
        await fs.writeFile(
            path.join(repositoryPath, "root-target.txt"),
            "Repository root target",
        );
        await fs.writeFile(
            path.join(repositoryPath, "relative-target.txt"),
            "Relative target",
        );
        await fs.writeFile(
            markdownPath,
            `# Preview heading

Preview body

[Root target](/root-target.txt)
[Relative target](../relative-target.txt)
[Section target](#getting-started)

## Getting *started*!

${"```typescript"}
const highlighted = true;
${"```"}
`,
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("opens markdown from the listing in preview", async ({ page }) => {
        await page.goto(markdownDirectoryUrl);
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
        const code = preview.locator("pre code");
        // The real preview must preserve the fenced source while rendering highlighted structure.
        await expect(code).toContainText("const highlighted = true;");
        await expect(code.locator("span").first()).toBeVisible();
        // The pre surface must show through instead of boxing each highlighted line like inline code.
        await expect(code).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        // The compact toolbar control remains identifiable without repeating a text label.
        await expect(
            page.getByRole("button", { name: "Preview", exact: true }),
        ).toHaveText("");
        // The preview pane itself owns the editor exit so it stays on the rendered page.
        await expect(
            page.getByRole("button", { name: "Close preview" }),
        ).toBeVisible();
        // CodeMirror remains mounted while CSS keeps it out of the visible preview.
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeAttached();
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).not.toBeVisible();
    });

    test("does not steal browser find while the editor is hidden", async ({
        page,
    }) => {
        await page.goto(markdownUrl);
        const preview = page.getByRole("region", { name: "Markdown preview" });
        await expect(
            preview.getByRole("heading", { name: "Preview heading" }),
        ).toBeVisible();

        await preview.click();
        await page.keyboard.press("ControlOrMeta+f");
        // Hidden CodeMirror must stay mounted without intercepting native page find.
        await expect(page.getByLabel("Find in file")).toHaveCount(0);
    });

    test("routes file links relative to the document and git root", async ({
        page,
    }) => {
        await page.goto(markdownUrl);
        const preview = page.getByRole("region", { name: "Markdown preview" });

        await preview.getByRole("link", { name: "Root target" }).click();
        // Leading slashes use the repository root rather than the remote filesystem root.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(repositoryPath, "root-target.txt"))}`,
        );

        await page.goto(markdownUrl);
        await preview.getByRole("link", { name: "Relative target" }).click();
        // Relative links continue to use the Markdown document's own directory.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(repositoryPath, "relative-target.txt"))}`,
        );
    });

    test("opens and reloads heading permalinks", async ({ page }) => {
        await page.goto(markdownUrl);
        const preview = page.getByRole("region", { name: "Markdown preview" });

        const heading = preview.getByRole("heading", {
            name: "Getting started!",
        });

        // Authored fragments and generated permalinks must agree on GitHub-style IDs.
        await expect(heading).toHaveAttribute("id", "getting-started");
        await heading
            .getByRole("link", { name: "Link to this heading" })
            .click();
        await expect(page).toHaveURL(
            `${markdownUrl}?preview=true#getting-started`,
        );
        await page.reload();
        // A shared permalink must still identify the heading after a fresh navigation.
        await expect(heading).toHaveAttribute("id", "getting-started");
        await page.goto(markdownUrl);
        await preview.getByRole("link", { name: "Section target" }).click();
        await expect(page).toHaveURL(
            `${markdownUrl}?preview=true#getting-started`,
        );
    });

    test("keeps the scroll position of a hash link across refocus and Back", async ({
        page,
    }) => {
        // Refreshes broadcast by parallel specs would otherwise stand in for the refocus below.
        await ignoreServerEvents(page);
        const longPath = path.join(repositoryPath, "long.md");

        const filler = Array.from(
            { length: 60 },
            (_, index) => `Filler paragraph ${index}`,
        ).join(`

`);

        await fs.writeFile(
            longPath,
            `# Long document

${filler}

## Linked section

${filler}

## Last section

[Root target](/root-target.txt)
`,
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(longPath)}?preview=true#linked-section`,
        );
        const preview = page.getByRole("region", { name: "Markdown preview" });
        const linked = preview.getByRole("heading", { name: "Linked section" });
        const last = preview.getByRole("heading", { name: "Last section" });
        // The fragment must still scroll its heading into view on the first load.
        await expect(linked).toBeInViewport();

        await preview.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(last).toBeInViewport();
        await expect(linked).not.toBeInViewport();

        // A paragraph added on disk proves the refocus refresh has rendered the document again.
        await fs.appendFile(
            longPath,
            `
Refreshed paragraph
`,
        );
        await simulateTabRefocus(page);
        await expect(preview.getByText("Refreshed paragraph")).toBeVisible();
        // The reload must not jump back to the fragment the user has already scrolled past.
        await expect(last).toBeInViewport();
        await expect(linked).not.toBeInViewport();

        const leftAt = await preview.evaluate((element) => element.scrollTop);
        await preview.getByRole("link", { name: "Root target" }).click();
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(path.join(repositoryPath, "root-target.txt"))}`,
        );
        await page.goBack();
        await expect(page).toHaveURL(/#linked-section$/);
        // Back must return exactly to where the reader left the document, not to its fragment.
        await expect
            .poll(() => preview.evaluate((element) => element.scrollTop))
            .toBe(leftAt);
    });

    test("shows a table of contents beside or over the document", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(markdownUrl);
        const preview = page.getByRole("region", { name: "Markdown preview" });
        const toc = page.getByRole("navigation", { name: "Table of contents" });
        const toggle = page.getByRole("button", { name: "Table of contents" });

        // A wide preview keeps the contents in view as a column without any toggle.
        await expect(toc).toBeVisible();
        await expect(toggle).toBeHidden();
        await toc.getByRole("link", { name: "Getting started!" }).click();
        // Entries are fragment links, so jumping to a section is shareable like a permalink.
        await expect(page).toHaveURL(
            `${markdownUrl}?preview=true#getting-started`,
        );

        await page.setViewportSize({ width: 390, height: 700 });
        await page.goto(markdownUrl);

        // Phones need the whole width for the document, so the contents wait behind a toggle.
        await expect(toc).toBeHidden();
        await toggle.click();
        await expect(toc).toBeVisible();
        await toc.getByRole("link", { name: "Getting started!" }).click();
        // Choosing a section hands the screen back to the document at that heading.
        await expect(toc).toBeHidden();
        await expect(
            preview.getByRole("heading", { name: "Getting started!" }),
        ).toBeInViewport();

        await toggle.click();
        await page.keyboard.press("Escape");
        // Escape dismisses only the drawer; the preview itself stays open.
        await expect(toc).toBeHidden();
        await expect(preview).toBeVisible();
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
        const editor = page.getByLabel("File editor", { exact: true });
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

        await page.getByRole("button", { name: "Close preview" }).click();

        // The same mounted CodeMirror retains both draft contents and caret state.
        await expect(editor).toContainText("# Draft heading");
        await expect(editor).toContainText("Draft body");
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");
    });

    test("keeps non-markdown files in the editor", async ({ page }) => {
        const textPath = path.join(ctx.testDirPath, "plain.txt");
        await fs.writeFile(textPath, "Plain text");
        const textUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(textPath)}`;

        await page.goto(textUrl);

        // Other editable formats retain the existing canonical URL and controls.
        await expect(page).toHaveURL(textUrl);
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Preview", exact: true }),
        ).toHaveCount(0);
    });

    test("shows full-width collapsible YAML frontmatter", async ({ page }) => {
        const frontmatterPath = path.join(repositoryPath, "docs", "backend.md");
        await fs.writeFile(
            frontmatterPath,
            `---
completions:
  - contextPath:
      - backends
    id: radiatordb
    type: block
    title: RadiatorDB document backend
---

# Backend docs
`,
        );
        const frontmatterUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(frontmatterPath)}`;
        await page.goto(frontmatterUrl);
        const preview = page.getByRole("region", { name: "Markdown preview" });

        const frontmatter = preview.getByRole("region", {
            name: "YAML frontmatter",
        });

        const table = frontmatter.getByRole("table", {
            name: "YAML frontmatter",
        });

        // Like GitHub, top-level keys label the rows of the table.
        await expect(table.getByRole("rowheader")).toHaveText("completions");
        // Nested mappings become their own tables with the keys as column headers, so the
        // value is shown as data rather than a flattened markdown list or raw YAML.
        await expect(
            table.getByRole("columnheader", { name: "id", exact: true }),
        ).toBeVisible();
        await expect(
            table.getByRole("cell", { name: "radiatordb", exact: true }),
        ).toBeVisible();
        await expect(
            preview.getByRole("heading", { name: "Backend docs" }),
        ).toBeVisible();

        const bodyBox = await preview
            .getByRole("heading", { name: "Backend docs" })
            .boundingBox();

        const frontmatterBox = await frontmatter.boundingBox();
        // The metadata block should span the document column instead of shrinking to the key
        // name. It only ends short of the corner buttons, so it is compared to the body's width.
        expect(bodyBox).not.toBeNull();
        expect(frontmatterBox).not.toBeNull();
        expect(frontmatterBox?.width ?? 0).toBeGreaterThan(
            (bodyBox?.width ?? 0) * 0.8,
        );

        await page.getByRole("button", { name: "YAML frontmatter" }).click();
        // Collapse is for getting the metadata out of the way of the document body.
        await expect(table).toHaveCount(0);
        await expect(
            preview.getByRole("heading", { name: "Backend docs" }),
        ).toBeVisible();
    });

    test("keeps markdown line bookmarks in the editor", async ({ page }) => {
        await page.goto(`${markdownUrl}?line=3`);

        // A line target takes precedence over the default preview so its caret jump remains useful.
        await expect(page).toHaveURL(`${markdownUrl}?line=3`);
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel("Editor caret line")).toHaveText("3");
        await expect(
            page.getByRole("region", { name: "Markdown preview" }),
        ).not.toBeVisible();
    });
});
