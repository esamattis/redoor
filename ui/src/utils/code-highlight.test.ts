import { expect, test } from "vitest";
import {
    highlightLines,
    languageForFileName,
    languageForName,
    type HighlightToken,
} from "#ui/utils/code-highlight";
import { loadHighlightLanguage } from "#ui/utils/use-code-highlight";

/** Highlights code with a bundled grammar, failing loudly when none is found. */
async function highlight(
    fileName: string,
    code: string,
): Promise<HighlightToken[][]> {
    const language = await loadHighlightLanguage(
        languageForFileName(fileName, code),
    );

    if (language === null) {
        throw new Error(`No bundled grammar for ${fileName}`);
    }

    return highlightLines(code, language);
}

/** The text of every token of a given kind, to assert what the grammar recognised. */
function tokensOfKind(lines: HighlightToken[][], kind: string): string[] {
    return lines
        .flat()
        .filter((token) => token.kind === kind)
        .map((token) => token.text);
}

test("splits highlighted code into lines that spell the source exactly", async () => {
    const code = `const a = 1;
/* spans
lines */ let b = "x";`;

    const lines = await highlight("app.ts", code);

    // Diff rows cut tokens by character offset, so the tokens must rebuild each line.
    expect(
        lines.map((tokens) => tokens.map((token) => token.text).join("")),
    ).toEqual(code.split("\n"));
    // Highlighting the block at once keeps the second line of the comment a comment.
    expect(tokensOfKind(lines, "comment")).toEqual(["/* spans", "lines */"]);
    expect(tokensOfKind(lines, "keyword")).toEqual(["const", "let"]);
});

test("highlights legacy stream modes such as shell and TOML", async () => {
    const shell = await highlight("deploy.sh", `echo "hi" # say hi`);
    const toml = await highlight("Cargo.toml", `name = "redoor" # crate`);

    // StreamLanguage grammars parse outside an editor, so their files keep colours too.
    expect(tokensOfKind(shell, "string")).toEqual(['"hi"']);
    expect(tokensOfKind(shell, "comment")).toEqual(["# say hi"]);
    expect(tokensOfKind(toml, "string")).toEqual(['"redoor"']);
    expect(tokensOfKind(toml, "comment")).toEqual(["# crate"]);
});

test("detects an extensionless script by its shebang", async () => {
    const lines = await highlight(
        "deploy",
        `#!/usr/bin/env python3
def main(): pass`,
    );

    // Scripts without an extension highlight like the editor shows them.
    expect(tokensOfKind(lines, "keyword")).toContain("def");
});

test("resolves fence labels to the editor's grammars or the language data", () => {
    // Short labels and full names both reach the grammar the editor uses.
    expect(languageForName("ts")).toBe(languageForFileName("a.ts", ""));
    expect(languageForName("bash")).toBe(languageForFileName("a.sh", ""));
    expect(languageForName("Python")).toBe(languageForFileName("a.py", ""));
    // Other known languages come from the language data instead.
    expect(languageForName("sql")?.name).toBe("SQL");
    // Unknown labels get no grammar, so the fence stays plain.
    expect(languageForName("unknown-language")).toBeNull();
});

test("parses JSX in .tsx and .jsx files but not in .ts files", async () => {
    const element = `const el = <h3 className="flex min-w-0">{name}</h3>;`;
    const tsx = await highlight("view.tsx", element);
    const jsx = await highlight("view.jsx", element);

    // Without JSX parsing the attribute's class list is read as code, splitting it
    // into identifiers, operators and numbers instead of colouring it as one string.
    expect(tokensOfKind(tsx, "string")).toEqual(['"flex min-w-0"']);
    expect(tokensOfKind(tsx, "tag")).toEqual(["h3", "h3"]);
    expect(tokensOfKind(jsx, "string")).toEqual(['"flex min-w-0"']);

    // Plain TypeScript must keep `<Type>value` as a type assertion, not an element.
    const ts = await highlight("cast.ts", `const n = <number>value;`);

    expect(tokensOfKind(ts, "type")).toEqual(["number"]);
    expect(tokensOfKind(ts, "tag")).toEqual([]);
});

test("resolves tsx and jsx fence labels to JSX-aware grammars", async () => {
    const element = `<a href="x">y</a>`;
    const tsx = await loadHighlightLanguage(languageForName("tsx"));

    if (tsx === null) {
        throw new Error("No grammar for tsx");
    }

    // Markdown fences labelled tsx highlight JSX the same way .tsx files do.
    expect(tokensOfKind(highlightLines(element, tsx), "tag")).toEqual([
        "a",
        "a",
    ]);
});
