import type { StreamParser, StringStream } from "@codemirror/language";

/**
 * The unit types systemd loads from files. A file with one of these suffixes is a unit, and
 * a `*.conf` inside a `<name>.<suffix>.d` directory is a drop-in that overrides one.
 */
const SYSTEMD_UNIT_SUFFIXES = new Set([
    "service",
    "socket",
    "timer",
    "path",
    "mount",
    "automount",
    "target",
    "slice",
    "swap",
    "scope",
]);

/**
 * Recognises a unit or drop-in from its full path, because a drop-in's own name is a plain
 * `override.conf` and only its parent directory tells it apart from other `.conf` files.
 * Expects a lowercased path whose last segment has already had any vault suffix removed.
 */
export function isSystemdUnitPath(lowerBaseName: string, lowerPath: string) {
    const extension = lowerBaseName.split(".").pop() ?? "";

    if (
        lowerBaseName.lastIndexOf(".") > 0 &&
        SYSTEMD_UNIT_SUFFIXES.has(extension)
    ) {
        return true;
    }

    if (!lowerBaseName.endsWith(".conf")) {
        return false;
    }

    const parent = lowerPath.split("/").at(-2) ?? "";
    const match = /^.+\.([a-z]+)\.d$/.exec(parent);

    return match?.[1] !== undefined && SYSTEMD_UNIT_SUFFIXES.has(match[1]);
}

/** Where on a line the tokenizer is, since a key, its value and a section look alike. */
type SystemdState = {
    /** After `Key=`, everything up to the end of the logical line is the value. */
    inValue: boolean;
    /** The value's first token, where `Exec*=` prefixes and whole-value booleans live. */
    atValueStart: boolean;
    /** The directive name, so `Exec*=` values can recognise their command prefixes. */
    key: string;
    /** The line ended in `\`, so the next physical line still belongs to this value. */
    continues: boolean;
    /** The open quote character, kept across continuation lines of one value. */
    quote: string | null;
};

/** Directives whose value is a command line that may start with `-@+!:` prefixes. */
const EXEC_KEY = /^exec/i;

/**
 * Values made entirely of one of these words are booleans; matching only whole values keeps
 * an argument such as `echo yes` in a command line plain.
 */
const BOOLEAN_VALUE = /^(?:yes|no|true|false|on|off)\s*$/i;

/**
 * Plain numbers and systemd time spans or sizes (`5s`, `1min`, `100ms`, `512M`, `80%`).
 * The lookahead keeps a number glued to a word, such as `nginx-1.2`, plain.
 */
const NUMBER =
    /^\d+(?:\.\d+)?(?:us|usec|ms|msec|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|weeks?|months?|y|years?|[kmgtpe]|%)?(?=$|[\s,;"'\\])/i;

/**
 * Starts a physical line. Only a trailing `\` carries the value over, so any other line
 * starts fresh even if the previous one left a quote open.
 */
function startLine(state: SystemdState) {
    if (state.continues) {
        state.continues = false;

        return;
    }

    state.inValue = false;
    state.atValueStart = false;
    state.key = "";
    state.quote = null;
}

/** Whether the stream is at the first non-blank character of its line. */
function atLineStart(stream: StringStream) {
    return stream.string.slice(0, stream.pos).trim() === "";
}

/** Tokenizes the part of a line before `=`: comments, `[Section]` and the directive name. */
function tokenBeforeValue(stream: StringStream, state: SystemdState) {
    if (stream.eatSpace()) {
        return null;
    }

    if (atLineStart(stream)) {
        const first = stream.peek();

        if (first === "#" || first === ";") {
            stream.skipToEnd();

            return "comment";
        }

        if (first === "[") {
            stream.match(/^\[[^\]]*\]?/);

            return "heading";
        }

        const key = stream.match(/^[A-Za-z0-9][\w.-]*(?=\s*=)/);

        if (Array.isArray(key)) {
            state.key = key[0];

            return "keyword";
        }
    }

    if (stream.eat("=")) {
        state.inValue = true;
        state.atValueStart = true;

        return "operator";
    }

    stream.skipToEnd();

    return null;
}

/**
 * Tokenizes the expansions systemd performs inside a value. Shared by quoted and unquoted
 * text so `"%n"` and `${VAR}` stand out inside strings too.
 */
function tokenExpansion(stream: StringStream, state: SystemdState) {
    if (stream.match(/^\\$/)) {
        state.continues = true;

        return "operator";
    }

    if (stream.match(/^\\(?:x[0-9a-fA-F]{2}|[0-7]{3}|.)/)) {
        return "escape";
    }

    if (stream.match(/^%[A-Za-z%]/)) {
        return "escape";
    }

    if (stream.match(/^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)/)) {
        return "variableName.special";
    }

    return undefined;
}

/** Tokenizes a value, including the continuation lines that belong to it. */
function tokenValue(stream: StringStream, state: SystemdState) {
    // systemd ignores comment lines interleaved with continuation lines.
    if (
        !state.atValueStart &&
        state.quote === null &&
        atLineStart(stream) &&
        stream.match(/^\s*[#;].*/)
    ) {
        state.continues = true;

        return "comment";
    }

    if (stream.eatSpace()) {
        return null;
    }

    if (state.atValueStart) {
        state.atValueStart = false;

        if (EXEC_KEY.test(state.key) && stream.match(/^[-@+!:]+/)) {
            return "modifier";
        }

        if (stream.match(BOOLEAN_VALUE)) {
            return "bool";
        }
    }

    const expansion = tokenExpansion(stream, state);

    if (expansion !== undefined) {
        return expansion;
    }

    if (state.quote !== null) {
        if (stream.eat(state.quote)) {
            state.quote = null;

            return "string";
        }

        const quote = state.quote;

        // A lone `%`, `$` or `\` that expands to nothing is still part of the string.
        if (
            !stream.eatWhile((char) => !"%$\\".includes(char) && char !== quote)
        ) {
            stream.next();
        }

        return "string";
    }

    const next = stream.peek();

    if (next === '"' || next === "'") {
        stream.next();
        state.quote = next;

        return "string";
    }

    const previous = stream.string.charAt(stream.pos - 1);

    if (/^$|[\s=]/.test(previous) && stream.match(NUMBER)) {
        return "number";
    }

    stream.next();
    stream.eatWhile(/[^%$\\"'\s]/);

    return null;
}

/**
 * A small grammar for systemd unit files. The generic `properties` mode gets sections and
 * comments right but misses what makes units readable: specifiers, variable references,
 * `Exec*=` prefixes and `\` continuations whose next line is still the value.
 */
export const systemd: StreamParser<SystemdState> = {
    name: "systemd",
    startState: () => ({
        inValue: false,
        atValueStart: false,
        key: "",
        continues: false,
        quote: null,
    }),
    copyState: (state) => ({ ...state }),
    token(stream, state) {
        if (stream.sol()) {
            startLine(state);
        }

        return state.inValue
            ? tokenValue(stream, state)
            : tokenBeforeValue(stream, state);
    },
    // A blank line cannot end in `\`, so it always ends the value it follows.
    blankLine(state) {
        state.continues = false;
        state.inValue = false;
        state.quote = null;
    },
    languageData: {
        commentTokens: { line: "#" },
    },
};
