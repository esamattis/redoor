import { LanguageSupport } from "@codemirror/language";
import { expect, test } from "vitest";
import { loadSyntaxLanguage } from "#ui/utils/editor-language";
import type { SupportedSyntaxLanguage } from "#ui/utils/syntax-language";

/**
 * Every supported language, so a grammar chunk that fails to build is caught. A record keyed
 * by the language makes the compiler point out a language added without a test.
 */
const LANGUAGES: Record<SupportedSyntaxLanguage, SupportedSyntaxLanguage> = {
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    javascript: "javascript",
    jinja: "jinja",
    json: "json",
    jsx: "jsx",
    lua: "lua",
    markdown: "markdown",
    perl: "perl",
    properties: "properties",
    python: "python",
    radconf: "radconf",
    ruby: "ruby",
    rust: "rust",
    shell: "shell",
    systemd: "systemd",
    toml: "toml",
    tsx: "tsx",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
};

test.each(Object.values(LANGUAGES))(
    "loads the %s grammar",
    async (language) => {
        // Each grammar is imported on demand, so every one must resolve to an editor extension.
        expect(await loadSyntaxLanguage(language)).toBeInstanceOf(
            LanguageSupport,
        );
    },
);

test("loads a grammar once for every caller", async () => {
    // The editor and read-only highlighting share one grammar instead of building two.
    expect(loadSyntaxLanguage("rust")).toBe(loadSyntaxLanguage("rust"));
});
