import { describe, expect, test } from "vitest";
import { highlightLines, languageForFileName } from "#ui/utils/code-highlight";
import type { HighlightToken } from "#ui/utils/code-highlight";
import { loadHighlightLanguage } from "#ui/utils/use-code-highlight";
import { syntaxLanguageFromFileName } from "#ui/utils/syntax-language";

/** Highlights RadConf the way read-only views do, failing loudly without a grammar. */
async function highlightRadconf(code: string): Promise<HighlightToken[][]> {
    const language = await loadHighlightLanguage(
        languageForFileName("radiator.radconf", code),
    );

    if (language === null) {
        throw new Error("No bundled grammar for RadConf");
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

describe("RadConf grammar", () => {
    test("is chosen for .radconf files", () => {
        // Radiator configuration files are recognised by their extension alone.
        expect(syntaxLanguageFromFileName("conf.d/backends.radconf")).toBe(
            "radconf",
        );
    });

    test("rebuilds every line exactly", async () => {
        const code = `servers {
    radius "RADIUS" { # comment
        port 1812;
    }
}
vars.text = """
    Welcome, "%{aaa.identity | default("x")}"
""";`;

        const lines = await highlightRadconf(code);

        // Diff rows cut tokens by offset, so the tokens must spell the source.
        expect(
            lines.map((tokens) => tokens.map((token) => token.text).join("")),
        ).toEqual(code.split("\n"));
    });

    test("tells statement names from accessors by position", async () => {
        const lines = await highlightRadconf(`# Radiator configuration
include "shared.radconf";
handler "AUTH" {
    @execute {
        backend "USERS";
        count.add "custom::attempts";
        vars.realm = radius.request.attr.User-Name;
        vars.attempts gt 5;
        counter = 1;
        pap;
    }
    bindings { aaa.identity; }
    remove { radius.reply.attr..254; }
}`);

        // Comments are recognised before anything else on the line.
        expect(tokensOfKind(lines, "comment")).toEqual([
            "# Radiator configuration",
        ]);
        // The first word of a statement names it, including pipelines and dotted actions.
        expect(tokensOfKind(lines, "keyword")).toEqual([
            "include",
            "handler",
            "@execute",
            "backend",
            "count.add",
            "pap",
            "bindings",
            "remove",
        ]);
        // An accessor followed by an operator or the statement end is a value, not a name,
        // even without a dot (`counter = 1`),
        // and dashes and numeric components stay part of one accessor.
        expect(tokensOfKind(lines, "variable")).toEqual([
            "vars.realm",
            "radius.request.attr.User-Name",
            "vars.attempts",
            "counter",
            "aaa.identity",
            "radius.reply.attr..254",
        ]);
        // Comparison words are operators between operands.
        expect(tokensOfKind(lines, "operator")).toEqual(["=", "gt", "="]);
    });

    test("highlights control flow and its conditions", async () => {
        const lines = await highlightRadconf(`if any {
    map["display name"] starts "A";
} then {
    try backend "X" when accept { pap; }
} else if all {
    vars.realm == none;
} else {
    must pap;
}
match vars.realm {
    any => { ignore; }
}`);

        // Reserved words are control keywords wherever they stand, including `when` after
        // a statement's arguments; `map` before `[` is an accessor instead.
        expect(
            tokensOfKind(lines, "keyword").filter((word) =>
                ["if", "then", "try", "when", "else", "must", "match"].includes(
                    word,
                ),
            ),
        ).toEqual([
            "if",
            "then",
            "try",
            "when",
            "else",
            "if",
            "else",
            "must",
            "match",
        ]);
        expect(tokensOfKind(lines, "variable")).toContain("map");
        // `try` and `must` prefix another statement, whose name is a keyword again.
        expect(tokensOfKind(lines, "keyword")).toEqual(
            expect.arrayContaining(["backend", "pap"]),
        );
        // Policies, `when` conditions and special values are constants, also as match cases.
        expect(tokensOfKind(lines, "constant")).toEqual([
            "any",
            "accept",
            "all",
            "none",
            "any",
        ]);
    });

    test("highlights strings, escapes and placeholders", async () => {
        const lines = await highlightRadconf(
            `reject "Hi %{aaa.identity | default("x")} \\x01 \\q";`,
        );

        // Placeholder delimiters stand out from the string text around them.
        expect(tokensOfKind(lines, "constant")).toEqual(["%{", "}"]);
        // The placeholder holds an expression with an accessor and a filter call.
        expect(tokensOfKind(lines, "variable")).toEqual(["aaa.identity"]);
        expect(tokensOfKind(lines, "function")).toEqual(["default"]);
        // Only `\\"`, `\\\\` and `\\xHH` are valid escapes in a plain string.
        expect(tokensOfKind(lines, "escape")).toEqual(["\\x01"]);
        expect(tokensOfKind(lines, "invalid")).toEqual(["\\q"]);
    });

    test("highlights number-like literals and regexes", async () => {
        const lines = await highlightRadconf(`ip 0.0.0.0;
ip ::;
vars.list = [5s, 1m30s, 80MiB, 2.5%, 1/5, 5XX, 10..20, ..5, 60.., -1.5..-0.5];
vars.net = [10.0.0.0/8, 127.0.0.1:1812, 2001:db8::/32, [2001:db8::1]:1812];
vars.name == /^host\\//i;`);

        // Durations, sizes, ratios, ranges and addresses are all single number tokens.
        expect(tokensOfKind(lines, "number")).toEqual([
            "0.0.0.0",
            "::",
            "5s",
            "1m30s",
            "80MiB",
            "2.5%",
            "1/5",
            "5XX",
            "10..20",
            "..5",
            "60..",
            "-1.5..-0.5",
            "10.0.0.0/8",
            "127.0.0.1:1812",
            "2001:db8::/32",
            "[2001:db8::1]:1812",
        ]);
        // A regex keeps its escaped slash and flags; it shares the escape colour.
        expect(tokensOfKind(lines, "escape")).toEqual(["/^host\\//i"]);
    });

    test("highlights filters and named arguments", async () => {
        const lines = await highlightRadconf(
            `vars.hash = vars.password | trim | password_hash("argon2", memory=19456, time = 2);`,
        );

        // The word after `|` names a filter.
        expect(tokensOfKind(lines, "function")).toEqual([
            "trim",
            "password_hash",
        ]);
        // `name=` inside a call is a named argument, not an assignment target.
        expect(tokensOfKind(lines, "property")).toEqual(["memory", "time"]);
    });

    test("leaves a license key body opaque", async () => {
        const lines = await highlightRadconf(`license {
    key "inline" {
opaque if "text
    }
}
pap;`);

        // The key body is raw text, so words in it are neither keywords nor strings' quotes.
        expect(tokensOfKind(lines, "string")).toEqual([
            '"inline"',
            'opaque if "text',
            "    ",
        ]);
        // RadConf resumes after the closing brace.
        expect(tokensOfKind(lines, "keyword")).toEqual([
            "license",
            "key",
            "pap",
        ]);
    });
});
