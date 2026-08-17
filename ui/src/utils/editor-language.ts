import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";

/**
 * Dotfiles that should highlight as shell even when they have no `.sh` extension.
 * Agents usually report these as text/plain, so filename is the only reliable signal.
 */
const SHELL_BASENAMES = new Set([
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_aliases",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".profile",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.example",
]);

/**
 * Chooses a CodeMirror language from basename + extension, not MIME.
 * Unknown names stay unhighlighted so every editable file remains writable.
 */
export function languageFromFileName(
    fileName: string,
    content = "",
): Extension | undefined {
    const baseName = fileName.split("/").pop() ?? fileName;
    const lowerName = baseName.toLowerCase();

    if (SHELL_BASENAMES.has(lowerName) || lowerName.startsWith(".env.")) {
        return StreamLanguage.define(shell);
    }

    if (lowerName === "gemfile" || lowerName === "rakefile") {
        return StreamLanguage.define(ruby);
    }

    if (lowerName === ".editorconfig") {
        return StreamLanguage.define(properties);
    }

    const lastDot = lowerName.lastIndexOf(".");
    if (lastDot <= 0) {
        return languageFromHashBang(content);
    }

    switch (lowerName.slice(lastDot + 1)) {
        case "rs":
            return rust();
        case "js":
        case "mjs":
        case "cjs":
        case "jsx":
            return javascript();
        case "ts":
        case "mts":
        case "cts":
        case "tsx":
            return javascript({ typescript: true });
        case "go":
            return go();
        case "html":
        case "htm":
            return html();
        case "yml":
        case "yaml":
            return yaml();
        case "toml":
            return StreamLanguage.define(toml);
        case "json":
            return json();
        case "jsonc":
        case "json5":
            // Strict JSON highlighting rejects comments and JSON5 syntax.
            return javascript();
        case "lua":
            return StreamLanguage.define(lua);
        case "xml":
        case "xsl":
        case "xsd":
        case "svg":
        case "plist":
            return xml();
        case "css":
            return css();
        case "md":
        case "markdown":
            // Nested parsers highlight fenced blocks from the language tag.
            return markdown({
                base: markdownLanguage,
                codeLanguages: languages,
            });
        case "java":
            return java();
        case "sh":
        case "bash":
        case "zsh":
        case "ksh":
            return StreamLanguage.define(shell);
        case "py":
        case "pyi":
            return python();
        case "rb":
        case "rake":
            return StreamLanguage.define(ruby);
        case "pl":
        case "pm":
        case "t":
            return StreamLanguage.define(perl);
        case "ini":
        case "cfg":
        case "conf":
            return StreamLanguage.define(properties);
        case "c":
        case "h":
        case "cpp":
        case "cc":
        case "cxx":
        case "hpp":
        case "hh":
        case "hxx":
        case "cs":
            return cpp();
        default:
            return undefined;
    }
}

/** Uses an extensionless script's interpreter as the syntax-highlighting fallback. */
function languageFromHashBang(content: string): Extension | undefined {
    const firstLineEnd = content.indexOf("\n");
    const firstLine = content.slice(
        0,
        firstLineEnd === -1 ? content.length : firstLineEnd,
    );
    const match = /^#!\s*(.+)$/.exec(firstLine);
    if (match === null) {
        return undefined;
    }

    const command = match[1];
    if (command === undefined) {
        return undefined;
    }
    const parts = command.trim().split(/\s+/);
    let interpreter = parts[0]?.split("/").pop()?.toLowerCase();
    if (interpreter === "env") {
        interpreter = parts
            .slice(1)
            .find((part) => !part.startsWith("-") && !part.includes("="))
            ?.split("/")
            .pop()
            ?.toLowerCase();
    }

    if (interpreter === undefined) {
        return undefined;
    }
    if (["sh", "bash", "zsh", "ksh", "dash", "ash"].includes(interpreter)) {
        return StreamLanguage.define(shell);
    }
    if (interpreter.startsWith("python")) {
        return python();
    }
    if (interpreter === "ruby") {
        return StreamLanguage.define(ruby);
    }
    if (interpreter === "perl") {
        return StreamLanguage.define(perl);
    }
    if (interpreter === "lua") {
        return StreamLanguage.define(lua);
    }
    if (["ts-node", "tsx"].includes(interpreter)) {
        return javascript({ typescript: true });
    }
    if (["node", "nodejs", "deno", "bun"].includes(interpreter)) {
        return javascript();
    }
    return undefined;
}
