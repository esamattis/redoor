/*
 * Search across every diff of a list. It replaces find in page for diffs because find in page
 * only sees text that is loaded and rendered, while a diff list keeps files collapsed, folds
 * unchanged lines and fetches worktree patches only when they are opened. The search reads
 * the parsed patches instead, only their changed hunks, expands the file of
 * the match it steps to, and marks
 * matches with the CSS Custom Highlight API, which colours text without changing the DOM, so
 * the rows React renders are never touched.
 */
import React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import { gitDiffQueryOptions, prefetchGitDiffs } from "#ui/queries";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { parseDiff } from "#ui/utils/diff-parse";
import type { DiffFile } from "#ui/utils/diff-parse";
import { diffMatchKey, findDiffMatches } from "#ui/utils/diff-search";
import type {
    DiffSearchFile,
    DiffSearchMatch,
    DiffSearchResult,
} from "#ui/utils/diff-search";
import { formatKeyChord, isTerminalInputTarget } from "#ui/utils/keyboard";
import {
    DiffSearchHighlighter,
    firstMatchOnScreen,
    isAnchoredMatch,
} from "#ui/utils/diff-search-highlighter";
import type { DiffSearchAnchor } from "#ui/utils/diff-search-highlighter";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { GitDiffResult } from "#bindings/GitDiffResult";

/**
 * Where the search reads one file's patch. A commit's patches arrive with the commit and a
 * Sync compare has its patch at hand, while a worktree file's patch is fetched on demand
 * into the same query its card uses, so the search and the card share one download.
 */
export type DiffSearchSource =
    | { type: "result"; result: GitDiffResult }
    | { type: "patch"; unifiedDiff: string; fullContext: boolean }
    | { type: "worktree"; agent: Agent; path: string; mode: GitDiffMode };

/** One file of the list as the search sees it. */
export interface DiffSearchListFile {
    path: string;
    source: DiffSearchSource;
    /** Whether its card shows similar lines as one row, which changes the rows' text. */
    mergeModifiedLines: boolean;
}

/**
 * A query the reader asked for, typed or searched from selected text, which steps to a match
 * once it has been searched. A query from selected text names where the selection was, so
 * that occurrence becomes current where it already is on screen, instead of scrolling to
 * another one.
 */
export interface RequestedQuery {
    text: string;
    anchor: DiffSearchAnchor | null;
}

/**
 * What a file holds for the search: a patch to search, nothing to search (an untracked or
 * unchanged file), text that cannot be searched (binary or too large), or a patch still
 * loading.
 */
type SearchablePatch =
    | { state: "patch"; unifiedDiff: string; fullContext: boolean }
    | { state: "none" }
    | { state: "unsearchable" }
    | { state: "loading" };

/** Reads what a Git comparison result offers the search. */
function resultPatch(result: GitDiffResult): SearchablePatch {
    switch (result.type) {
        case "text":
            return {
                state: "patch",
                unifiedDiff: result.unified_diff,
                fullContext: result.full_context,
            };
        case "no_changes":
        case "untracked":
        case "ignored":
            return { state: "none" };
        case "binary":
        case "too_large":
        case "unsupported_entry":
            return { state: "unsearchable" };
    }
}

/**
 * Every card's match count, shared by the search and the cards. It lives outside React state
 * so a change re-renders only the cards whose count changed, not the whole list of expanded
 * patches.
 */
export class DiffSearchStore {
    private counts: ReadonlyMap<string, number> = new Map();
    private readonly listeners = new Set<() => void>();
    private readonly searchRequestListeners = new Set<
        (request: RequestedQuery) => void
    >();

    /** Registers a listener for `useSyncExternalStore`. */
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    };

    /** How many matches a card holds, so a collapsed card shows it has some. */
    getCount = (path: string) => this.counts.get(path) ?? 0;

    setCounts(counts: ReadonlyMap<string, number>) {
        this.counts = counts;
        this.notify();
    }

    /**
     * Registers the search bar for searches started elsewhere in the list, such as from
     * selected text. A request is an event rather than state, so it is delivered once and
     * never replayed to a bar that mounts later.
     */
    onSearchRequest = (listener: (request: RequestedQuery) => void) => {
        this.searchRequestListeners.add(listener);

        return () => {
            this.searchRequestListeners.delete(listener);
        };
    };

    /** Opens the search bar on a query as if the reader had typed it. */
    requestSearch(request: RequestedQuery) {
        for (const listener of this.searchRequestListeners) {
            listener(request);
        }
    }

    private notify() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

/** The search store of the list around a card, or null outside a diff list. */
export const DiffSearchStoreContext =
    React.createContext<DiffSearchStore | null>(null);

/** A subscription for cards outside any list, whose counts never change. */
const noSubscription = () => () => {};

/** How many matches the search found in a card. */
export function useDiffSearchMatchCount(path: string): number {
    const store = React.useContext(DiffSearchStoreContext);

    return React.useSyncExternalStore(store?.subscribe ?? noSubscription, () =>
        store === null ? 0 : store.getCount(path),
    );
}

/** What the reader typed and whether the bar is open, kept per history entry. */
type DiffSearchState = { open: boolean; query: string };

const searchStates = new HistoryEntryStore<DiffSearchState>();

/** How long typing must pause before the search runs, so each keystroke stays instant. */
const SEARCH_DELAY_MS = 200;

/** Reads a worktree query's state as what it offers the search. */
function worktreePatch(result: {
    data: { diffs: Array<{ result: GitDiffResult }> } | undefined;
    isError: boolean;
}): SearchablePatch {
    const diffResult = result.data?.diffs[0]?.result;

    if (diffResult !== undefined) {
        return resultPatch(diffResult);
    }

    if (result.isError) {
        return { state: "unsearchable" };
    }

    // A response without the file says it has nothing to compare.
    return result.data === undefined ? { state: "loading" } : { state: "none" };
}

/**
 * Reads the worktree queries' states. It is a module function, so TanStack Query keeps its
 * result and shares it structurally, and the search reruns only when a patch changes.
 */
function combineWorktreePatches(
    results: Array<{
        data: { diffs: Array<{ result: GitDiffResult }> } | undefined;
        isError: boolean;
    }>,
): SearchablePatch[] {
    return results.map(worktreePatch);
}

/**
 * Reads every file's patch, in the order of `files`: the ones at hand directly and the
 * worktree ones from the query cache. The worktree queries are only observed, never fetched
 * here; the search fetches the missing ones in batches when it opens or its input gets focus.
 */
function useSearchablePatches(files: DiffSearchListFile[]): SearchablePatch[] {
    const worktreePatches = useQueries({
        queries: files.flatMap((file) =>
            file.source.type === "worktree"
                ? [
                      {
                          ...gitDiffQueryOptions(
                              file.source.agent,
                              [file.source.path],
                              file.source.mode,
                          ),
                          enabled: false,
                      },
                  ]
                : [],
        ),
        combine: combineWorktreePatches,
    });

    return React.useMemo(() => {
        let worktreeIndex = 0;

        return files.map((file): SearchablePatch => {
            if (file.source.type === "result") {
                return resultPatch(file.source.result);
            }

            if (file.source.type === "patch") {
                return {
                    state: "patch",
                    unifiedDiff: file.source.unifiedDiff,
                    fullContext: file.source.fullContext,
                };
            }

            // The worktree queries are observed in the order of the worktree files.
            const patch = worktreePatches[worktreeIndex];
            worktreeIndex += 1;

            return patch ?? { state: "loading" };
        });
    }, [files, worktreePatches]);
}

/** Fetches the worktree patches not cached yet, so the search can read every file. */
function loadWorktreePatches(
    queryClient: ReturnType<typeof useQueryClient>,
    files: DiffSearchListFile[],
) {
    const groups = new Map<
        string,
        { agent: Agent; mode: GitDiffMode; paths: string[] }
    >();

    for (const file of files) {
        if (file.source.type !== "worktree") {
            continue;
        }

        const key = JSON.stringify([file.source.agent.id, file.source.mode]);
        const group = groups.get(key);

        if (group === undefined) {
            groups.set(key, {
                agent: file.source.agent,
                mode: file.source.mode,
                paths: [file.source.path],
            });
        } else {
            group.paths.push(file.source.path);
        }
    }

    for (const group of groups.values()) {
        prefetchGitDiffs({
            queryClient,
            agent: group.agent,
            files: group.paths,
            mode: group.mode,
        });
    }
}

/** Counts each card's matches for the badges in their headers. */
function countsByPath(matches: DiffSearchMatch[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const match of matches) {
        counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
    }

    return counts;
}

/** What the bar says about the search, which is also announced to screen readers. */
function statusText(options: {
    query: string;
    result: DiffSearchResult;
    currentIndex: number;
    loading: number;
}): string {
    const { query, result, currentIndex, loading } = options;
    const total = `${String(result.matches.length)}${result.truncated ? "+" : ""}`;

    if (query === "") {
        return loading > 0 ? `Loading ${String(loading)} diffs` : "";
    }

    if (result.matches.length === 0) {
        return loading > 0 ? `Loading ${String(loading)} diffs` : "No matches";
    }

    if (currentIndex === -1) {
        return result.matches.length === 1 ? "1 match" : `${total} matches`;
    }

    return `${String(currentIndex + 1)} of ${total}`;
}

/** Caches parsed diffs by content and options so typing a query does not re-parse unchanged patches. */
const parsedDiffCache = new Map<string, DiffFile[]>();
const MAX_PARSED_DIFF_CACHE = 200;

/** Parses one unified diff once per `(unifiedDiff, mergeModifiedLines, fullContext)` tuple. */
function parseDiffCached(
    unifiedDiff: string,
    mergeModifiedLines: boolean,
    fullContext: boolean,
): DiffFile[] {
    const key = JSON.stringify([unifiedDiff, mergeModifiedLines, fullContext]);
    const cached = parsedDiffCache.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const diffFiles = parseDiff(unifiedDiff, {
        mergeModifiedLines,
        fullContext,
    });

    if (parsedDiffCache.size >= MAX_PARSED_DIFF_CACHE) {
        const oldestKey = parsedDiffCache.keys().next().value;

        if (oldestKey !== undefined) {
            parsedDiffCache.delete(oldestKey);
        }
    }

    parsedDiffCache.set(key, diffFiles);

    return diffFiles;
}

/**
 * Runs the search: reads every file's patch, waits for typing to pause, parses each patch the
 * way its card does and finds the matches. Files still loading and files that cannot be
 * searched are counted, so the bar can say what the result does not cover yet.
 */
function useDiffSearchResult(files: DiffSearchListFile[], query: string) {
    const patches = useSearchablePatches(files);

    const [searched, setSearched] = React.useState(query);

    React.useEffect(() => {
        const timer = setTimeout(() => setSearched(query), SEARCH_DELAY_MS);

        return () => clearTimeout(timer);
    }, [query]);

    let loading = 0;
    let unsearchable = 0;

    for (const patch of patches) {
        if (patch.state === "loading") {
            loading += 1;
        } else if (patch.state === "unsearchable") {
            unsearchable += 1;
        }
    }

    const result = React.useMemo(() => {
        if (searched === "") {
            return findDiffMatches([], "");
        }

        const searchFiles: DiffSearchFile[] = [];

        files.forEach((file, index) => {
            const patch = patches[index];

            if (patch?.state !== "patch") {
                return;
            }

            // Parsed with the card's own options, so the rows match the ones it renders.
            const diffFiles = parseDiffCached(
                patch.unifiedDiff,
                file.mergeModifiedLines,
                patch.fullContext,
            );

            searchFiles.push({ path: file.path, diffFiles });
        });

        return findDiffMatches(searchFiles, searched);
    }, [searched, files, patches]);

    return { searched, result, loading, unsearchable };
}

/**
 * Steps through the matches: keeps the current one, marks every match on the page through
 * the highlighter, and shares the counts and the current match with the cards through the
 * store. Stepping to a match expands its file and scrolls to it once
 * its row renders, unless the reader selected that very match on screen.
 */
function useDiffSearchNavigation(options: {
    search: ReturnType<typeof useDiffSearchResult>;
    store: DiffSearchStore;
    listRef: React.RefObject<HTMLElement | null>;
    expand: (path: string) => void;
    /** The query last typed or requested, which tells it from a restored query. */
    typedQuery: React.RefObject<RequestedQuery | null>;
    /** Counts requests from selected text, which may repeat the query being searched. */
    requestCount: number;
}) {
    const { listRef, typedQuery } = options;
    const { searched, result, loading } = options.search;
    const store = options.store;
    const expand = options.expand;
    const [currentKey, setCurrentKey] = React.useState<string | null>(null);

    const currentIndex =
        currentKey === null
            ? -1
            : result.matches.findIndex(
                  (match) => diffMatchKey(match) === currentKey,
              );

    // Drop a match that a newer result no longer has so returning via history never revives it.
    if (currentKey !== null && currentIndex === -1) {
        setCurrentKey(null);
    }

    const [highlighter, setHighlighter] =
        React.useState<DiffSearchHighlighter | null>(null);

    React.useEffect(() => {
        const root = listRef.current;

        if (root === null) {
            return;
        }

        const created = new DiffSearchHighlighter(root);
        setHighlighter(created);

        return () => {
            created.dispose();
            store.setCounts(new Map());
        };
    }, [listRef, store]);

    React.useEffect(() => {
        highlighter?.setMatches(result.matches);
        store.setCounts(countsByPath(result.matches));
    }, [highlighter, result, store]);

    const goTo = React.useCallback(
        (match: DiffSearchMatch, scroll: boolean) => {
            setCurrentKey(diffMatchKey(match));
            expand(match.path);
            highlighter?.setCurrent(match, scroll);
        },
        [expand, highlighter],
    );

    // Clear the current-match highlight when no match is active. It runs before the jump
    // below, so a new query's first match replaces the old one instead of being cleared with it.
    React.useEffect(() => {
        if (currentIndex === -1) {
            highlighter?.setCurrent(null, false);
        }
    }, [currentIndex, highlighter]);

    // A query typed in this bar jumps to its first match on screen once it has one, which may
    // only be after the patches load. A query searched from selected text makes the selected
    // occurrence current without scrolling, since the reader is already looking at it. A query
    // restored by back, also while the bar stays open between commits, does neither, so the
    // restored scroll position stays where the reader left it.
    const jumpPending = React.useRef<RequestedQuery | null>(null);
    const lastSearched = React.useRef(searched);
    const requestCount = options.requestCount;

    // Runs on a new request too, since selecting another occurrence of the searched text
    // leaves the query as it is and must still move the current match.
    React.useEffect(() => {
        const typed = typedQuery.current;

        if (searched !== "" && searched === typed?.text) {
            jumpPending.current = typed;
            // Typing jumps once; the same text restored later by back or forward must not.
            typedQuery.current = null;
        } else if (searched !== lastSearched.current) {
            jumpPending.current = null;
        }

        lastSearched.current = searched;
    }, [searched, typedQuery, requestCount]);

    React.useEffect(() => {
        const root = listRef.current;
        const pending = jumpPending.current;

        if (pending === null || root === null || highlighter === null) {
            return;
        }

        const anchor = pending.anchor;

        const index =
            anchor === null
                ? firstMatchOnScreen(root, result.matches)
                : result.matches.findIndex((match) =>
                      isAnchoredMatch(match, anchor),
                  );

        const match = result.matches[index];

        if (match !== undefined) {
            jumpPending.current = null;
            goTo(match, anchor === null);
        } else if (loading === 0) {
            jumpPending.current = null;
        }
    }, [result, loading, goTo, highlighter, listRef, requestCount]);

    /** Steps forwards or backwards, starting from the screen when no match is current yet. */
    const step = (direction: 1 | -1) => {
        const count = result.matches.length;
        const root = listRef.current;

        if (count === 0 || root === null) {
            return;
        }

        const next =
            currentIndex === -1
                ? firstMatchOnScreen(root, result.matches)
                : (currentIndex + direction + count) % count;

        const match = result.matches[next];

        if (match !== undefined) {
            goTo(match, true);
        }
    };

    return { currentIndex, step };
}

/**
 * The open search bar and the search behind it. It mounts only while open, so a closed search
 * observes no queries, parses nothing and leaves no highlights behind.
 */
function DiffSearchBar(props: {
    files: DiffSearchListFile[];
    query: string;
    onQueryChange: (query: string) => void;
    onClose: () => void;
    /** Changes whenever the bar must take focus again, such as on a repeated Ctrl+F. */
    focusRequest: number;
    inputRef: React.RefObject<HTMLInputElement | null>;
    /**
     * The query last typed or requested. The search around the bar owns it, so a query
     * requested while the bar is closed still counts as typed once the bar mounts.
     */
    typedQuery: React.RefObject<RequestedQuery | null>;
    requestCount: number;
    store: DiffSearchStore;
    listRef: React.RefObject<HTMLElement | null>;
    /** Expands a collapsed card, so the match being stepped to can render. */
    expand: (path: string) => void;
}) {
    const { inputRef, typedQuery, listRef } = props;
    const queryClient = useQueryClient();
    const search = useDiffSearchResult(props.files, props.query);

    const navigation = useDiffSearchNavigation({
        search,
        store: props.store,
        listRef,
        expand: props.expand,
        typedQuery,
        requestCount: props.requestCount,
    });

    // Only a request focuses the input, so a bar restored by back does not open a phone's
    // keyboard by itself.
    React.useLayoutEffect(() => {
        const input = inputRef.current;

        if (props.focusRequest === 0 || input === null) {
            return;
        }

        input.focus();
        input.select();
    }, [props.focusRequest, inputRef]);

    const status = statusText({
        query: search.searched,
        result: search.result,
        currentIndex: navigation.currentIndex,
        loading: search.loading,
    });

    const hasMatches = search.result.matches.length > 0;
    const unsearchable = search.unsearchable;

    return (
        <div
            role="search"
            aria-label="Search in diffs"
            className="group pointer-events-auto flex w-full max-w-lg flex-col gap-1 rounded-lg border border-slate-700 bg-surface-raised p-2 shadow-lg shadow-black/40"
        >
            <div className="flex items-center gap-1">
                <InputControl
                    ref={inputRef}
                    type="search"
                    aria-label="Search in diffs"
                    placeholder="Search in diffs"
                    value={props.query}
                    codeMode
                    enterKeyHint="search"
                    // Focus is when the reader means to search, so every patch loads then.
                    onFocus={() =>
                        loadWorktreePatches(queryClient, props.files)
                    }
                    onChange={(event) => {
                        typedQuery.current = {
                            text: event.target.value,
                            anchor: null,
                        };
                        props.onQueryChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            props.onClose();
                        } else if (event.key === "Enter") {
                            event.preventDefault();
                            navigation.step(event.shiftKey ? -1 : 1);
                        }
                    }}
                    className="h-10 min-w-0 flex-1 px-3 py-0 text-sm placeholder:text-slate-500"
                />
                <span
                    role="status"
                    aria-label="Diff search status"
                    className="w-20 shrink-0 text-center text-xs text-slate-400 tabular-nums"
                >
                    {status}
                </span>
                <IconButton
                    type="button"
                    variant="ghost"
                    size="md"
                    label="Previous match"
                    tooltip="Previous match (Shift+Enter)"
                    disabled={!hasMatches}
                    onClick={() => navigation.step(-1)}
                >
                    <ChevronUp className="h-5 w-5" aria-hidden="true" />
                </IconButton>
                <IconButton
                    type="button"
                    variant="ghost"
                    size="md"
                    label="Next match"
                    tooltip="Next match (Enter)"
                    disabled={!hasMatches}
                    onClick={() => navigation.step(1)}
                >
                    <ChevronDown className="h-5 w-5" aria-hidden="true" />
                </IconButton>
                <IconButton
                    type="button"
                    variant="ghost"
                    size="md"
                    label="Close search"
                    tooltip="Close search (Escape)"
                    onClick={props.onClose}
                >
                    <X className="h-5 w-5" aria-hidden="true" />
                </IconButton>
            </div>
            {/*
              The bar takes the find shortcut, so readers who want the browser's own find in page
              are told the key still reaches it. It shows only while typing in the bar, where a
              second press goes to the browser, and only with a keyboard at hand.
            */}
            <p className="hidden px-1 text-xs text-slate-400 pointer-fine:group-has-[input:focus]:block">
                Press {formatKeyChord({ key: "f", mod: true })} again to search
                the page
            </p>
            {/* Files that cannot be searched are named, so no match never means "not looked at". */}
            {unsearchable === 0 ? null : (
                <p className="px-1 text-xs text-slate-500">
                    {unsearchable === 1
                        ? "1 file could not be searched (binary, too large or failed to load)."
                        : `${String(unsearchable)} files could not be searched (binary, too large or failed to load).`}
                </p>
            )}
        </div>
    );
}

/**
 * The search of a diff list: a floating button, or the open bar, pinned to the bottom of the
 * screen while the list is in view. Ctrl/Cmd+F opens it, and a second Ctrl/Cmd+F while its
 * input has focus falls through to the browser's own find in page, for text outside the
 * diffs. The query and whether the bar is open are kept per history entry, so back from a
 * file shows the search as it was.
 */
export function DiffSearch(props: {
    /** The list's identity, such as one commit; the query carries over to the next one. */
    scope: string;
    /** The files the list shows, in page order; ones its filter hides are not searched. */
    files: DiffSearchListFile[];
    store: DiffSearchStore;
    listRef: React.RefObject<HTMLElement | null>;
    expand: (path: string) => void;
}) {
    const [state, update] = useHistoryEntryState<DiffSearchState>({
        store: searchStates,
        scope: props.scope,
        initial: (previous) => ({
            open: previous?.open ?? false,
            query: previous?.query ?? "",
        }),
    });

    const inputRef = React.useRef<HTMLInputElement>(null);
    const typedQuery = React.useRef<RequestedQuery | null>(null);
    const [focusRequest, setFocusRequest] = React.useState(0);
    const [requestCount, setRequestCount] = React.useState(0);
    const queryClient = useQueryClient();

    const open = () => {
        update((previous) => ({ ...previous, open: true }));
        setFocusRequest((count) => count + 1);
        loadWorktreePatches(queryClient, props.files);
    };

    // A search requested from selected text counts as typed, so its selected occurrence
    // becomes current. It leaves focus where it is, because focusing the input would open a
    // phone's keyboard over the diff the reader is looking at, and the bar's buttons step
    // through the matches.
    const searchRequested = React.useEffectEvent((request: RequestedQuery) => {
        typedQuery.current = request;
        setRequestCount((count) => count + 1);
        // An earlier Ctrl+F's request would otherwise focus the bar again when it mounts.
        setFocusRequest(0);
        update(() => ({ open: true, query: request.text }));
        loadWorktreePatches(queryClient, props.files);
    });

    React.useEffect(
        () =>
            props.store.onSearchRequest((request) => searchRequested(request)),
        [props.store],
    );

    useShortcut(
        {
            name: "diff-search-open",
            phase: "bubble",
            priority: shortcutPriority.view,
            match: (event) =>
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey &&
                event.key.toLowerCase() === "f" &&
                !event.defaultPrevented &&
                !isTerminalInputTarget(event.target) &&
                // Pressed again in the search, the key goes to the browser's find in page.
                event.target !== inputRef.current,
            run: open,
        },
        // A list with nothing to search leaves the key to the browser.
        props.files.length > 0,
    );

    if (props.files.length === 0) {
        return null;
    }

    return (
        // A sticky row at the end of the list pins its content to the bottom of the screen
        // while the list scrolls under it. It keeps its own room below the last card, so at the
        // end of the list it never covers that card's controls.
        <div className="pointer-events-none sticky bottom-3 z-20 mt-3">
            <div className="flex w-full justify-end px-2 @xl:px-0">
                {state.open ? (
                    <DiffSearchBar
                        files={props.files}
                        query={state.query}
                        onQueryChange={(query) =>
                            update((previous) => ({ ...previous, query }))
                        }
                        onClose={() =>
                            update((previous) => ({ ...previous, open: false }))
                        }
                        focusRequest={focusRequest}
                        inputRef={inputRef}
                        typedQuery={typedQuery}
                        requestCount={requestCount}
                        store={props.store}
                        listRef={props.listRef}
                        expand={props.expand}
                    />
                ) : (
                    <IconButton
                        type="button"
                        variant="outline"
                        size="xl"
                        label="Search in diffs"
                        tooltip="Search in diffs (Ctrl/Cmd+F)"
                        className="pointer-events-auto h-11 w-11 rounded-full bg-surface-raised shadow-lg shadow-black/40"
                        onClick={open}
                    >
                        <Search className="h-5 w-5" aria-hidden="true" />
                    </IconButton>
                )}
            </div>
        </div>
    );
}
