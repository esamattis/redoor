import { stripVaultSuffix } from "#ui/vault/vault-path";
import { isSystemdUnitPath } from "#ui/utils/systemd-language";

export type SupportedSyntaxLanguage =
    | "cpp"
    | "csharp"
    | "css"
    | "go"
    | "html"
    | "java"
    | "javascript"
    | "jinja"
    | "json"
    | "jsx"
    | "lua"
    | "markdown"
    | "perl"
    | "properties"
    | "python"
    | "radconf"
    | "ruby"
    | "rust"
    | "shell"
    | "systemd"
    | "toml"
    | "tsx"
    | "typescript"
    | "xml"
    | "yaml";

/**
 * Dotfiles that should highlight as shell even when they have no `.sh` extension.
 * Agents usually report these as text/plain, so filename is the only reliable signal.
 * Variants such as `.env.local` match the `.env.*` prefix check instead.
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
]);

/** Full language names that are not also file extensions, for labels such as fences. */
const SYNTAX_LANGUAGE_NAMES = new Map<string, SupportedSyntaxLanguage>([
    ["csharp", "csharp"],
    ["golang", "go"],
    ["javascript", "javascript"],
    ["jinja2", "jinja"],
    ["perl", "perl"],
    ["properties", "properties"],
    ["python", "python"],
    ["ruby", "ruby"],
    ["rust", "rust"],
    ["shell", "shell"],
    ["systemd", "systemd"],
    ["typescript", "typescript"],
]);

/**
 * Identifies a supported language from a label such as a Markdown fence (`ts`, `bash`,
 * `python`). Labels are usually a name or an extension, so both are tried.
 */
export function syntaxLanguageFromName(
    name: string,
): SupportedSyntaxLanguage | undefined {
    const lowerName = name.toLowerCase();

    return (
        SYNTAX_LANGUAGE_NAMES.get(lowerName) ??
        syntaxLanguageFromFileName(`file.${lowerName}`)
    );
}

/**
 * Identifies syntax once so editors and rendered diffs support the same files. Pass the full
 * path when it is known: systemd drop-ins are only recognisable by their parent directory.
 */
export function syntaxLanguageFromFileName(
    fileName: string,
    content = "",
): SupportedSyntaxLanguage | undefined {
    // An encrypted `secrets.env.redoorencrypted` highlights as the file it holds.
    const baseName = stripVaultSuffix(fileName.split("/").pop() ?? fileName);
    const lowerName = baseName.toLowerCase();

    if (SHELL_BASENAMES.has(lowerName) || lowerName.startsWith(".env.")) {
        return "shell";
    }

    if (lowerName === "gemfile" || lowerName === "rakefile") {
        return "ruby";
    }

    if (lowerName === ".editorconfig") {
        return "properties";
    }

    // Checked before the extension switch, which would take a drop-in `.conf` as properties.
    if (isSystemdUnitPath(lowerName, fileName.toLowerCase())) {
        return "systemd";
    }

    const lastDot = lowerName.lastIndexOf(".");

    if (lastDot <= 0) {
        return languageFromHashBang(content);
    }

    switch (lowerName.slice(lastDot + 1)) {
        case "rs":
            return "rust";
        case "js":
        case "mjs":
        case "cjs":
            return "javascript";
        case "jsx":
            return "jsx";
        case "ts":
        case "mts":
        case "cts":
            return "typescript";
        case "tsx":
            return "tsx";
        case "go":
            return "go";
        case "html":
        case "htm":
            return "html";
        case "yml":
        case "yaml":
            return "yaml";
        case "toml":
            return "toml";
        case "j2":
        case "jinja":
        case "jinja2":
            return "jinja";
        case "json":
            return "json";
        case "jsonc":
        case "json5":
            // Strict JSON highlighting rejects comments and JSON5 syntax.
            return "javascript";
        case "lua":
            return "lua";
        case "xml":
        case "xsl":
        case "xsd":
        case "svg":
        case "plist":
            return "xml";
        case "css":
            return "css";
        case "md":
        case "markdown":
            return "markdown";
        case "java":
            return "java";
        case "sh":
        case "bash":
        case "zsh":
        case "ksh":
            return "shell";
        case "py":
        case "pyi":
            return "python";
        case "rb":
        case "rake":
            return "ruby";
        case "pl":
        case "pm":
        case "t":
            return "perl";
        case "ini":
        case "cfg":
        case "conf":
            return "properties";
        case "radconf":
            return "radconf";
        case "c":
        case "h":
        case "cpp":
        case "cc":
        case "cxx":
        case "hpp":
        case "hh":
        case "hxx":
            return "cpp";
        case "cs":
            return "csharp";
        default:
            return undefined;
    }
}

/** Uses an extensionless script's interpreter as the syntax-highlighting fallback. */
function languageFromHashBang(
    content: string,
): SupportedSyntaxLanguage | undefined {
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
        return "shell";
    }

    if (interpreter.startsWith("python")) {
        return "python";
    }

    if (interpreter === "ruby") {
        return "ruby";
    }

    if (interpreter === "perl") {
        return "perl";
    }

    if (interpreter === "lua") {
        return "lua";
    }

    if (["ts-node", "tsx"].includes(interpreter)) {
        return "typescript";
    }

    if (["node", "nodejs", "deno", "bun"].includes(interpreter)) {
        return "javascript";
    }

    return undefined;
}
