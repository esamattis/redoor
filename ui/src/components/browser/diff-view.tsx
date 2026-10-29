/*
 * The diff table: files, hunks, rows and skipped stretches.
 *
 * The Diff/Hunk/Line/SkipBlockRow structure and the inline modified rows are ported from the
 * MIT-licensed diff viewer by Fredrika Lindh (https://github.com/fredrikalindh/ui,
 * registry/ui/diff/index.tsx), with the app's highlighter, theme colours and editor links.
 */
import React from "react";
import type { Language } from "@codemirror/language";
import {
    ArrowDownFromLine,
    ArrowUpFromLine,
    ChevronsUpDown,
    SquarePen,
    UnfoldVertical,
} from "lucide-react";
import type { browserRoute } from "#ui/browser-route";
import { HighlightedTokens } from "#ui/components/highlighted-tokens";
import { IconButton, IconLinkButton } from "#ui/components/icon-button";
import {
    OpenInBackgroundButton,
    type BackgroundOpen,
} from "#ui/components/browser/open-file-actions";
import {
    fileLines,
    isExpandable,
    lineSideText,
    type DiffFile,
    type DiffLine,
    type LineSegment,
    type SkipBlock,
} from "#ui/utils/diff-parse";
import {
    highlightLines,
    languageForFileName,
    useLoadedLanguage,
    type HighlightLanguageSource,
    type HighlightToken,
} from "#ui/utils/code-highlight";
import { cn } from "#ui/utils/cn";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";

/** Where the editor opens the diffed file, as built by `browserRoute`. */
export type DiffEditorRoute = ReturnType<typeof browserRoute>;

/** Each side's highlighted tokens by line number, so a row looks its tokens up directly. */
interface FileHighlight {
    old: Map<number, HighlightToken[]>;
    new: Map<number, HighlightToken[]>;
}

/**
 * Patches larger than this render without colours. Highlighting runs during render, and a
 * multi-megabyte patch would block the page for longer than the colours are worth.
 */
const MAX_HIGHLIGHTED_CHARACTERS = 1_000_000;

/** The name a file is shown and highlighted by: the new path, or the old one if deleted. */
export function diffFileName(file: DiffFile): string {
    return file.newPath ?? file.oldPath ?? "";
}

/**
 * Finds the file's first line when the patch includes it, so an extensionless script still
 * highlights by its shebang.
 */
function firstFileLine(file: DiffFile): string {
    for (const line of fileLines(file)) {
        if (line.newLineNumber === 1) {
            return lineSideText(line, "new");
        }

        if (line.oldLineNumber === 1) {
            return lineSideText(line, "old");
        }
    }

    return "";
}

/** Picks the file's grammar the same way the editor does. */
function diffFileLanguage(file: DiffFile): HighlightLanguageSource {
    return languageForFileName(diffFileName(file), firstFileLine(file));
}

/**
 * Highlights consecutive lines of one side as a block, so strings and comments spanning
 * lines keep their colours, and files each line's tokens under its line number.
 */
function highlightBlock(
    texts: Array<string | undefined>,
    start: number,
    language: Language,
): Array<[number, HighlightToken[]]> {
    if (texts.length === 0) {
        return [];
    }

    const lines = highlightLines(
        texts.map((text) => text ?? "").join("\n"),
        language,
    );

    const entries: Array<[number, HighlightToken[]]> = [];

    texts.forEach((text, index) => {
        const tokens = lines[index];

        // Tokens that do not spell the line exactly would cut inline segments wrongly.
        if (
            text === undefined ||
            tokens === undefined ||
            tokens.map((token) => token.text).join("") !== text
        ) {
            return;
        }

        entries.push([start + index, tokens]);
    });

    return entries;
}

/**
 * Highlights every run of consecutive lines of one side as one block. A default-context
 * patch gives one run per hunk; a patch carrying its whole file gives one run, so even a
 * folded line keeps the colours of a string or comment opened far above it.
 */
function highlightSide(
    texts: Map<number, string>,
    language: Language,
): Map<number, HighlightToken[]> {
    const numbers = [...texts.keys()].sort((a, b) => a - b);
    const highlighted = new Map<number, HighlightToken[]>();
    let runStart = 0;

    for (let index = 1; index <= numbers.length; index++) {
        const previous = numbers[index - 1] ?? 0;

        if (index < numbers.length && numbers[index] === previous + 1) {
            continue;
        }

        const run = numbers.slice(runStart, index);

        for (const [line, tokens] of highlightBlock(
            run.map((number) => texts.get(number)),
            run[0] ?? 0,
            language,
        )) {
            highlighted.set(line, tokens);
        }

        runStart = index;
    }

    return highlighted;
}

/** Highlights both sides of every row the patch carries for a file, folded or not. */
function highlightFile(
    file: DiffFile,
    language: Language | null,
): FileHighlight | null {
    if (language === null) {
        return null;
    }

    const oldTexts = new Map<number, string>();
    const newTexts = new Map<number, string>();
    let characters = 0;

    for (const line of fileLines(file)) {
        if (line.oldLineNumber !== null) {
            const text = lineSideText(line, "old");
            oldTexts.set(line.oldLineNumber, text);
            characters += text.length;
        }

        if (line.newLineNumber !== null) {
            const text = lineSideText(line, "new");
            newTexts.set(line.newLineNumber, text);
            characters += text.length;
        }

        if (characters > MAX_HIGHLIGHTED_CHARACTERS) {
            return null;
        }
    }

    return {
        old: highlightSide(oldTexts, language),
        new: highlightSide(newTexts, language),
    };
}

/** Cuts the tokens covering characters `start` to `end` of their line. */
function sliceTokens(
    tokens: HighlightToken[],
    start: number,
    end: number,
): HighlightToken[] {
    const result: HighlightToken[] = [];
    let position = 0;

    for (const token of tokens) {
        const tokenEnd = position + token.text.length;

        if (tokenEnd > start && position < end) {
            result.push({
                text: token.text.slice(
                    Math.max(0, start - position),
                    Math.min(token.text.length, end - position),
                ),
                className: token.className,
                kind: token.kind,
            });
        }

        position = tokenEnd;

        if (position >= end) {
            break;
        }
    }

    return result;
}

/** One inline segment of a row with its highlighted tokens. */
interface RowPart {
    type: LineSegment["type"];
    tokens: HighlightToken[];
}

/**
 * Splits a row's highlighted line into its inline segments. Each line is highlighted once
 * as a whole and then cut, rather than highlighting every segment alone, because a segment
 * such as half a string literal has no grammar of its own. Deleted text takes its colours
 * from the old line and inserted text from the new one; kept text advances through both.
 */
function rowParts(
    line: DiffLine,
    oldTokens: HighlightToken[] | undefined,
    newTokens: HighlightToken[] | undefined,
): RowPart[] {
    let oldOffset = 0;
    let newOffset = 0;

    return line.segments.map((segment) => {
        const fromOld =
            segment.type === "delete" ||
            (segment.type === "normal" && line.newLineNumber === null);

        const tokens = fromOld ? oldTokens : newTokens;
        const start = fromOld ? oldOffset : newOffset;
        const end = start + segment.value.length;

        if (segment.type !== "insert") {
            oldOffset += segment.value.length;
        }

        if (segment.type !== "delete") {
            newOffset += segment.value.length;
        }

        return {
            type: segment.type,
            tokens:
                tokens === undefined
                    ? [{ text: segment.value, className: null, kind: null }]
                    : sliceTokens(tokens, start, end),
        };
    });
}

/** Row backgrounds by kind; modified rows stay neutral so their inline changes stand out. */
const ROW_CLASSES = {
    normal: "bg-surface",
    insert: "bg-diff-insert",
    delete: "bg-diff-delete",
    modified: "bg-surface",
} satisfies Record<DiffLine["kind"], string>;

/** The left edge marks a changed row even where colours are hard to tell apart. */
const MARKER_CLASSES = {
    normal: "border-l-transparent",
    insert: "border-l-diff-insert-marker",
    delete: "border-l-diff-delete-marker",
    modified: "border-l-amber-400",
} satisfies Record<DiffLine["kind"], string>;

const SIGNS = {
    normal: "",
    insert: "+",
    delete: "-",
    modified: "~",
} satisfies Record<DiffLine["kind"], string>;

/**
 * CSS widths of the gutter's slots, shared by every row of a file so the line numbers, the
 * change sign and a fold's expand buttons line up in the same columns.
 */
interface GutterSlots {
    number: string;
    sign: string;
}

/** How wide a slot must be to hold one extra-small icon button. */
const BUTTON_SLOT_WIDTH = "1.375rem";

/**
 * Sizes the gutter for the file's largest line number. A file with expandable folds widens
 * every slot to fit a button, so the buttons sit in the columns of the numbers and sign.
 */
function gutterSlots(file: DiffFile): GutterSlots {
    let largest = 0;

    for (const line of fileLines(file)) {
        largest = Math.max(
            largest,
            line.oldLineNumber ?? 0,
            line.newLineNumber ?? 0,
        );
    }

    const number = `${String(String(largest).length)}ch`;

    return isExpandable(file)
        ? {
              number: `max(${number}, ${BUTTON_SLOT_WIDTH})`,
              sign: BUTTON_SLOT_WIDTH,
          }
        : { number, sign: "1ch" };
}

/** What a fold row puts in the gutter's slots instead of line numbers and a sign. */
interface GutterContent {
    old: React.ReactNode;
    new: React.ReactNode;
    sign: React.ReactNode;
}

/**
 * The line numbers and change sign. It scrolls sideways with the rest of its row, so a long
 * line never slides underneath the numbers.
 */
function Gutter(props: {
    kind: DiffLine["kind"] | "skip";
    oldLineNumber: number | null;
    newLineNumber: number | null;
    slots: GutterSlots;
    /** Replaces the numbers and sign slot by slot, keeping their columns. */
    content?: GutterContent;
    /** Replaces the slots entirely, for a marker that belongs to no column. */
    children?: React.ReactNode;
}) {
    const kind = props.kind === "skip" ? "normal" : props.kind;

    return (
        <td
            className={cn(
                "select-none whitespace-nowrap border-l-3 px-2 text-right tabular-nums text-slate-500",
                props.kind === "skip" ? "bg-surface-raised" : ROW_CLASSES[kind],
                MARKER_CLASSES[kind],
            )}
        >
            {props.children ?? (
                <>
                    <span
                        className="inline-block align-middle"
                        style={{ minWidth: props.slots.number }}
                    >
                        {props.content?.old ?? props.oldLineNumber ?? ""}
                    </span>
                    <span
                        className="ml-2 inline-block align-middle"
                        style={{ minWidth: props.slots.number }}
                    >
                        {props.content?.new ?? props.newLineNumber ?? ""}
                    </span>
                    <span
                        aria-hidden={props.content === undefined}
                        className="ml-2 inline-block text-center align-middle"
                        style={{ width: props.slots.sign }}
                    >
                        {props.content?.sign ?? SIGNS[kind]}
                    </span>
                </>
            )}
        </td>
    );
}

/**
 * One diff row. Whole-line inserts and deletes use `<ins>` and `<del>` so assistive
 * technology announces them; a modified row marks only its changed segments that way.
 * It is memoized because a large diff re-renders often and the rows themselves rarely change.
 */
const Line = React.memo(function Line(props: {
    line: DiffLine;
    oldTokens: HighlightToken[] | undefined;
    newTokens: HighlightToken[] | undefined;
    editorRoute: DiffEditorRoute | null;
    background: BackgroundOpen | null;
    slots: GutterSlots;
    wrapLines: boolean;
}) {
    const line = props.line;
    const parts = rowParts(line, props.oldTokens, props.newTokens);

    const Tag =
        line.kind === "insert"
            ? "ins"
            : line.kind === "delete"
              ? "del"
              : "span";

    const openLine = line.newLineNumber;

    return (
        <>
            <tr
                data-line-kind={line.kind}
                data-line-old={line.oldLineNumber ?? undefined}
                data-line-new={line.newLineNumber ?? undefined}
                // A wrapped line spans several visual rows, so its number and open links
                // stay beside its first one.
                className={cn(
                    ROW_CLASSES[line.kind],
                    props.wrapLines && "align-top",
                )}
            >
                <Gutter
                    kind={line.kind}
                    oldLineNumber={line.oldLineNumber}
                    newLineNumber={line.newLineNumber}
                    slots={props.slots}
                />
                <td
                    className={cn(
                        "w-full pl-2 pr-4",
                        props.wrapLines
                            ? "whitespace-pre-wrap wrap-anywhere"
                            : "whitespace-pre",
                    )}
                >
                    <Tag className="no-underline">
                        {parts.map((part, index) =>
                            part.type === "insert" ? (
                                <ins
                                    key={index}
                                    className="rounded-sm bg-diff-insert-strong no-underline"
                                >
                                    <HighlightedTokens tokens={part.tokens} />
                                </ins>
                            ) : part.type === "delete" ? (
                                <del
                                    key={index}
                                    className="rounded-sm bg-diff-delete-strong"
                                >
                                    <HighlightedTokens tokens={part.tokens} />
                                </del>
                            ) : (
                                <HighlightedTokens
                                    key={index}
                                    tokens={part.tokens}
                                />
                            ),
                        )}
                    </Tag>
                </td>
                <td
                    className={cn(
                        // Sticky with the row's own opaque background, so the actions stay
                        // in view over long lines instead of sitting at the far end of them.
                        "sticky right-0 select-none whitespace-nowrap py-px pr-2 pl-1 text-right",
                        ROW_CLASSES[line.kind],
                        !props.wrapLines && "align-middle",
                    )}
                >
                    {props.editorRoute === null || openLine === null ? null : (
                        // Only new-side lines exist in the current file, so only they open.
                        <span className="inline-flex items-center gap-1">
                            {/* Tighter than the button's own padding, so rows keep their height. */}
                            <IconLinkButton
                                {...props.editorRoute}
                                search={{ line: openLine }}
                                variant="ghost"
                                label={`Open line ${String(openLine)} in editor`}
                                className="p-0.5"
                            >
                                <SquarePen
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                            </IconLinkButton>
                            {props.background === null ? null : (
                                <OpenInBackgroundButton
                                    target={props.background}
                                    line={openLine}
                                    className="p-0.5"
                                />
                            )}
                        </span>
                    )}
                </td>
            </tr>
            {line.missingNewline ? (
                <tr data-line-kind="no-newline" className="bg-surface">
                    <Gutter
                        kind="normal"
                        oldLineNumber={null}
                        newLineNumber={null}
                        slots={props.slots}
                    />
                    <td colSpan={2} className="pl-2 italic text-slate-500">
                        \ No newline at end of file
                    </td>
                </tr>
            ) : null}
        </>
    );
});

/** How many folded lines one step of expanding reveals. */
const EXPAND_STEP = 20;

/** How much of one fold the reader has revealed, from its top and from its bottom. */
interface Reveal {
    fromTop: number;
    fromBottom: number;
}

const NOTHING_REVEALED: Reveal = { fromTop: 0, fromBottom: 0 };

/**
 * Stands in for the unchanged lines between hunks, with the section Git names there. The
 * buttons that reveal the lines sit in the gutter's columns; a fold without them keeps a
 * plain marker there instead.
 */
function SkipBlockRow(props: {
    block: SkipBlock;
    hiddenCount: number;
    slots: GutterSlots;
    buttons?: GutterContent;
}) {
    const hidden = `${String(props.hiddenCount)} unchanged ${props.hiddenCount === 1 ? "line" : "lines"} hidden`;

    return (
        <tr data-skip-block="" className="bg-surface-raised text-slate-400">
            <Gutter
                kind="skip"
                oldLineNumber={null}
                newLineNumber={null}
                slots={props.slots}
                content={props.buttons}
            >
                {props.buttons === undefined ? (
                    <ChevronsUpDown
                        className="mx-auto h-3.5 w-3.5 opacity-60"
                        aria-hidden="true"
                    />
                ) : undefined}
            </Gutter>
            <td colSpan={2} className="py-1 pl-2 italic">
                {props.block.content === ""
                    ? hidden
                    : `${hidden} · ${props.block.content}`}
            </td>
        </tr>
    );
}

/** The rows the view draws with, shared by hunks and revealed folds. */
interface RowContext {
    highlight: FileHighlight | null;
    editorRoute: DiffEditorRoute | null;
    /** Opens the current file at a row's line without leaving the diff. */
    background: BackgroundOpen | null;
    slots: GutterSlots;
    wrapLines: boolean;
}

/** Renders rows of a hunk or a revealed fold. */
function Rows(props: { lines: DiffLine[]; context: RowContext }) {
    const context = props.context;

    return props.lines.map((line, index) => (
        <Line
            key={index}
            line={line}
            oldTokens={
                line.oldLineNumber === null
                    ? undefined
                    : context.highlight?.old.get(line.oldLineNumber)
            }
            newTokens={
                line.newLineNumber === null
                    ? undefined
                    : context.highlight?.new.get(line.newLineNumber)
            }
            editorRoute={context.editorRoute}
            background={context.background}
            slots={context.slots}
            wrapLines={context.wrapLines}
        />
    ));
}

/**
 * One fold: its revealed rows around a row that names the lines still hidden. Revealing
 * grows the visible context from the hunk above (down) or below (up), like GitHub, so a fold
 * at the top of the file only expands up and one at the end only down.
 */
function Fold(props: {
    block: SkipBlock;
    reveal: Reveal;
    onReveal: (reveal: Reveal) => void;
    /** Shows every folded line, for reading the whole file. */
    wholeFile: boolean;
    hasHunkAbove: boolean;
    hasHunkBelow: boolean;
    context: RowContext;
}) {
    const lines = props.block.lines;

    if (lines === null) {
        return (
            <SkipBlockRow
                block={props.block}
                hiddenCount={props.block.count}
                slots={props.context.slots}
            />
        );
    }

    const fromTop = props.wholeFile ? lines.length : props.reveal.fromTop;
    const fromBottom = props.reveal.fromBottom;
    const hiddenCount = lines.length - fromTop - fromBottom;

    if (hiddenCount <= 0) {
        return <Rows lines={lines} context={props.context} />;
    }

    const expandDown = () =>
        props.onReveal({
            fromTop: fromTop + Math.min(EXPAND_STEP, hiddenCount),
            fromBottom,
        });

    const expandUp = () =>
        props.onReveal({
            fromTop,
            fromBottom: fromBottom + Math.min(EXPAND_STEP, hiddenCount),
        });

    const expandAll = () =>
        props.onReveal({ fromTop: fromTop + hiddenCount, fromBottom });

    const stepped = hiddenCount > EXPAND_STEP;

    return (
        <>
            <Rows lines={lines.slice(0, fromTop)} context={props.context} />
            <SkipBlockRow
                block={props.block}
                hiddenCount={hiddenCount}
                slots={props.context.slots}
                // Down grows the hunk above and up the hunk below, so they take the old and
                // new number columns in reading order; the whole fold opens from the sign's.
                buttons={{
                    old:
                        stepped && props.hasHunkAbove ? (
                            <IconButton
                                type="button"
                                variant="ghost"
                                size="xs"
                                label="Expand down"
                                tooltip={`Show ${String(EXPAND_STEP)} more unchanged lines below the change above`}
                                onClick={expandDown}
                            >
                                <ArrowDownFromLine
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                            </IconButton>
                        ) : null,
                    new:
                        stepped && props.hasHunkBelow ? (
                            <IconButton
                                type="button"
                                variant="ghost"
                                size="xs"
                                label="Expand up"
                                tooltip={`Show ${String(EXPAND_STEP)} more unchanged lines above the change below`}
                                onClick={expandUp}
                            >
                                <ArrowUpFromLine
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                            </IconButton>
                        ) : null,
                    sign: (
                        <IconButton
                            type="button"
                            variant="ghost"
                            size="xs"
                            label="Expand all"
                            tooltip={`Show all ${String(hiddenCount)} hidden unchanged ${hiddenCount === 1 ? "line" : "lines"}`}
                            onClick={expandAll}
                        >
                            <UnfoldVertical
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                            />
                        </IconButton>
                    ),
                }}
            />
            <Rows
                lines={lines.slice(lines.length - fromBottom)}
                context={props.context}
            />
        </>
    );
}

/** How far each fold is revealed, by fold index, for every file a history entry showed. */
type FoldRevealsByFile = ReadonlyMap<string, ReadonlyMap<number, Reveal>>;

const foldRevealStates = new HistoryEntryStore<FoldRevealsByFile>();

/**
 * Remembers how far each fold of a file is revealed. The folds are identified by the file's
 * paths and hunk layout rather than the parsed object, so switching the inline layout, which
 * parses the patch again, keeps what the reader opened, while a patch whose hunks moved starts
 * over. Every file of a history entry shares one stored map, because a store keeps a bounded
 * number of values and a long diff list would otherwise push out other entries' state. It is
 * kept per history entry because revealed lines change the list's height, which the restored
 * scroll position depends on when the reader comes back from a file.
 */
function useFoldReveals(file: DiffFile) {
    const fileKey = React.useMemo(
        () =>
            JSON.stringify([
                file.oldPath,
                file.newPath,
                file.hunks.map((hunk) =>
                    hunk.type === "hunk" ? hunk.header : String(hunk.count),
                ),
            ]),
        [file],
    );

    const [revealsByFile, update] = useHistoryEntryState<FoldRevealsByFile>({
        store: foldRevealStates,
        // One scope for the whole entry, since the file key already tells the files apart.
        scope: "diff-folds",
        initial: () => new Map(),
    });

    const reveals = revealsByFile.get(fileKey);

    return {
        get: (index: number) => reveals?.get(index) ?? NOTHING_REVEALED,
        set: (index: number, reveal: Reveal) =>
            update((previous) =>
                new Map(previous).set(
                    fileKey,
                    new Map(previous.get(fileKey)).set(index, reveal),
                ),
            ),
    };
}

/**
 * One file's rows as a table. It scrolls sideways inside its own box, so wide lines never
 * widen the page or the file header above them, unless `wrapLines` fits them to the box
 * for readers who would rather not scroll. Highlighting is memoized on the parsed file, so
 * re-rendering a large diff does not highlight it again. Folded unchanged lines come from the
 * patch itself, so revealing them never asks the server again.
 */
export function Diff(props: {
    file: DiffFile;
    label: string;
    editorRoute: DiffEditorRoute | null;
    background: BackgroundOpen | null;
    wrapLines: boolean;
    /** Reveals every folded line, so the patch reads as the whole file with its changes. */
    wholeFile: boolean;
}) {
    const file = props.file;
    // A grammar that loads lazily renders plain rows first and colours them once loaded.
    const languageSource = React.useMemo(() => diffFileLanguage(file), [file]);
    const language = useLoadedLanguage(languageSource);

    const highlight = React.useMemo(
        () => highlightFile(file, language),
        [file, language],
    );

    const slots = React.useMemo(() => gutterSlots(file), [file]);
    const reveals = useFoldReveals(file);

    const context: RowContext = {
        highlight,
        editorRoute: props.editorRoute,
        background: props.background,
        slots,
        wrapLines: props.wrapLines,
    };

    return (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden">
            <table
                aria-label={props.label}
                className={cn(
                    "syntax-highlight border-separate border-spacing-0 bg-surface font-mono text-code leading-5 text-slate-200 @max-xl:leading-4",
                    props.wrapLines ? "w-full" : "w-max min-w-full",
                )}
            >
                <tbody>
                    {file.hunks.map((hunk, index) =>
                        hunk.type === "hunk" ? (
                            <Rows
                                key={index}
                                lines={hunk.lines}
                                context={context}
                            />
                        ) : (
                            <Fold
                                key={index}
                                block={hunk}
                                reveal={reveals.get(index)}
                                onReveal={(reveal) =>
                                    reveals.set(index, reveal)
                                }
                                wholeFile={props.wholeFile}
                                hasHunkAbove={index > 0}
                                hasHunkBelow={index < file.hunks.length - 1}
                                context={context}
                            />
                        ),
                    )}
                </tbody>
            </table>
        </div>
    );
}
