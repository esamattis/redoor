import { describe, expect, test } from "vitest";
import { highlightLines, languageForFileName } from "#ui/utils/code-highlight";
import type { HighlightToken } from "#ui/utils/code-highlight";
import { loadHighlightLanguage } from "#ui/utils/use-code-highlight";

/** Highlights a unit file the way read-only views do, failing loudly without a grammar. */
async function highlightUnit(code: string): Promise<HighlightToken[][]> {
    const language = await loadHighlightLanguage(
        languageForFileName("app.service", code),
    );

    if (language === null) {
        throw new Error("No bundled grammar for systemd units");
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

describe("systemd grammar", () => {
    test("rebuilds every line exactly", async () => {
        const code = `[Service]
ExecStart=-/usr/bin/app --name "%n" \\
    --env $HOME
Environment="A=1"`;

        const lines = await highlightUnit(code);

        // Diff rows cut tokens by offset, so the tokens must spell the source.
        expect(
            lines.map((tokens) => tokens.map((token) => token.text).join("")),
        ).toEqual(code.split("\n"));
    });

    test("highlights sections, directives and comments", async () => {
        const lines = await highlightUnit(`# A comment
; Another comment
[Unit]
Description=My app
After = network.target`);

        // Both comment characters systemd accepts start a comment line.
        expect(tokensOfKind(lines, "comment")).toEqual([
            "# A comment",
            "; Another comment",
        ]);
        // Section headers structure the file, so they render as headings.
        expect(tokensOfKind(lines, "heading")).toEqual(["[Unit]"]);
        // Directive names are the fixed vocabulary of the format, like keywords.
        expect(tokensOfKind(lines, "keyword")).toEqual([
            "Description",
            "After",
        ]);
        // A value is not a directive, even when it looks like a word.
        expect(tokensOfKind(lines, "keyword")).not.toContain("My");
    });

    test("keeps a continued line a value", async () => {
        const lines = await highlightUnit(`[Service]
ExecStart=/usr/bin/app \\
    Restart=always \\
# interleaved comment
    %i
Restart=always`);

        // The trailing backslash marks the continuation.
        expect(tokensOfKind(lines, "operator")).toContain("\\");
        // `Restart=` inside a continuation is an argument, so only the last line is a directive.
        expect(tokensOfKind(lines, "keyword")).toEqual([
            "ExecStart",
            "Restart",
        ]);
        // systemd skips comment lines between continuation lines without ending the value.
        expect(tokensOfKind(lines, "comment")).toEqual([
            "# interleaved comment",
        ]);
        // The value still continues after the comment, so its specifier is recognised.
        expect(tokensOfKind(lines, "escape")).toEqual(["%i"]);
    });

    test("highlights specifiers and variable references", async () => {
        const lines = await highlightUnit(
            `ExecStart=/usr/bin/app %n "%i-%%" \${HOME} $USER $`,
        );

        // Specifiers expand inside and outside quotes, and `%%` is a literal percent.
        expect(tokensOfKind(lines, "escape")).toEqual(["%n", "%i", "%%"]);
        // Both variable syntaxes systemd expands in command lines are recognised.
        expect(tokensOfKind(lines, "constant")).toEqual(["${HOME}", "$USER"]);
        // The quoted text around the specifiers is still a string.
        expect(tokensOfKind(lines, "string")).toEqual(['"', "-", '"']);
    });

    test("highlights command prefixes only at the start of Exec values", async () => {
        const lines = await highlightUnit(`ExecStartPre=-+/usr/bin/prepare -v
ExecStart=@/usr/bin/app app
Description=-not a prefix`);

        // Prefixes change how systemd runs a command, so they stand out from the path.
        expect(tokensOfKind(lines, "modifier")).toEqual(["-+", "@"]);
    });

    test("highlights booleans and time spans", async () => {
        const lines = await highlightUnit(`RemainAfterExit=yes
PrivateTmp=false
ExecStart=/bin/echo yes
RestartSec=5s
TimeoutStopSec=1min 30s
MemoryMax=512M
Description=nginx-1.2`);

        // Only whole-value booleans count, so a command argument stays plain.
        expect(tokensOfKind(lines, "constant")).toEqual(["yes", "false"]);
        // Numbers with units are time spans or sizes; numbers glued to words are not.
        expect(tokensOfKind(lines, "number")).toEqual([
            "5s",
            "1min",
            "30s",
            "512M",
        ]);
    });
});
