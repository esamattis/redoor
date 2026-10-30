/*
 * Marks the diff search's matches on the page and scrolls to the current one. Matches are
 * found in the parsed patches; this module maps them to the rows React rendered, which it
 * finds by the search keys the diff view writes on every row.
 */
import { diffRowKey, type DiffSearchMatch } from "#ui/utils/diff-search";

/** The attribute that names a card's section by its path, so the search can find it. */
export const DIFF_SEARCH_PATH_ATTRIBUTE = "data-diff-search-path";

/** The name all matches are registered under, which the stylesheet colours. */
const ALL_MATCHES_HIGHLIGHT = "diff-search";

/** The name of the current match, coloured to stand out among the others. */
const CURRENT_MATCH_HIGHLIGHT = "diff-search-current";

/**
 * Builds a range over characters `start` to `end` of a row's text cell. The text is split
 * into many text nodes by the highlighted tokens and inline changes, so the range may start
 * in one node and end in another.
 */
function textRange(cell: Element, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let position = 0;
    let started = false;

    for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
    ) {
        const length = node.textContent?.length ?? 0;

        if (!started && start < position + length) {
            range.setStart(node, start - position);
            started = true;
        }

        if (started && end <= position + length) {
            range.setEnd(node, end - position);

            return range;
        }

        position += length;
    }

    return null;
}

/**
 * Keeps the highlight ranges in step with the rows on the page. Ranges point at text nodes,
 * and the rows change under them whenever a file expands, a fold opens or a plain file gains
 * its colours, so a mutation observer marks the cards whose rows changed and their ranges are
 * built again in the next frame. Only rendered rows get ranges; a match in a collapsed file or
 * a closed fold has nothing to mark until the search steps to it.
 */
export class DiffSearchHighlighter {
    private readonly all: Highlight | null;
    private readonly current: Highlight | null;
    private readonly observer: MutationObserver;
    private matchesByPath = new Map<string, DiffSearchMatch[]>();
    private readonly rangesByPath = new Map<string, Range[]>();
    private currentMatch: DiffSearchMatch | null = null;
    private scrollPending = false;
    private readonly dirty = new Set<string>();
    private frame: number | null = null;

    constructor(private readonly root: HTMLElement) {
        // Without the API the search still steps through matches, just without marking them.
        const supported =
            typeof Highlight !== "undefined" && "highlights" in CSS;

        this.all = supported ? new Highlight() : null;
        this.current = supported ? new Highlight() : null;

        if (this.all !== null && this.current !== null) {
            // The current match must win over the colour of all matches it is one of.
            this.current.priority = 1;
            CSS.highlights.set(ALL_MATCHES_HIGHLIGHT, this.all);
            CSS.highlights.set(CURRENT_MATCH_HIGHLIGHT, this.current);
        }

        this.observer = new MutationObserver((mutations) =>
            this.onMutations(mutations),
        );

        this.observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    /** Replaces the matches to mark, rebuilding the ranges of every card that had or has any. */
    setMatches(matches: DiffSearchMatch[]) {
        const previous = this.matchesByPath;
        this.matchesByPath = new Map();

        for (const match of matches) {
            const list = this.matchesByPath.get(match.path);

            if (list === undefined) {
                this.matchesByPath.set(match.path, [match]);
            } else {
                list.push(match);
            }
        }

        for (const path of [...previous.keys(), ...this.matchesByPath.keys()]) {
            this.dirty.add(path);
        }

        this.schedule();
    }

    /**
     * Marks the current match and, when `scroll` is set, scrolls it into view as soon as its
     * row is on the page, which may take a few renders while its file expands.
     */
    setCurrent(match: DiffSearchMatch | null, scroll: boolean) {
        this.currentMatch = match;
        this.scrollPending = scroll && match !== null;

        if (match !== null) {
            this.dirty.add(match.path);
        }

        this.schedule();
    }

    /** Removes the marks and stops watching the page. */
    dispose() {
        this.observer.disconnect();

        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
        }

        if (this.all !== null) {
            CSS.highlights.delete(ALL_MATCHES_HIGHLIGHT);
            CSS.highlights.delete(CURRENT_MATCH_HIGHLIGHT);
        }
    }

    /**
     * Marks the cards whose rows changed. Only changes that touch rows count, so the line
     * toolbar following the pointer or a header's counts updating rebuild nothing.
     */
    private onMutations(mutations: MutationRecord[]) {
        for (const mutation of mutations) {
            const target =
                mutation.target instanceof Element
                    ? mutation.target
                    : mutation.target.parentElement;

            if (target === null) {
                continue;
            }

            const touchesRows =
                target.closest("table") !== null ||
                [...mutation.addedNodes, ...mutation.removedNodes].some(
                    (node) =>
                        node instanceof Element &&
                        (node.matches("table, tbody, tr") ||
                            node.querySelector("tr") !== null),
                );

            const section = target.closest(`[${DIFF_SEARCH_PATH_ATTRIBUTE}]`);
            const path = section?.getAttribute(DIFF_SEARCH_PATH_ATTRIBUTE);

            if (touchesRows && path !== null && path !== undefined) {
                this.dirty.add(path);
            }
        }

        if (this.dirty.size > 0) {
            this.schedule();
        }
    }

    /** Batches the rebuilding of every change made in one frame. */
    private schedule() {
        if (this.frame !== null) {
            return;
        }

        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            this.rebuild();
        });
    }

    /** Builds the ranges of the cards marked dirty and places the current match. */
    private rebuild() {
        const dirty = [...this.dirty];
        this.dirty.clear();

        for (const path of dirty) {
            this.rebuildCard(path);
        }

        this.placeCurrent();
    }

    /** The section of a card, found by the path it is named by. */
    private section(path: string): Element | null {
        return this.root.querySelector(
            `[${DIFF_SEARCH_PATH_ATTRIBUTE}="${CSS.escape(path)}"]`,
        );
    }

    /** The rendered row of a match, or null while its file or fold is closed. */
    private row(match: DiffSearchMatch): HTMLTableRowElement | null {
        return (
            this.section(match.path)?.querySelector<HTMLTableRowElement>(
                `tr[data-search-key="${diffRowKey(match.diffIndex, match.hunkIndex, match.lineIndex)}"]`,
            ) ?? null
        );
    }

    /** Rebuilds one card's ranges from the rows it has rendered. */
    private rebuildCard(path: string) {
        for (const range of this.rangesByPath.get(path) ?? []) {
            this.all?.delete(range);
        }

        this.rangesByPath.delete(path);

        const matches = this.matchesByPath.get(path);
        const section = this.section(path);

        if (matches === undefined || section === null || this.all === null) {
            return;
        }

        // One pass over the card's rows is cheaper than a lookup per match in a large file.
        const rows = new Map<string, HTMLTableRowElement>();

        for (const row of section.querySelectorAll<HTMLTableRowElement>(
            "tr[data-search-key]",
        )) {
            rows.set(row.dataset.searchKey ?? "", row);
        }

        const ranges: Range[] = [];

        for (const match of matches) {
            const cell = rows.get(
                diffRowKey(match.diffIndex, match.hunkIndex, match.lineIndex),
            )?.cells[1];

            const range =
                cell === undefined
                    ? null
                    : textRange(cell, match.start, match.end);

            if (range !== null) {
                ranges.push(range);
                this.all.add(range);
            }
        }

        this.rangesByPath.set(path, ranges);
    }

    /** Marks the current match and scrolls to it if a step is waiting for its row. */
    private placeCurrent() {
        this.current?.clear();
        const match = this.currentMatch;

        if (match === null) {
            return;
        }

        const row = this.row(match);
        const cell = row?.cells[1];

        const range =
            cell === undefined ? null : textRange(cell, match.start, match.end);

        if (row === null || range === null) {
            return;
        }

        this.current?.add(range);

        if (this.scrollPending) {
            this.scrollPending = false;
            scrollToMatch(row, range);
        }
    }
}

/**
 * Scrolls a match into the middle of the screen, clear of the sticky file header, and
 * sideways inside its patch's box when the line is wider than the box.
 */
function scrollToMatch(row: HTMLTableRowElement, range: Range) {
    row.scrollIntoView({ block: "center" });

    const box = row.closest("table")?.parentElement;

    if (box === null || box === undefined) {
        return;
    }

    const boxRect = box.getBoundingClientRect();
    const rect = range.getBoundingClientRect();

    if (rect.left < boxRect.left || rect.right > boxRect.right) {
        box.scrollLeft += rect.left - boxRect.left - box.clientWidth / 2;
    }
}

/**
 * The first match at or below the top of the screen, so a new query starts from where the
 * reader is, like find in page, instead of jumping back to the first file. Matches are in
 * page order, so it walks them and checks each card's position once.
 */
export function firstMatchOnScreen(
    root: HTMLElement,
    matches: DiffSearchMatch[],
): number {
    let skippedPath: string | null = null;

    for (const [index, match] of matches.entries()) {
        if (match.path === skippedPath) {
            continue;
        }

        const section = root.querySelector(
            `[${DIFF_SEARCH_PATH_ATTRIBUTE}="${CSS.escape(match.path)}"]`,
        );

        const rect = section?.getBoundingClientRect();

        if (rect === undefined || rect.bottom <= 0) {
            skippedPath = match.path;

            continue;
        }

        if (rect.top >= 0) {
            return index;
        }

        // The card starts above the screen, so its rows tell which matches are below the top.
        const row = section?.querySelector(
            `tr[data-search-key="${diffRowKey(match.diffIndex, match.hunkIndex, match.lineIndex)}"]`,
        );

        if (row !== null && row !== undefined) {
            if (row.getBoundingClientRect().top >= 0) {
                return index;
            }
        }
    }

    return 0;
}

/**
 * Where selected text starts in a diff list: the card, the row and the character in the
 * row's text, counted the same way as a match's offsets.
 */
export interface DiffSearchAnchor {
    path: string;
    rowKey: string;
    offset: number;
}

/**
 * Finds where a selection starts among the rows the search knows, so a search for the
 * selected text can make that occurrence current. Null when it starts outside a row's text.
 */
export function selectionAnchor(range: Range): DiffSearchAnchor | null {
    const start = range.startContainer;
    const element = start instanceof Element ? start : start.parentElement;
    const row = element?.closest<HTMLTableRowElement>("tr[data-search-key]");
    const cell = row?.cells[1];

    const path = row
        ?.closest(`[${DIFF_SEARCH_PATH_ATTRIBUTE}]`)
        ?.getAttribute(DIFF_SEARCH_PATH_ATTRIBUTE);

    const rowKey = row?.dataset.searchKey;

    if (
        cell === undefined ||
        !cell.contains(start) ||
        path === null ||
        path === undefined ||
        rowKey === undefined
    ) {
        return null;
    }

    const before = document.createRange();
    before.selectNodeContents(cell);
    before.setEnd(start, range.startOffset);

    // The searched text is trimmed, so the match starts after any selected leading space.
    const selected = range.toString();
    const leading = selected.length - selected.trimStart().length;

    return { path, rowKey, offset: before.toString().length + leading };
}

/** Whether a match is the occurrence the selection behind a search started at. */
export function isAnchoredMatch(
    match: DiffSearchMatch,
    anchor: DiffSearchAnchor,
): boolean {
    return (
        match.path === anchor.path &&
        diffRowKey(match.diffIndex, match.hunkIndex, match.lineIndex) ===
            anchor.rowKey &&
        match.start <= anchor.offset &&
        anchor.offset < match.end
    );
}
