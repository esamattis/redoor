// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { MarkdownPreview, resolveMarkdownFileLink } from "./markdown-preview";

afterEach(() => {
    cleanup();
});

test("gives headings GitHub-style unique permalinks on every render", () => {
    const content = `# Hello, *World*!
## Hello, World!
### Hello, World!-1
#### Hello, World!
##### Café 中文
###### Use \`code\` & [links](https://example.com)
`;

    const view = render(
        <MarkdownPreview
            content={content}
            deviceName="agent"
            filePath="/repo/docs/README.md"
            repositoryRoot="/repo"
        />,
    );

    const expectedIds = [
        "hello-world",
        "hello-world-1",
        "hello-world-1-1",
        "hello-world-2",
        "café-中文",
        "use-code--links",
    ];

    // All six heading levels use rendered text and GitHub's collision handling.
    expect(view.getAllByRole("heading").map((heading) => heading.id)).toEqual(
        expectedIds,
    );
    // Permalinks expose each fragment without changing heading names or nesting links.
    expect(
        view
            .getAllByRole("link", { name: "Link to this heading" })
            .map((link) => link.getAttribute("href")),
    ).toEqual(expectedIds.map((id) => `#${id}`));
    expect(
        view.getByRole("heading", { name: "Hello, World!", level: 1 }),
    ).toBeTruthy();
    expect(view.getByRole("link", { name: "links" }).getAttribute("href")).toBe(
        "https://example.com",
    );

    view.rerender(
        <MarkdownPreview
            content={`${content}
Extra prose`}
            deviceName="agent"
            filePath="/repo/docs/README.md"
            repositoryRoot="/repo"
        />,
    );

    // Editing the document must reset the slugger rather than accumulate duplicate suffixes.
    expect(view.getAllByRole("heading").map((heading) => heading.id)).toEqual(
        expectedIds,
    );
});

test("highlights a labeled TypeScript fence", () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`\`\`\`typescript
const value = true;
\`\`\``}
        />,
    );

    const code = view.container.querySelector("pre code");

    // Highlighting must preserve the complete source for readers and copying.
    expect(code?.textContent).toContain("const value = true;");
    // A grammar token proves the editor's TypeScript grammar handled the fence.
    expect(code?.querySelector('[data-token="keyword"]')?.textContent).toBe(
        "const",
    );
});

test("copies a highlighted fence's source with its copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: true,
    });
    onTestFinished(() => {
        if (clipboard) {
            Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
            Reflect.deleteProperty(navigator, "clipboard");
        }

        if (secure) {
            Object.defineProperty(window, "isSecureContext", secure);
        } else {
            Reflect.deleteProperty(window, "isSecureContext");
        }
    });

    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`\`\`\`typescript
const value = true;
console.log(value);
\`\`\`

Use \`inline\` code.`}
        />,
    );

    // Only the fence gets a copy button; inline code has nothing worth a control.
    expect(view.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);

    fireEvent.click(view.getByRole("button", { name: "Copy code" }));

    // The copy holds the authored source joined from the highlight tokens, without the fence's trailing newline.
    await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(`const value = true;
console.log(value);`);
    });
    // The button confirms the copy so the user knows it worked.
    expect(view.getByRole("button", { name: "Copied!" })).toBeTruthy();
});

test("leaves inline code unhighlighted", () => {
    const view = render(
        <MarkdownPreview
            content="Use `const` inline."
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
        />,
    );

    const code = view.container.querySelector("code");

    // Inline snippets must retain normal Markdown code rendering without block tokens.
    expect(code?.textContent).toBe("const");
    expect(code?.querySelector("span")).toBeNull();
    expect(code?.querySelector("[data-token]")).toBeNull();
});

test("highlights a fence in a language the editor does not bundle once it loads", async () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`\`\`\`sql
SELECT name FROM users;
\`\`\``}
        />,
    );

    const code = view.container.querySelector("pre code");

    // The source is readable at once, before the lazily loaded grammar arrives.
    expect(code?.textContent).toContain("SELECT name FROM users;");

    // The SQL grammar loads on demand and then colours the same fence.
    await waitFor(() => {
        expect(code?.querySelector('[data-token="keyword"]')?.textContent).toBe(
            "SELECT",
        );
    });
});

test("leaves an unknown language fence readable", () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`\`\`\`unknown-language
some readable source
\`\`\``}
        />,
    );

    const code = view.container.querySelector("pre code");

    // Unsupported labels must fall back without hiding or rejecting their source.
    expect(code?.textContent).toContain("some readable source");
    expect(code?.querySelector("span")).toBeNull();
    expect(code?.querySelector("[data-token]")).toBeNull();
});

test("escapes HTML-like source in a recognized fence", () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`\`\`\`typescript
<img src=x onerror=alert(1)>
\`\`\``}
        />,
    );

    const code = view.container.querySelector("pre code");

    // Highlighted source remains readable without creating executable source elements.
    expect(code?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(code?.querySelector("img")).toBeNull();
});

test("resolves relative file links from the markdown directory", () => {
    const link = resolveMarkdownFileLink({
        href: "../source/file%20name.ts#L10",
        filePath: "/repo/docs/README.md",
        repositoryRoot: "/repo",
    });

    // Relative links follow the source document and retain useful URL fragments.
    expect(link).toEqual({
        path: "/repo/source/file name.ts",
        hash: "L10",
    });
});

test("resolves absolute markdown links from the repository root", () => {
    const link = resolveMarkdownFileLink({
        href: "/source/main.ts",
        filePath: "/repo/docs/README.md",
        repositoryRoot: "/repo",
    });

    // A leading slash follows Git hosting conventions while browsing a worktree.
    expect(link).toEqual({ path: "/repo/source/main.ts", hash: undefined });
});

test("renders nested YAML frontmatter with indentation preserved", () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`---
completions:
  - contextPath:
      - backends
    id: radiatordb
    type: block
---

# Body heading
`}
        />,
    );

    const table = view.getByRole("table", { name: "YAML frontmatter" });
    const valueCell = table.querySelector("td");

    // Nested mappings must keep YAML indent so list items stay distinct from their fields.
    expect(table.querySelector("th")?.textContent).toBe("completions");
    expect(valueCell?.textContent).toMatch(/- contextPath:/);
    expect(valueCell?.textContent).toMatch(/\n  id: radiatordb/);
    expect(valueCell?.textContent).toMatch(/\n  type: block/);
    // Document body stays markdown after the folded metadata block.
    expect(
        view.getByRole("heading", { name: "Body heading" }).textContent,
    ).toBe("Body heading");
});

test("collapses YAML frontmatter without hiding the document body", () => {
    const view = render(
        <MarkdownPreview
            deviceName="agent"
            filePath="/README.md"
            repositoryRoot={null}
            content={`---
title: Preview
---

Visible body
`}
        />,
    );

    const toggle = view.getByRole("button", { name: "YAML frontmatter" });

    // Frontmatter starts open so the metadata table is inspectable on first paint.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("table", { name: "YAML frontmatter" })).toBeTruthy();

    fireEvent.click(toggle);

    // Folding must drop only the table; the markdown body remains the primary content.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("table", { name: "YAML frontmatter" })).toBeNull();
    expect(view.getByText("Visible body")).toBeTruthy();
});

test("keeps absolute markdown links filesystem-rooted outside git", () => {
    const link = resolveMarkdownFileLink({
        href: "/etc/hosts",
        filePath: "/tmp/README.md",
        repositoryRoot: null,
    });

    // Outside a worktree there is no repository root to reinterpret the path against.
    expect(link).toEqual({ path: "/etc/hosts", hash: undefined });
});
