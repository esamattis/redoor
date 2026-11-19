/** A mapping keeps its mode explicit so plain map never captures insert-mode typing. */
type VimMapping = {
    lhs: string;
    rhs: string;
    contexts: string[];
    recursive: boolean;
};

/** Line numbers let users repair unsupported Vimscript without losing their saved source. */
export type VimConfigError = { line: number; message: string };

/** Vim notation is case insensitive, while the adapter's Escape dispatch is not. */
function normalizeKeys(keys: string): string {
    return keys.replace(/<([^>]+)>/g, (token, name: string) => {
        const canonical = [
            "Esc",
            "Space",
            "CR",
            "Tab",
            "BS",
            "Del",
            "Ins",
            "Up",
            "Down",
            "Left",
            "Right",
            "Home",
            "End",
            "PageUp",
            "PageDown",
        ].find((key) => key.toLowerCase() === name.toLowerCase());

        return canonical === undefined ? token : `<${canonical}>`;
    });
}

/** Parses only key mappings, because executing arbitrary Ex commands could edit a file. */
export function parseVimConfig(source: string) {
    const mappings: VimMapping[] = [];
    const errors: VimConfigError[] = [];

    for (const [index, raw] of source.split(/\r?\n/).entries()) {
        const line = raw.trim();

        if (line === "" || line.startsWith('"')) {
            continue;
        }

        const match =
            /^(map|nmap|vmap|imap|noremap|nnoremap|vnoremap|inoremap)\s+(\S+)\s+(\S+)$/.exec(
                line,
            );

        if (match === null) {
            errors.push({
                line: index + 1,
                message:
                    "Expected a supported mapping command followed by two keys or key sequences.",
            });
            continue;
        }

        const [, command, lhs, rhs] = match;

        if (command === undefined || lhs === undefined || rhs === undefined) {
            continue;
        }

        // Mapping options and Ex aliases are outside this small, predictable subset.
        if (
            lhs.startsWith(":") ||
            /^<(buffer|silent|expr|script|unique|nowait)>$/i.test(lhs)
        ) {
            errors.push({
                line: index + 1,
                message:
                    "Mapping options and Ex command aliases are not supported.",
            });
            continue;
        }

        const contexts = command.startsWith("i")
            ? ["insert"]
            : command.startsWith("v")
              ? ["visual"]
              : command === "nmap" || command === "nnoremap"
                ? ["normal"]
                : ["normal", "visual", "operatorPending"];

        mappings.push({
            lhs: normalizeKeys(lhs),
            rhs: normalizeKeys(rhs),
            contexts,
            recursive: !command.includes("noremap"),
        });
    }

    return { mappings, errors };
}
