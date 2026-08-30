// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MarkdownPreview, resolveMarkdownFileLink } from "./markdown-preview";

afterEach(() => {
    cleanup();
});

test("highlights a labeled TypeScript fence", () => {
    const view = render(
        <MarkdownPreview
            agentId="agent"
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
    // A grammar token proves the configured TypeScript highlighter handled the fence.
    expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");
});

test("leaves inline code unhighlighted", () => {
    const view = render(
        <MarkdownPreview
            content="Use `const` inline."
            agentId="agent"
            filePath="/README.md"
            repositoryRoot={null}
        />,
    );
    const code = view.container.querySelector("code");

    // Inline snippets must retain normal Markdown code rendering without block tokens.
    expect(code?.textContent).toBe("const");
    expect(code?.querySelector("span")).toBeNull();
    expect(code?.classList.contains("hljs")).toBe(false);
});

test("leaves an unknown language fence readable", () => {
    const view = render(
        <MarkdownPreview
            agentId="agent"
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
    expect(code?.classList.contains("hljs")).toBe(false);
});

test("escapes HTML-like source in a recognized fence", () => {
    const view = render(
        <MarkdownPreview
            agentId="agent"
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
        agentId: "agent one",
        filePath: "/repo/docs/README.md",
        repositoryRoot: "/repo",
    });

    // Relative links follow the source document and retain useful URL fragments.
    expect(link).toBe(
        "/agents/agent%20one/browser/repo/source/file%20name.ts#L10",
    );
});

test("resolves absolute markdown links from the repository root", () => {
    const link = resolveMarkdownFileLink({
        href: "/source/main.ts",
        agentId: "agent",
        filePath: "/repo/docs/README.md",
        repositoryRoot: "/repo",
    });

    // A leading slash follows Git hosting conventions while browsing a worktree.
    expect(link).toBe("/agents/agent/browser/repo/source/main.ts");
});

test("keeps absolute markdown links filesystem-rooted outside git", () => {
    const link = resolveMarkdownFileLink({
        href: "/etc/hosts",
        agentId: "agent",
        filePath: "/tmp/README.md",
        repositoryRoot: null,
    });

    // Outside a worktree there is no repository root to reinterpret the path against.
    expect(link).toBe("/agents/agent/browser/etc/hosts");
});
