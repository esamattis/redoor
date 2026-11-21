import { LanguageDescription } from "@codemirror/language";
import type { Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { loadSyntaxLanguage } from "#ui/utils/editor-language";
import type { HighlightLanguageSource } from "#ui/utils/use-code-highlight";
import {
    syntaxLanguageFromFileName,
    syntaxLanguageFromName,
} from "#ui/utils/syntax-language";
import type { SupportedSyntaxLanguage } from "#ui/utils/syntax-language";

/**
 * A run of highlighted text. Tokens are flat rather than a tree so a caller can cut them at
 * any character offset, which is what inline diff segments need.
 */
export interface HighlightToken {
    text: string;
    /** The CSS classes of the token, or null for plain text. */
    className: string | null;
    /**
     * The token's grammar kind, such as "keyword", exposed as `data-token` so tests and tools
     * can find tokens without depending on class names.
     */
    kind: string | null;
}

/**
 * Maps Lezer's highlight tags to `tok-*` classes. It groups tags the way the editor themes
 * (BBEdit light, Tokyo Night dark) colour them, so read-only code looks like the editor;
 * the built-in classHighlighter has no class for function names, which both themes colour.
 */
const tokenHighlighter = tagHighlighter([
    { tag: tags.keyword, class: "tok-keyword" },
    { tag: [tags.comment, tags.meta], class: "tok-comment" },
    { tag: [tags.documentMeta, tags.processingInstruction], class: "tok-meta" },
    {
        tag: [tags.string, tags.special(tags.string), tags.inserted],
        class: "tok-string",
    },
    { tag: [tags.number, tags.character], class: "tok-number" },
    {
        tag: [
            tags.changed,
            tags.annotation,
            tags.modifier,
            tags.self,
            tags.namespace,
        ],
        class: "tok-modifier",
    },
    {
        tag: [
            tags.atom,
            tags.bool,
            tags.null,
            tags.color,
            tags.constant(tags.name),
            tags.standard(tags.name),
            tags.special(tags.variableName),
        ],
        class: "tok-constant",
    },
    { tag: tags.variableName, class: "tok-variable" },
    {
        tag: [
            tags.function(tags.variableName),
            tags.function(tags.propertyName),
            tags.macroName,
        ],
        class: "tok-function",
    },
    { tag: [tags.propertyName, tags.labelName], class: "tok-property" },
    { tag: [tags.typeName, tags.className], class: "tok-type" },
    { tag: tags.tagName, class: "tok-tag" },
    {
        tag: [tags.escape, tags.regexp, tags.url, tags.link],
        class: "tok-escape",
    },
    { tag: tags.operator, class: "tok-operator" },
    { tag: tags.heading, class: "tok-heading" },
    { tag: tags.list, class: "tok-list" },
    { tag: tags.emphasis, class: "tok-emphasis" },
    { tag: tags.strong, class: "tok-strong" },
    { tag: tags.strikethrough, class: "tok-strikethrough" },
    { tag: [tags.invalid, tags.deleted], class: "tok-invalid" },
]);

/**
 * The editor's languages as descriptions, one per language, so they load on first use like
 * the language data's grammars and a description's identity stays stable across renders.
 */
const supportedLanguages = new Map<
    SupportedSyntaxLanguage,
    LanguageDescription
>();

/** The description of a language the editor supports, which loads the editor's grammar. */
function supportedLanguage(
    language: SupportedSyntaxLanguage,
): LanguageDescription {
    const cached = supportedLanguages.get(language);

    if (cached !== undefined) {
        return cached;
    }

    const description = LanguageDescription.of({
        name: language,
        load: () => loadSyntaxLanguage(language),
    });

    supportedLanguages.set(language, description);

    return description;
}

/**
 * Picks a grammar for a file the way the editor does. Files the editor does not know may
 * still match a lazily loaded grammar, which is fine for read-only code.
 */
export function languageForFileName(
    fileName: string,
    content: string,
): HighlightLanguageSource {
    const language = syntaxLanguageFromFileName(fileName, content);

    if (language !== undefined) {
        return supportedLanguage(language);
    }

    return LanguageDescription.matchFilename(languages, fileName);
}

/** Picks a grammar for a name such as a Markdown fence label (`ts`, `bash`, `sql`). */
export function languageForName(name: string): HighlightLanguageSource {
    const language = syntaxLanguageFromName(name);

    if (language !== undefined) {
        return supportedLanguage(language);
    }

    return LanguageDescription.matchLanguageName(languages, name, false);
}

/**
 * Highlights a block of source and returns the tokens of each line. Highlighting a block at
 * once, instead of every line alone, keeps multi-line strings and comments coloured right.
 */
export function highlightLines(
    code: string,
    language: Language,
): HighlightToken[][] {
    const lines: HighlightToken[][] = [[]];
    const tree = language.parser.parse(code);

    highlightCode(
        code,
        tree,
        tokenHighlighter,
        (text, classes) => {
            const kind = classes.split(" ").at(-1)?.replace(/^tok-/, "");

            lines.at(-1)?.push({
                text,
                className: classes === "" ? null : classes,
                kind: classes === "" || kind === undefined ? null : kind,
            });
        },
        () => {
            lines.push([]);
        },
    );

    return lines;
}
