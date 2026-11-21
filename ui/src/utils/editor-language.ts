import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { Language } from "@codemirror/language";
import { systemd } from "#ui/utils/systemd-language";
import type { SupportedSyntaxLanguage } from "#ui/utils/syntax-language";

/** One load per language, shared by the editor and read-only highlighting. */
const loads = new Map<SupportedSyntaxLanguage, Promise<LanguageSupport>>();

/**
 * Loads the CodeMirror grammar of a supported language. The grammars are a large part of
 * CodeMirror, so each one is its own chunk that is only fetched once a file in that language
 * is shown. The editor and read-only highlighting both use it, so code is parsed the same way
 * wherever it is shown.
 */
export function loadSyntaxLanguage(
    language: SupportedSyntaxLanguage,
): Promise<LanguageSupport> {
    const existing = loads.get(language);

    if (existing !== undefined) {
        return existing;
    }

    const load = importSyntaxLanguage(language).then((support) =>
        support instanceof LanguageSupport
            ? support
            : new LanguageSupport(support),
    );

    // A failed chunk load is forgotten, so showing the file again retries it.
    load.catch(() => {
        if (loads.get(language) === load) {
            loads.delete(language);
        }
    });

    loads.set(language, load);

    return load;
}

/** Imports the chunk of one grammar and builds it with the options the language needs. */
async function importSyntaxLanguage(
    language: SupportedSyntaxLanguage,
): Promise<LanguageSupport | Language> {
    switch (language) {
        case "rust":
            return (await import("@codemirror/lang-rust")).rust();
        case "javascript":
            return (await import("@codemirror/lang-javascript")).javascript();
        case "jsx":
            return (await import("@codemirror/lang-javascript")).javascript({
                jsx: true,
            });
        case "typescript":
            return (await import("@codemirror/lang-javascript")).javascript({
                typescript: true,
            });
        case "tsx":
            // JSX stays off for plain TypeScript, where `<Type>value` is a type assertion.
            return (await import("@codemirror/lang-javascript")).javascript({
                typescript: true,
                jsx: true,
            });
        case "go":
            return (await import("@codemirror/lang-go")).go();
        case "jinja":
            return (await import("@codemirror/lang-jinja")).jinja();
        case "html":
            return (await import("@codemirror/lang-html")).html();
        case "yaml":
            return (await import("@codemirror/lang-yaml")).yaml();
        case "toml":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/toml")).toml,
            );
        case "json":
            return (await import("@codemirror/lang-json")).json();
        case "lua":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/lua")).lua,
            );
        case "xml":
            return (await import("@codemirror/lang-xml")).xml();
        case "css":
            return (await import("@codemirror/lang-css")).css();
        case "markdown": {
            const [{ markdown, markdownLanguage }, { languages }] =
                await Promise.all([
                    import("@codemirror/lang-markdown"),
                    import("@codemirror/language-data"),
                ]);

            // Fenced code loads its own grammar through the language data on demand.
            return markdown({
                base: markdownLanguage,
                codeLanguages: languages,
            });
        }

        case "java":
            return (await import("@codemirror/lang-java")).java();
        case "shell":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/shell")).shell,
            );
        case "python":
            return (await import("@codemirror/lang-python")).python();
        case "ruby":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/ruby")).ruby,
            );
        case "perl":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/perl")).perl,
            );
        case "properties":
            return StreamLanguage.define(
                (await import("@codemirror/legacy-modes/mode/properties"))
                    .properties,
            );
        case "systemd":
            // Static, because the file name detection already needs this module.
            return StreamLanguage.define(systemd);
        case "radconf":
            return StreamLanguage.define(
                (await import("#ui/utils/radconf-language")).radconf,
            );
        case "cpp":
        case "csharp":
            return (await import("@codemirror/lang-cpp")).cpp();
    }
}
