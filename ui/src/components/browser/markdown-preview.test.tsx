// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

afterEach(() => {
    cleanup();
});

test("highlights a labeled TypeScript fence", () => {
    const view = render(
        <MarkdownPreview
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
    const view = render(<MarkdownPreview content="Use `const` inline." />);
    const code = view.container.querySelector("code");

    // Inline snippets must retain normal Markdown code rendering without block tokens.
    expect(code?.textContent).toBe("const");
    expect(code?.querySelector("span")).toBeNull();
    expect(code?.classList.contains("hljs")).toBe(false);
});

test("leaves an unknown language fence readable", () => {
    const view = render(
        <MarkdownPreview
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
