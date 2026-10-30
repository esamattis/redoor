/*
 * Search across every diff of a list. It replaces find in page for diffs because find in page
 * only sees text that is loaded and rendered, while a diff list keeps files collapsed, folds
 * unchanged lines and fetches worktree patches only when they are opened. The search reads
 * the parsed patches instead, expands the file and fold of the match it steps to, and marks
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
import { parseDiff, type DiffFile } from "#ui/utils/diff-parse";
import {
    diffMatchKey,
    findDiffMatches,
    type DiffSearchFile,
    type DiffSearchMatch,
    type DiffSearchResult,
} from "#ui/utils/diff-search";
import { isTerminalInputTarget } from "#ui/utils/keyboard";
import {
    DiffSearchHighlighter,
    firstMatchOnScreen,
} from "#ui/utils/diff-search-highlighter";
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
 * The current match and every card's match count, shared by the search, the cards and the
 * diffs inside them. It lives outside React state so a change re-renders only the cards and
 * diffs whose own part changed, not the whole list of expanded patches.
 */
export class DiffSearchStore {
    private target: DiffSearchMatch | null = null;
    private counts: ReadonlyMap<string, number> = new Map();
    private readonly listeners = new Set<() => void>();

    /** Registers a listener for `useSyncExternalStore`. */
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    };

    /** The match the search stepped to, whose file and fold must be shown. */
    getTarget = () => this.target;

    /** How many matches a card holds, so a collapsed card shows it has some. */
    getCount = (path: string) => this.counts.get(path) ?? 0;

    setTarget(target: DiffSearchMatch | null) {
        this.target = target;
        this.notify();
    }

    setCounts(counts: ReadonlyMap<string, number>) {
        this.counts = counts;
        this.notify();
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

/** The path of the card around a diff, which the search names its matches by. */
export const DiffSearchCardContext = React.createContext<string | null>(null);

/** A subscription for diffs outside any list, which never change. */
const noSubscription = () => () => {};

/**
 * The current match when it is in this file of the card's patch, else null, so a diff
 * re-renders only when the search steps into or out of it.
 */
export function useDiffSearchTarget(diffIndex: number): DiffSearchMatch | null {
    const store = React.useContext(DiffSearchStoreContext);
    const path = React.useContext(DiffSearchCardContext);

    return React.useSyncExternalStore(
        store?.subscribe ?? noSubscription,
        () => {
            const target = store?.getTarget() ?? null;

            return target !== null &&
                target.path === path &&
                target.diffIndex === diffIndex
                ? target
                : null;
        },
    );
}

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

/**
 * Runs the search: reads every file's patch, waits for typing to pause, parses each patch the
 * way its card does and finds the matches. Files still loading and files that cannot be
 * searched are counted, so the bar can say what the result does not cover yet.
 */
function useDiffSearchResult(files: DiffSearchListFile[], query: string) {
    const patches = useSearchablePatches(files);

    // The parsed patches of this search, keyed like the card's own parse, so a file is parsed
    // once however many queries are typed. It is dropped when the search closes.
    const parsed = React.useRef(new Map<string, DiffFile[]>());

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
            const key = JSON.stringify([
                patch.unifiedDiff,
                file.mergeModifiedLines,
                patch.fullContext,
            ]);

            let diffFiles = parsed.current.get(key);

            if (diffFiles === undefined) {
                diffFiles = parseDiff(patch.unifiedDiff, {
                    mergeModifiedLines: file.mergeModifiedLines,
                    fullContext: patch.fullContext,
                });
                parsed.current.set(key, diffFiles);
            }

            searchFiles.push({ path: file.path, diffFiles });
        });

        return findDiffMatches(searchFiles, searched);
    }, [searched, files, patches]);

    return { searched, result, loading, unsearchable };
}

/**
 * Steps through the matches: keeps the current one, marks every match on the page through
 * the highlighter, and shares the counts and the current match with the cards through the
 * store. Stepping to a match expands its file, which reveals its fold, and scrolls to it once
 * its row renders.
 */
function useDiffSearchNavigation(options: {
    search: ReturnType<typeof useDiffSearchResult>;
    store: DiffSearchStore;
    listRef: React.RefObject<HTMLElement | null>;
    expand: (path: string) => void;
    /** The query last typed in the input, which tells typing from a restored query. */
    typedQuery: React.RefObject<string | null>;
}) {
    const { searched, result, loading } = options.search;
    const store = options.store;
    const listRef = options.listRef;
    const expand = options.expand;
    const [currentKey, setCurrentKey] = React.useState<string | null>(null);

    const currentIndex =
        currentKey === null
            ? -1
            : result.matches.findIndex(
                  (match) => diffMatchKey(match) === currentKey,
              );

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
            store.setTarget(null);
            store.setCounts(new Map());
        };
    }, [listRef, store]);

    React.useEffect(() => {
        highlighter?.setMatches(result.matches);
        store.setCounts(countsByPath(result.matches));
    }, [highlighter, result, store]);

    const goTo = React.useCallback(
        (match: DiffSearchMatch) => {
            setCurrentKey(diffMatchKey(match));
            expand(match.path);
            store.setTarget(match);
            highlighter?.setCurrent(match, true);
        },
        [expand, highlighter, store],
    );

    // A match that a newer result no longer has is no longer current. It runs before the jump
    // below, so a new query's first match replaces the old one instead of being cleared with it.
    React.useEffect(() => {
        if (currentKey !== null && currentIndex === -1) {
            setCurrentKey(null);
            store.setTarget(null);
            highlighter?.setCurrent(null, false);
        }
    }, [currentKey, currentIndex, highlighter, store]);

    // A query typed in this bar jumps to its first match on screen once it has one, which may
    // only be after the patches load. A query restored by back, also while the bar stays open
    // between commits, does not, so the restored scroll position stays where the reader left it.
    const jumpPending = React.useRef(false);
    const lastSearched = React.useRef(searched);
    const typedQuery = options.typedQuery;

    React.useEffect(() => {
        if (searched !== lastSearched.current) {
            lastSearched.current = searched;
            jumpPending.current =
                searched !== "" && searched === typedQuery.current;

            // Typing jumps once; the same text restored later by back or forward must not.
            if (searched === typedQuery.current) {
                typedQuery.current = null;
            }
        }
    }, [searched, typedQuery]);

    React.useEffect(() => {
        const root = listRef.current;

        if (!jumpPending.current || root === null || highlighter === null) {
            return;
        }

        const first = result.matches[firstMatchOnScreen(root, result.matches)];

        if (first !== undefined) {
            jumpPending.current = false;
            goTo(first);
        } else if (loading === 0) {
            jumpPending.current = false;
        }
    }, [result, loading, goTo, highlighter, listRef]);

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
            goTo(match);
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
    store: DiffSearchStore;
    listRef: React.RefObject<HTMLElement | null>;
    /** Expands a collapsed card, so the match being stepped to can render. */
    expand: (path: string) => void;
}) {
    const queryClient = useQueryClient();
    const search = useDiffSearchResult(props.files, props.query);
    const typedQuery = React.useRef<string | null>(null);

    const navigation = useDiffSearchNavigation({
        search,
        store: props.store,
        listRef: props.listRef,
        expand: props.expand,
        typedQuery,
    });

    // Only a request focuses the input, so a bar restored by back does not open a phone's
    // keyboard by itself.
    React.useLayoutEffect(() => {
        const input = props.inputRef.current;

        if (props.focusRequest === 0 || input === null) {
            return;
        }

        input.focus();
        input.select();
    }, [props.focusRequest, props.inputRef]);

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
            className="pointer-events-auto flex w-full max-w-lg flex-col gap-1 rounded-lg border border-slate-700 bg-surface-raised p-2 shadow-lg shadow-black/40"
        >
            <div className="flex items-center gap-1">
                <InputControl
                    ref={props.inputRef}
                    type="search"
                    aria-label="Search in diffs"
                    placeholder="Search in diffs"
                    value={props.query}
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    // Focus is when the reader means to search, so every patch loads then.
                    onFocus={() =>
                        loadWorktreePatches(queryClient, props.files)
                    }
                    onChange={(event) => {
                        typedQuery.current = event.target.value;
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
    const [focusRequest, setFocusRequest] = React.useState(0);
    const queryClient = useQueryClient();

    const open = () => {
        update((previous) => ({ ...previous, open: true }));
        setFocusRequest((count) => count + 1);
        loadWorktreePatches(queryClient, props.files);
    };

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
