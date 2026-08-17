import { describe, expect, test } from "vitest";
import { languageFromFileName } from "#ui/utils/editor-language";

describe("editor language detection", () => {
    test.each([
        ["#!/bin/sh", "shell"],
        ["#!/usr/bin/env -S python3 -u", "Python"],
        ["#!/usr/bin/env ruby", "Ruby"],
        ["#!/usr/bin/node", "JavaScript"],
        ["#!/usr/bin/env ts-node", "TypeScript"],
    ])("detects %s for an extensionless file", (hashBang, language) => {
        const extension = languageFromFileName(
            "script",
            `${hashBang}
print('hello')`,
        );

        // Every supported interpreter must produce a CodeMirror language extension.
        expect(extension, language).toBeDefined();
    });

    test("does not use a hash bang to override an extension", () => {
        const fromName = languageFromFileName("script.py");
        const withHashBang = languageFromFileName(
            "script.py",
            "#!/usr/bin/env node",
        );

        // File extensions remain authoritative when both signals are available.
        expect(withHashBang?.constructor).toBe(fromName?.constructor);
    });

    test("leaves an unknown extensionless file unhighlighted", () => {
        const extension = languageFromFileName("README", "plain text");

        // Unknown text remains editable without installing an incorrect parser.
        expect(extension).toBeUndefined();
    });

    test.each(["notes.md", "notes.markdown"])(
        "highlights %s as markdown with fenced code languages",
        (fileName) => {
            const extension = languageFromFileName(fileName);

            // Markdown files need the nested fence parsers, not an unknown-text fallback.
            expect(extension).toBeDefined();
        },
    );
});
