import type { StreamParser, StringStream } from "@codemirror/language";

/**
 * What the tokenizer is inside. Strings and `%{…}` placeholders nest (a placeholder holds
 * filter arguments that are strings again), so they need a stack rather than one flag.
 */
type RadconfContext = "string" | "triple" | "placeholder";

/** Where in the RadConf syntax the tokenizer is, since the same word means different things by position. */
type RadconfState = {
    /** Open strings and placeholders, innermost last. */
    stack: RadconfContext[];
    /** The first word of every open `{` block, so `license { key { … } }` bodies can be told apart. */
    blocks: string[];
    /** The first word of the current statement, recorded when its block opens. */
    head: string;
    /** The next word starts a statement, where names are keywords rather than values. */
    atStart: boolean;
    /** The last token was a value, so a word such as `contains` is an operator. */
    afterOperand: boolean;
    /** The last token was `|`, so the next word names a filter. */
    afterPipe: boolean;
    /** Open `(` and `[`, inside which no statement starts and `name=` is a named argument. */
    nesting: number;
    /** Inside a license `key` block, whose body is opaque text up to the next `}`. */
    opaque: boolean;
};

/**
 * Words the grammar reserves for control flow. They are keywords wherever they stand, which
 * is what lets `when` after a statement's arguments start a result handler.
 */
const CONTROL_WORDS = new Set([
    "must",
    "try",
    "catch",
    "if",
    "then",
    "else",
    "until",
    "when",
    "with",
    "do",
    "sometimes",
    "map",
    "match",
]);

/** Control words that prefix another statement, so the word after them is a name again. */
const PREFIX_WORDS = new Set(["must", "try", "else"]);

/** Conditions of `when`/`until` and policies of `if`/`conditions`, which read as constants. */
const ATOM_WORDS = new Set([
    "accept",
    "reject",
    "ignore",
    "error",
    "end",
    "all",
    "any",
    "first",
    "while",
    "each",
    "now",
]);

/** Boolean literals including the aliases RadConf accepts. */
const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no", "on", "off"]);

/** Comparison words that are operators between two operands. */
const WORD_OPERATOR = /^!?(?:starts|contains|ends)$|^(?:eq|ne|gt|ge|lt|le)$/;

/**
 * Names, accessors and dotted actions as one token, so `radius.request.attr.User-Name`,
 * `attr..254` and the tagged `Tunnel-Type:1` stay whole even though they contain `-`, `.`
 * and `:`. Index brackets are left to the bracket tokenizer because they can nest.
 */
const WORD =
    /^[@!]?[A-Za-z_$][\w$-]*(?:::[\w$-]+)*(?:\.\.\d+|\.[\w$-]+(?:::[\w$-]+)*)*(?::\d+)?/;

/** Durations such as `1m30s`, byte sizes and plain numbers that ranges and percentages build on. */
const SCALAR = String.raw`(?:(?:\d+(?:ms|[smhdwMy]))+|\d+(?:\.\d+)?(?:[KMGT]i?B|B)|-?\d+(?:\.\d+)?)`;

/** IPv6 addresses including the bare `::`; at least two colons keep it apart from ports. */
const IPV6 = String.raw`(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}`;

/**
 * Every number-like literal RadConf parses: bracketed IPv6 endpoints, IPv4 addresses with a
 * prefix or port, IPv6 with a prefix, ratios, HTTP status classes, ranges and percentages.
 * The lookahead keeps an invalid word such as `123abc` from passing as a number.
 */
const NUMBER = new RegExp(
    String.raw`^(?:\[${IPV6}\](?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2}|:\d+)?|${IPV6}(?:\/\d{1,3})?|\d+\/\d+|\dXX|${SCALAR}\.\.(?:${SCALAR})?|\.\.${SCALAR}|${SCALAR}%?)(?![\w$.:-])`,
);

/** A regex literal. Its `/` never starts a comment, and `\/` escapes a slash inside it. */
const REGEX = /^\/(?![/*])[^/\n\\]*(?:\\.[^/\n\\]*)*\/[A-Za-z]*/;

/** Operators that assign to the accessor before them. */
const ASSIGNMENT = /^(?:\?=|\+=|:=|=(?![=>*~]))/;

/** Symbolic comparisons, including `=~`/`!~` which only the old tokenizer knew. */
const COMPARISON = /^(?:==|!=|<=|>=|=~|!~|=\*|!\*|<|>)/;

/** The innermost string or placeholder, or undefined in plain RadConf. */
function innermost(state: RadconfState) {
    return state.stack.at(-1);
}

/** Starts a new statement, because the first word of a statement is its name. */
function startStatement(state: RadconfState) {
    state.atStart = true;
    state.afterOperand = false;
    state.afterPipe = false;
    state.head = "";
}

/**
 * Whether a word in statement position is a value rather than a name. A statement name is
 * followed by arguments, but an assignment target or a condition is followed by an operator,
 * and an expression statement such as `aaa.identity;` by its end.
 */
function startsWithValue(word: string, rest: string) {
    if (/^[[(]/.test(rest)) {
        return true;
    }

    const after = rest.trimStart();
    const nextWord = /^!?[a-z]+/.exec(after)?.[0];

    if (
        ASSIGNMENT.test(after) ||
        COMPARISON.test(after) ||
        after.startsWith("=>") ||
        (nextWord !== undefined &&
            WORD_OPERATOR.test(nextWord) &&
            /^\s/.test(after.slice(nextWord.length)))
    ) {
        return true;
    }

    // A dotted name ending its statement is an accessor (`remove { vars.old; }`), while an
    // action such as `count.add "name"` carries arguments.
    return word.includes(".") && /^(?:$|[;|,)\]#])/.test(after);
}

/** Classifies a word in value position: an accessor, a literal word, a filter or an operator. */
function valueWordToken(word: string, rest: string, state: RadconfState) {
    if (state.afterPipe) {
        state.afterPipe = false;

        return "variableName.function";
    }

    if (state.afterOperand && WORD_OPERATOR.test(word)) {
        state.afterOperand = false;

        return "compareOperator";
    }

    state.afterOperand = true;

    if (word.includes(".")) {
        if (rest.startsWith("(")) {
            return "propertyName.function";
        }

        return "variableName";
    }

    if (state.nesting > 0 && /^\s*=(?![=>*~])/.test(rest)) {
        state.afterOperand = false;

        return "attributeName";
    }

    if (rest.startsWith("[") || word.startsWith("$")) {
        return "variableName";
    }

    if (BOOLEAN_WORDS.has(word)) {
        return "bool";
    }

    if (word === "none") {
        return "null";
    }

    if (ATOM_WORDS.has(word)) {
        return "atom";
    }

    // An unknown bare word that opens a block names a kind, such as `bindings json {`.
    if (/^\s*\{/.test(rest)) {
        return "typeName";
    }

    return null;
}

/** Tokenizes a word: a control keyword, a statement name or a value, depending on position. */
function wordToken(word: string, stream: StringStream, state: RadconfState) {
    const rest = stream.string.slice(stream.pos);
    const atStart = state.atStart;
    state.atStart = false;

    if (CONTROL_WORDS.has(word) && !/^[[(.]/.test(rest)) {
        state.afterOperand = false;
        state.afterPipe = false;
        state.atStart = PREFIX_WORDS.has(word);

        if (atStart || state.head === "") {
            state.head = word;
        }

        return "controlKeyword";
    }

    if (atStart && !startsWithValue(word, rest)) {
        state.head = word;

        return "keyword";
    }

    const token = valueWordToken(word, rest, state);

    // A plain word in statement position that an operator follows is an accessor even
    // without a dot (`foo = "x";`).
    return token === null && atStart ? "variableName" : token;
}

/** Tokenizes the text of a `"…"` or `"""…"""` string, up to the next escape, placeholder or end. */
function tokenStringText(
    stream: StringStream,
    state: RadconfState,
    context: "string" | "triple",
) {
    if (context === "triple" ? stream.match('"""') : stream.eat('"')) {
        state.stack.pop();
        state.afterOperand = true;

        return "string";
    }

    if (stream.match("%{")) {
        state.stack.push("placeholder");
        state.afterOperand = false;
        state.afterPipe = false;

        return "variableName.special";
    }

    if (context === "string") {
        if (stream.match(/^\\(?:x[0-9a-fA-F]{2}|["\\])/)) {
            return "escape";
        }

        if (stream.match(/^\\./)) {
            return "invalid";
        }
    } else if (stream.match(/^\\./)) {
        return "escape";
    }

    // A lone `%`, `"` or `\` that starts nothing is still part of the string.
    if (!stream.eatWhile(/[^"\\%]/)) {
        stream.next();
    }

    return "string";
}

/** Tokenizes brackets and punctuation, which also decide where statements start. */
function tokenPunctuation(stream: StringStream, state: RadconfState) {
    const char = stream.next() ?? "";

    switch (char) {
        case "{":
            if (state.head === "key" && state.blocks.at(-1) === "license") {
                state.opaque = true;
            }

            state.blocks.push(state.head);
            startStatement(state);

            return "brace";
        case "}":
            state.blocks.pop();
            state.opaque = false;
            startStatement(state);

            return "brace";
        case ";":
            if (state.nesting === 0) {
                startStatement(state);
            }

            return "separator";
        case "(":
        case "[":
            state.nesting += 1;
            state.atStart = false;
            state.afterOperand = false;

            return char === "(" ? "paren" : "squareBracket";
        case ")":
        case "]":
            state.nesting = Math.max(0, state.nesting - 1);
            state.afterOperand = true;

            return char === ")" ? "paren" : "squareBracket";
        case ",":
            state.afterOperand = false;

            return "separator";
        default:
            state.atStart = false;

            return "punctuation";
    }
}

/** Tokenizes operators, after which a value follows rather than another operator. */
function tokenOperator(stream: StringStream, state: RadconfState) {
    state.atStart = false;
    state.afterOperand = false;

    if (stream.eat("|")) {
        state.afterPipe = true;

        return "operator";
    }

    if (stream.match("=>")) {
        return "operator";
    }

    if (stream.match(ASSIGNMENT)) {
        return "definitionOperator";
    }

    if (stream.match(COMPARISON)) {
        return "compareOperator";
    }

    return undefined;
}

/** Tokenizes RadConf outside strings, including the expression inside a `%{…}` placeholder. */
function tokenCode(stream: StringStream, state: RadconfState) {
    if (stream.eatSpace()) {
        return null;
    }

    if (stream.peek() === "#") {
        stream.skipToEnd();

        return "lineComment";
    }

    if (innermost(state) === "placeholder" && stream.eat("}")) {
        state.stack.pop();
        state.afterOperand = true;
        state.afterPipe = false;

        return "variableName.special";
    }

    if (stream.match('"""')) {
        state.stack.push("triple");
        state.atStart = false;

        return "string";
    }

    if (stream.eat('"')) {
        state.stack.push("string");
        state.atStart = false;

        return "string";
    }

    if (stream.match("%{")) {
        state.stack.push("placeholder");
        state.atStart = false;

        return "variableName.special";
    }

    // Root binding: a `.` on its own binds the value after it to the document root.
    if (state.atStart && stream.match(/^\.(?=\s)/)) {
        state.atStart = false;

        return "punctuation";
    }

    // Literals can open a statement too, as `5 => {` cases of a `match` do.
    if (stream.match(NUMBER)) {
        state.atStart = false;
        state.afterOperand = true;

        return "number";
    }

    if (stream.match(REGEX)) {
        state.atStart = false;
        state.afterOperand = true;

        return "regexp";
    }

    const word = stream.match(WORD);

    if (Array.isArray(word)) {
        return wordToken(word[0], stream, state);
    }

    const operator = tokenOperator(stream, state);

    if (operator !== undefined) {
        return operator;
    }

    return tokenPunctuation(stream, state);
}

/**
 * A grammar for Radiator's RadConf configuration language (`.radconf`). It has no fixed
 * keyword list: the first word of a statement is its name, so new block and action names
 * highlight without updating a list here. Values are classified by shape, the way the
 * RadConf parser classifies unquoted values after parsing.
 */
export const radconf: StreamParser<RadconfState> = {
    name: "radconf",
    startState: () => ({
        stack: [],
        blocks: [],
        head: "",
        atStart: true,
        afterOperand: false,
        afterPipe: false,
        nesting: 0,
        opaque: false,
    }),
    copyState: (state) => ({
        ...state,
        stack: [...state.stack],
        blocks: [...state.blocks],
    }),
    token(stream, state) {
        if (state.opaque && innermost(state) === undefined) {
            if (stream.peek() !== "}") {
                stream.eatWhile(/[^}]/);

                return "string";
            }
        }

        const context = innermost(state);

        if (context === "string" || context === "triple") {
            return tokenStringText(stream, state, context);
        }

        return tokenCode(stream, state);
    },
    indent(state, textAfter, context) {
        // Text inside a multi-line string keeps whatever indentation it has.
        if (innermost(state) !== undefined || state.opaque) {
            return null;
        }

        const depth = state.blocks.length - (/^\s*\}/.test(textAfter) ? 1 : 0);

        return Math.max(0, depth) * context.unit;
    },
    languageData: {
        commentTokens: { line: "#" },
        indentOnInput: /^\s*\}$/,
    },
};
