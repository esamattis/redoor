import * as React from "react";
import {
    hashKey,
    useQuery,
    type QueryKey,
    type UseQueryResult,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
    CaseLower,
    CaseSensitive,
    Eye,
    EyeOff,
    Folder,
    FolderGit2,
    GitBranch,
    Regex,
} from "lucide-react";

import type { CaseSensitivity } from "#bindings/CaseSensitivity";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import { type Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { Dialog } from "#ui/components/dialog";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import { PathBreadcrumbs } from "#ui/components/path-breadcrumbs";
import {
    SearchResultList,
    type SearchResultTarget,
} from "#ui/components/search-results";
import { ToggleButton } from "#ui/components/toggle-button";
import { Tooltip } from "#ui/components/tooltip";
import {
    contentGrepQueryOptions,
    fileSearchQueryOptions,
    gitContextQueryOptions,
    type ContentGrepParams,
} from "#ui/queries";
import type { AgentSearch } from "#ui/agent-search";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import { useAgentSearchNavigation } from "#ui/search-navigation";
import {
    useBrowserLocation,
    type BrowserLocation,
} from "#ui/use-browser-location";
import { useUserState } from "#ui/user-state";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { isPlainKey } from "#ui/utils/keyboard";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";

const agentRoute = getRouteApi("/_app/agents/$deviceName");

/** Cycles smart → sensitive → insensitive so the control can name the next click. */
const nextCaseSensitivity = {
    smart: "sensitive",
    sensitive: "insensitive",
    insensitive: "smart",
} satisfies Record<CaseSensitivity, CaseSensitivity>;

/** Accessible name stays on the current mode so screen readers can hear the applied rule. */
const caseSensitivityLabel = {
    smart: "Case: smart",
    sensitive: "Case: sensitive",
    insensitive: "Case: insensitive",
} satisfies Record<CaseSensitivity, string>;

/** Tooltip copy names the mode the next click will select. */
const caseSensitivityNextTooltip = {
    smart: "Click to match exact letter case",
    sensitive: "Click to ignore letter case",
    insensitive: "Click to use smart case",
} satisfies Record<CaseSensitivity, string>;

/** Reads worktree root from already-loaded browser context so searching never probes git again. */
function gitRootFromContext(gitContext: GitContextResponse | undefined) {
    return gitContext?.status === "inside_worktree"
        ? gitContext.repository_root
        : null;
}

/** Derives the agent-wide search scope from the browsed location, with cwd as fallback. */
function useSearchScope(agent: Agent) {
    const browser = useBrowserLocation();

    // The browser route caches repository discovery under its requested path.
    const gitContextPath = browser?.isConnected ? browser.path : null;

    // Reading the cached context means searching never probes git again.
    const gitRootQuery = useQuery({
        ...gitContextQueryOptions(agent, gitContextPath ?? ""),
        enabled: gitContextPath !== null,
        select: gitRootFromContext,
    });

    return {
        directory: resolveSearchDirectory(agent, browser),
        gitRoot: gitRootQuery.data ?? null,
    };
}

/** Searches the directory on screen, the folder of the open file, or the agent's home. */
function resolveSearchDirectory(
    agent: Agent,
    browser: BrowserLocation | null,
): string | null {
    if (browser?.entry === "directory") {
        return browser.resolvedPath;
    }

    if (browser?.entry === "file" && browser.resolvedPath !== null) {
        return getImmediateParentPath(browser.resolvedPath) ?? "/";
    }

    return agent.status === "connected" ? agent.cwd : null;
}

/** Shared ?q= seeds the field; keystrokes stay local so the caret is not reset. */
function useSearchQuery(urlQuery: string | undefined) {
    const [query, setQuery] = React.useState(urlQuery ?? "");
    const [debouncedQuery, setDebouncedQuery] = React.useState(query);

    const [seededFrom, setSeededFrom] = React.useState(urlQuery);

    // Editor search and opened/shared URLs populate the input without controlling it. Seeding
    // while rendering, only when the URL value changes, avoids an effect and a frame that shows
    // the old text.
    if (seededFrom !== urlQuery) {
        setSeededFrom(urlQuery);
        setQuery(urlQuery ?? "");
    }

    React.useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), 200);

        return () => window.clearTimeout(timer);
    }, [query]);

    return { query, setQuery, debouncedQuery };
}

/** Cmd/Ctrl+K stays available in text controls; unmodified s does not intercept typing. */
function useOpenSearchShortcut(isOpen: boolean) {
    const { openSearch } = useAgentSearchNavigation();

    const open = () => {
        void openSearch();
    };

    useShortcut(
        {
            name: "open-search-command-k",
            phase: "bubble",
            priority: shortcutPriority.app,
            match: (event) =>
                event.key.toLowerCase() === "k" &&
                !event.altKey &&
                !event.shiftKey &&
                (event.metaKey || event.ctrlKey),
            run: open,
        },
        !isOpen,
    );

    useShortcut(
        {
            name: "open-search-s",
            phase: "bubble",
            priority: shortcutPriority.app,
            skipTypingTargets: true,
            match: (event) => isPlainKey(event, "s", { allowShift: true }),
            run: open,
        },
        !isOpen,
    );
}

/** The results a search showed, tagged with their mode so each query only takes its own kind. */
type SearchViewResults =
    | { mode: "path"; response: FileSearchResponse }
    | { mode: "content"; response: ContentGrepResponse };

/**
 * Where the reader left a search when they opened a result. Back shows the same results
 * instead of searching again, which could reorder the list under the reader and keep the
 * agent busy for nothing on a large tree.
 */
type SearchView = {
    /** Hash of the query key the results answer, so another query or option searches again. */
    queryHash: string;
    /** Kept here so the results outlive the query cache dropping results nobody observes. */
    results: SearchViewResults;
    /** How far the dialog was scrolled, since the dialog scrolls itself, not the page. */
    scrollTop: number;
    /** Which result link was opened, so arrow keys continue from it. */
    openedIndex: number;
};

/**
 * What a history entry remembers of its search. The view sits in an object because the store
 * cannot tell an undefined value from a missing one, and a dismissed view must stay dismissed.
 */
type RestoredSearch = { view?: SearchView };

/** Holds few entries, because content search results with context lines can be large. */
const restoredSearches = new HistoryEntryStore<RestoredSearch>(20);

/**
 * The view to restore on the history entry on screen. The open dialog mounts when it opens and
 * unmounts when it closes, so the entry is the one Back or Forward returned to, and opening a
 * result never carries the view over to the file's entry. A replace that keeps the dialog open,
 * such as writing the typed query into the URL, carries it over to the replacing entry.
 * Changing the search dismisses the view, so the same query typed again later searches.
 */
function useRestoredSearchView(options: {
    scope: string;
    resultsRef: React.RefObject<HTMLDivElement | null>;
    getResults: () => HTMLElement[];
}) {
    const placedView = React.useRef<SearchView>(undefined);

    const [restored, update] = useHistoryEntryState<RestoredSearch>({
        store: restoredSearches,
        scope: options.scope,
        initial: () => ({}),
    });

    const view = restored.view;

    // Puts the reader back where they left the results. It runs after the dialog's own effect,
    // which opens the dialog and focuses the search field, so the opened result keeps focus.
    // TanStack's scroll restoration cannot do this: the dialog scrolls itself and opens only
    // after the route renders. It checks after every render because the results may render
    // later than the view, for example once the search scope resolves.
    React.useEffect(() => {
        if (view === undefined || placedView.current === view) {
            return;
        }

        const link = options.getResults()[view.openedIndex];
        const dialog = options.resultsRef.current?.closest("dialog");

        if (link === undefined || !dialog) {
            return;
        }

        placedView.current = view;
        link.focus({ preventScroll: true });
        dialog.scrollTop = view.scrollTop;
    });

    return {
        view,
        dismiss: () => {
            if (view !== undefined) {
                update(() => ({}));
            }
        },
        /**
         * Stores the results and the place in them on the entry on screen. It must run before
         * a navigation replaces the entry, which carries the view over to the replacing one.
         */
        save: (
            results: SearchViewResults | undefined,
            queryKey: QueryKey,
            openedIndex: number,
        ) => {
            if (results === undefined) {
                return;
            }

            update(() => ({
                view: {
                    queryHash: hashKey(queryKey),
                    results,
                    scrollTop:
                        options.resultsRef.current?.closest("dialog")
                            ?.scrollTop ?? 0,
                    openedIndex,
                },
            }));
        },
    };
}

/** The results on screen, unless they are a previous query's shown while searching. */
function shownSearchResults(
    isContentSearch: boolean,
    pathSearch: UseQueryResult<FileSearchResponse>,
    contentSearch: UseQueryResult<ContentGrepResponse>,
): SearchViewResults | undefined {
    if (isContentSearch) {
        return contentSearch.data && !contentSearch.isPlaceholderData
            ? { mode: "content", response: contentSearch.data }
            : undefined;
    }

    return pathSearch.data && !pathSearch.isPlaceholderData
        ? { mode: "path", response: pathSearch.data }
        : undefined;
}

/**
 * The restored results for a query, if the view is for that exact query. While they are
 * shown the query is static, so neither its observer nor an invalidation, such as the one
 * every finished upload or edit sends, asks for them again. They are selected over the
 * cache, which may hold newer results of the same search run from another entry.
 */
function restoredSearchOptions<T>(
    response: T | undefined,
    view: SearchView | undefined,
    queryKey: QueryKey,
) {
    const matches =
        response !== undefined && view?.queryHash === hashKey(queryKey);

    return {
        initialData: matches ? response : undefined,
        select: matches ? (cached: T) => response ?? cached : undefined,
        staleTime: matches ? ("static" as const) : 0,
    };
}

/** Runs the search the dialog shows, keeping a restored view's results as they were. */
function useSearchQueries(options: {
    agent: Agent;
    directory: string;
    isContentSearch: boolean;
    canSearch: boolean;
    params: ContentGrepParams;
    directoriesOnly: boolean;
    view: SearchView | undefined;
}) {
    const view = options.view;
    const searchesPaths = options.canSearch && !options.isContentSearch;
    const searchesContent = options.canSearch && options.isContentSearch;

    // Path search keeps its own fields, so a content-only option never searches paths again.
    const pathOptions = fileSearchQueryOptions(
        options.agent,
        options.directory,
        {
            query: searchesPaths ? options.params.query : "",
            timeoutSeconds: options.params.timeoutSeconds,
            includeHidden: options.params.includeHidden,
            respectGitignore: options.params.respectGitignore,
            caseSensitivity: options.params.caseSensitivity,
            directoriesOnly: options.directoriesOnly,
        },
    );

    const contentOptions = contentGrepQueryOptions(
        options.agent,
        options.directory,
        {
            ...options.params,
            query: searchesContent ? options.params.query : "",
        },
    );

    const pathSearch = useQuery({
        ...pathOptions,
        ...restoredSearchOptions(
            view?.results.mode === "path" ? view.results.response : undefined,
            view,
            pathOptions.queryKey,
        ),
        enabled: searchesPaths,
    });

    const contentSearch = useQuery({
        ...contentOptions,
        ...restoredSearchOptions(
            view?.results.mode === "content"
                ? view.results.response
                : undefined,
            view,
            contentOptions.queryKey,
        ),
        enabled: searchesContent,
    });

    return {
        pathSearch,
        contentSearch,
        activeQueryKey: options.isContentSearch
            ? contentOptions.queryKey
            : pathOptions.queryKey,
    };
}

/**
 * Focuses and selects the query once a requested switch to content search has mounted its
 * field, so the reader can type what to find in a picked folder at once. The switch remounts
 * the field, which is why the request waits for the mode instead of acting immediately.
 */
function useQuerySelectionOnContentSearch(isContentSearch: boolean) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const requested = React.useRef(false);

    React.useEffect(() => {
        if (!isContentSearch || !requested.current) {
            return;
        }

        requested.current = false;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [isContentSearch]);

    return {
        inputRef,
        request: () => {
            requested.current = true;
        },
    };
}

/** Owns the single route-wide path and content search workflow. */
export function SearchDialog(props: { agent: Agent }) {
    const isOpen = agentRoute.useSearch({
        select: (search) => search.q !== undefined,
    });

    useOpenSearchShortcut(isOpen);

    // Mounting the dialog only while open binds its restored view to the entry it opened on.
    return isOpen ? <OpenSearchDialog agent={props.agent} /> : null;
}

/** The search dialog while the URL has it open. */
function OpenSearchDialog(props: { agent: Agent }) {
    const search = agentRoute.useSearch();
    const navigate = useNavigate();
    const { updateSearch } = useAgentSearchNavigation();
    const { directory, gitRoot } = useSearchScope(props.agent);
    const [userState, setUserState] = useUserState();
    const isContentSearch = search.mode === "content";
    const { query, setQuery, debouncedQuery } = useSearchQuery(search.q);

    const timeoutSeconds =
        search.timeout ?? userState.recursiveSearchTimeoutSeconds;

    const includeHidden =
        search.hidden ?? userState.recursiveSearchIncludeHidden;

    const respectGitignore =
        search.gitignore ?? userState.recursiveSearchRespectGitignore;

    const regex = search.regex ?? false;
    const directoriesOnly = search.dirs ?? false;
    const contextSize = search.context ?? 2;
    const caseSensitivity = search.case ?? "smart";
    const chosenDirectory = search.dir ?? null;

    // A folder the reader picked wins over the Git root, which wins over the browsed folder.
    const searchFromGitRoot =
        chosenDirectory === null &&
        gitRoot !== null &&
        (search.gitroot ?? false);

    const searchDirectory =
        chosenDirectory ?? (searchFromGitRoot ? gitRoot : directory);

    const resultsRef = React.useRef<HTMLDivElement>(null);
    const queryFocus = useQuerySelectionOnContentSearch(isContentSearch);

    const canSearch =
        props.agent.status === "connected" &&
        searchDirectory !== null &&
        debouncedQuery.trim() !== "";

    const getResults = React.useCallback(
        () =>
            resultsRef.current
                ? [...resultsRef.current.querySelectorAll<HTMLElement>("a")]
                : [],
        [],
    );

    const restored = useRestoredSearchView({
        scope: props.agent.id,
        resultsRef,
        getResults,
    });

    const { pathSearch, contentSearch, activeQueryKey } = useSearchQueries({
        agent: props.agent,
        directory: searchDirectory ?? "",
        isContentSearch,
        canSearch,
        params: {
            query: debouncedQuery,
            timeoutSeconds,
            includeHidden,
            respectGitignore,
            regex,
            contextSize,
            caseSensitivity,
        },
        directoriesOnly,
        view: restored.view,
    });

    useArrayKeyboardFocus(getResults, true, shortcutPriority.modal);

    /**
     * Snapshots the typed query onto this history entry, and the results with the place in
     * them, so Back can restore the search as the reader left it.
     */
    const openSelectedResult = async (
        target: SearchResultTarget,
        index: number,
    ) => {
        restored.save(
            shownSearchResults(isContentSearch, pathSearch, contentSearch),
            activeQueryKey,
            index,
        );

        if (query !== (search.q ?? "")) {
            await updateSearch({ q: query });
        }

        await navigate({
            ...browserRoute(props.agent, target.path),
            search: { line: target.line },
        });
    };

    /** A change the reader makes searches again, even if it leads back to the same query. */
    const changeSearch = (changes: AgentSearch, replace?: boolean) => {
        restored.dismiss();

        return updateSearch(changes, replace);
    };

    const close = () =>
        void updateSearch({
            q: undefined,
            mode: undefined,
            timeout: undefined,
            hidden: undefined,
            gitignore: undefined,
            regex: undefined,
            context: undefined,
            gitroot: undefined,
            dir: undefined,
            dirs: undefined,
            case: undefined,
        });

    /** Replaces the search scope with a folder the reader chose, keeping the query. */
    const searchInFolder = (folder: string) =>
        void changeSearch({ dir: folder, gitroot: undefined });

    /**
     * A folder picked from path results is where the reader wants to look inside files next.
     * The new entry lets Back return to the folder list.
     */
    const searchContentsOfFolder = (folder: string) => {
        queryFocus.request();
        void changeSearch(
            { dir: folder, gitroot: undefined, mode: "content" },
            false,
        );
    };

    /** Persists common traversal defaults while keeping the current URL shareable. */
    const updateOption = (
        changes: AgentSearch,
        preferenceChanges: Partial<typeof userState>,
    ) => {
        setUserState((current) => ({ ...current, ...preferenceChanges }));
        void changeSearch(changes);
    };

    return (
        <Dialog
            isOpen
            title="Search device"
            description={
                searchDirectory
                    ? undefined
                    : "Search is unavailable while this device is disconnected."
            }
            closeAriaLabel="Close search"
            size="search"
            onClose={close}
        >
            <div className="mt-4 grid gap-4">
                {searchDirectory ? (
                    <SearchScope
                        agent={props.agent}
                        directory={searchDirectory}
                        onDismissRestoredView={restored.dismiss}
                        onChange={searchInFolder}
                    />
                ) : null}
                <SearchControls
                    query={query}
                    isContentSearch={isContentSearch}
                    timeoutSeconds={timeoutSeconds}
                    includeHidden={includeHidden}
                    respectGitignore={respectGitignore}
                    regex={regex}
                    directoriesOnly={directoriesOnly}
                    contextSize={contextSize}
                    caseSensitivity={caseSensitivity}
                    gitRoot={gitRoot}
                    searchFromGitRoot={searchFromGitRoot}
                    disabled={directory === null}
                    queryInputRef={queryFocus.inputRef}
                    onModeChange={(checked) =>
                        void changeSearch(
                            { mode: checked ? "content" : undefined },
                            false,
                        )
                    }
                    onQueryChange={(next) => {
                        restored.dismiss();
                        setQuery(next);
                    }}
                    onUpdate={changeSearch}
                    onUpdateOption={updateOption}
                />
                <SearchStatus
                    isContentSearch={isContentSearch}
                    query={query}
                    debouncedQuery={debouncedQuery}
                    pathSearch={pathSearch}
                    contentSearch={contentSearch}
                />
                <SearchResultList
                    agent={props.agent}
                    resultsRef={resultsRef}
                    isContentSearch={isContentSearch}
                    pathResults={pathSearch.data?.results}
                    contentResults={contentSearch.data?.results}
                    onOpen={openSelectedResult}
                    onSearchInFolder={searchContentsOfFolder}
                />
            </div>
        </Dialog>
    );
}

/**
 * Shows the folder being searched as breadcrumbs, so the reader can widen the search to an
 * ancestor or type another folder without leaving the dialog. Segments are links that keep
 * the rest of the search, so a modified click opens the same search in a new tab.
 */
function SearchScope(props: {
    agent: Agent;
    directory: string;
    /** A changed scope must search again instead of showing a restored result list. */
    onDismissRestoredView: () => void;
    onChange: (directory: string) => void;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2 text-sm text-slate-400">
            <span className="shrink-0">Current folder: </span>
            {/* Padded tap targets of short segments overhang the row, so only the x axis scrolls. */}
            <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain py-1">
                <div className="flex w-max min-w-full items-center">
                    <PathBreadcrumbs
                        // A changed scope closes an open editor.
                        key={props.directory}
                        path={props.directory}
                        home={props.agent.cwd}
                        labels={{
                            navigation: "Search folder",
                            input: "Search folder path",
                            submit: "Search in this folder",
                            copy: "Copy search folder path",
                            edit: "Edit search folder",
                        }}
                        renderLink={(link) => (
                            <Link
                                to="."
                                hash
                                replace
                                search={(previous) => ({
                                    ...previous,
                                    dir: link.path,
                                    gitroot: undefined,
                                })}
                                aria-label={`Search in ${link.path}`}
                                className={link.className}
                                onClick={props.onDismissRestoredView}
                            >
                                {link.children}
                            </Link>
                        )}
                        onSubmitPath={props.onChange}
                    />
                </div>
            </div>
        </div>
    );
}

/** Groups search controls while exposing content-only options only in grep mode. */
function SearchControls(props: {
    query: string;
    isContentSearch: boolean;
    timeoutSeconds: number;
    includeHidden: boolean;
    respectGitignore: boolean;
    regex: boolean;
    directoriesOnly: boolean;
    contextSize: number;
    caseSensitivity: CaseSensitivity;
    gitRoot: string | null;
    searchFromGitRoot: boolean;
    disabled: boolean;
    queryInputRef: React.RefObject<HTMLInputElement | null>;
    onModeChange: (checked: boolean) => void;
    onQueryChange: (query: string) => void;
    onUpdate: (changes: AgentSearch) => Promise<void>;
    onUpdateOption: (
        changes: AgentSearch,
        preferences: Record<string, number | boolean>,
    ) => void;
}) {
    const queryLabel = props.isContentSearch
        ? "Text to find"
        : "File or folder name";

    const caseSensitivityIcon = {
        smart: <SmartCaseIcon className="h-4 w-4" />,
        sensitive: <CaseSensitive className="h-4 w-4" />,
        insensitive: <CaseLower className="h-4 w-4" />,
    } satisfies Record<CaseSensitivity, React.ReactNode>;

    return (
        <div className="grid gap-4">
            <fieldset className="grid gap-1.5">
                <legend className="text-xs font-medium text-slate-400">
                    Search by
                </legend>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-950/70 p-1 sm:w-80">
                    <ToggleButton
                        label="Search file paths"
                        pressed={!props.isContentSearch}
                        size="sm"
                        variant="subtle"
                        className="w-full"
                        onClick={() => props.onModeChange(false)}
                    >
                        File paths
                    </ToggleButton>
                    <ToggleButton
                        label="Search file contents"
                        pressed={props.isContentSearch}
                        size="sm"
                        variant="subtle"
                        className="w-full"
                        onClick={() => props.onModeChange(true)}
                    >
                        File contents
                    </ToggleButton>
                </div>
            </fieldset>

            <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                {queryLabel}
                <InputControl
                    key={props.isContentSearch ? "content" : "path"}
                    ref={props.queryInputRef}
                    autoFocus
                    type="search"
                    aria-label={
                        props.isContentSearch
                            ? "Search file contents"
                            : "Search file paths"
                    }
                    value={props.query}
                    disabled={props.disabled}
                    onChange={(event) =>
                        props.onQueryChange(event.target.value)
                    }
                    placeholder={
                        props.isContentSearch
                            ? "Text inside files"
                            : "Name or path pattern"
                    }
                    className="h-10 w-full text-sm font-normal"
                />
            </label>

            <div className="grid gap-2">
                <p className="text-xs font-medium text-slate-400">Options</p>
                <div className="grid gap-2 sm:flex sm:items-end">
                    <div className="flex flex-wrap gap-2">
                        <ToggleButton
                            label="Include hidden files and directories"
                            pressed={props.includeHidden}
                            tooltip={
                                props.includeHidden
                                    ? "Exclude hidden files and directories"
                                    : "Include hidden files and directories"
                            }
                            size="lg"
                            onClick={() =>
                                props.onUpdateOption(
                                    { hidden: !props.includeHidden },
                                    {
                                        recursiveSearchIncludeHidden:
                                            !props.includeHidden,
                                    },
                                )
                            }
                        >
                            {props.includeHidden ? (
                                <Eye className="h-4 w-4" />
                            ) : (
                                <EyeOff className="h-4 w-4" />
                            )}
                        </ToggleButton>
                        <ToggleButton
                            label="Respect .gitignore files"
                            pressed={props.respectGitignore}
                            tooltip={
                                props.respectGitignore
                                    ? "Include files ignored by .gitignore"
                                    : "Respect .gitignore files"
                            }
                            size="lg"
                            onClick={() =>
                                props.onUpdateOption(
                                    { gitignore: !props.respectGitignore },
                                    {
                                        recursiveSearchRespectGitignore:
                                            !props.respectGitignore,
                                    },
                                )
                            }
                        >
                            <GitBranch className="h-4 w-4" />
                        </ToggleButton>
                        <ModeOptionToggle
                            isContentSearch={props.isContentSearch}
                            regex={props.regex}
                            directoriesOnly={props.directoriesOnly}
                            onUpdate={props.onUpdate}
                        />
                        <IconButton
                            label={caseSensitivityLabel[props.caseSensitivity]}
                            tooltip={
                                caseSensitivityNextTooltip[
                                    props.caseSensitivity
                                ]
                            }
                            variant="outline"
                            size="xl"
                            className="bg-slate-900 hover:bg-transparent hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            onClick={() =>
                                void props.onUpdate({
                                    case: nextCaseSensitivity[
                                        props.caseSensitivity
                                    ],
                                })
                            }
                        >
                            {caseSensitivityIcon[props.caseSensitivity]}
                        </IconButton>
                        {props.gitRoot ? (
                            <GitRootToggle
                                pressed={props.searchFromGitRoot}
                                onUpdate={props.onUpdate}
                            />
                        ) : null}
                    </div>
                    <SearchNumberInputs
                        isContentSearch={props.isContentSearch}
                        timeoutSeconds={props.timeoutSeconds}
                        contextSize={props.contextSize}
                        onUpdate={props.onUpdate}
                        onUpdateOption={props.onUpdateOption}
                    />
                </div>
            </div>
        </div>
    );
}

/** The option only one search mode has: regular expressions for content, directories for paths. */
function ModeOptionToggle(props: {
    isContentSearch: boolean;
    regex: boolean;
    directoriesOnly: boolean;
    onUpdate: (changes: AgentSearch) => Promise<void>;
}) {
    if (props.isContentSearch) {
        return (
            <ToggleButton
                label="Use regular expressions"
                pressed={props.regex}
                tooltip={
                    props.regex
                        ? "Search as literal text"
                        : "Use regular expressions"
                }
                size="lg"
                onClick={() => void props.onUpdate({ regex: !props.regex })}
            >
                <Regex className="h-4 w-4" />
            </ToggleButton>
        );
    }

    return (
        <ToggleButton
            label="Search directories only"
            pressed={props.directoriesOnly}
            tooltip={
                props.directoriesOnly
                    ? "Search files and directories"
                    : "Search directories only"
            }
            size="lg"
            onClick={() =>
                void props.onUpdate({
                    dirs: props.directoriesOnly ? undefined : true,
                })
            }
        >
            <Folder className="h-4 w-4" />
        </ToggleButton>
    );
}

/** Switches between the Git repository root and the browsed folder. */
function GitRootToggle(props: {
    pressed: boolean;
    onUpdate: (changes: AgentSearch) => Promise<void>;
}) {
    return (
        <ToggleButton
            label="Search from git root"
            pressed={props.pressed}
            tooltip={
                props.pressed
                    ? "Search the current directory only"
                    : "Search the entire Git repository instead of the current directory"
            }
            size="lg"
            // Leaves a chosen folder too, so the toggle always lands on the root or the browsed folder.
            onClick={() =>
                void props.onUpdate({
                    gitroot: !props.pressed,
                    dir: undefined,
                })
            }
        >
            <FolderGit2 className="h-4 w-4" />
        </ToggleButton>
    );
}

/** Keeps bounded numeric controls compact so mobile does not stretch a gap between them. */
function SearchNumberInputs(props: {
    isContentSearch: boolean;
    timeoutSeconds: number;
    contextSize: number;
    onUpdate: (changes: AgentSearch) => Promise<void>;
    onUpdateOption: (
        changes: AgentSearch,
        preferences: Record<string, number | boolean>,
    ) => void;
}) {
    return (
        <div className="flex gap-2 sm:ml-auto">
            <label className="grid gap-1 text-xs text-slate-400">
                Timeout
                <InputControl
                    aria-label="Search timeout in seconds"
                    type="number"
                    min={1}
                    max={60}
                    value={props.timeoutSeconds}
                    onChange={(event) => {
                        const value = event.target.valueAsNumber;

                        if (Number.isInteger(value)) {
                            const timeout = Math.min(60, Math.max(1, value));
                            props.onUpdateOption(
                                { timeout },
                                { recursiveSearchTimeoutSeconds: timeout },
                            );
                        }
                    }}
                    className="h-9 w-16 py-1 text-sm font-normal"
                />
            </label>
            {props.isContentSearch ? (
                <label className="grid gap-1 text-xs text-slate-400">
                    Context
                    <InputControl
                        aria-label="Context lines above and below"
                        type="number"
                        min={0}
                        max={20}
                        value={props.contextSize}
                        onChange={(event) => {
                            const value = event.target.valueAsNumber;

                            if (Number.isInteger(value)) {
                                void props.onUpdate({
                                    context: Math.min(20, Math.max(0, value)),
                                });
                            }
                        }}
                        className="h-9 w-16 py-1 text-sm font-normal"
                    />
                </label>
            ) : null}
        </div>
    );
}

/** Announces progress and mode-specific bounded-result conditions. */
function SearchStatus(props: {
    isContentSearch: boolean;
    query: string;
    debouncedQuery: string;
    pathSearch: UseQueryResult<FileSearchResponse>;
    contentSearch: UseQueryResult<ContentGrepResponse>;
}) {
    const activeSearch = props.isContentSearch
        ? props.contentSearch
        : props.pathSearch;

    if (props.query.trim() === "") {
        return (
            <p role="status" className="text-sm text-slate-400">
                {props.isContentSearch
                    ? "Enter text to search file contents."
                    : "Enter text to search file paths."}
            </p>
        );
    }

    if (props.query !== props.debouncedQuery || activeSearch.isFetching) {
        return (
            <p role="status" className="text-sm text-slate-400">
                Searching…
            </p>
        );
    }

    if (activeSearch.isError) {
        return (
            <p role="alert" className="text-sm text-red-300">
                {props.isContentSearch
                    ? "Content search failed."
                    : "Path search failed."}
            </p>
        );
    }

    if (props.isContentSearch) {
        const data = props.contentSearch.data;

        if (!data) return null;

        const notices = [
            data.timed_out ? "Search timed out." : null,
            data.cancelled ? "Search was cancelled." : null,
            data.truncated ? "Results were truncated." : null,
            data.omitted_long_lines > 0
                ? `${data.omitted_long_lines} long lines omitted.`
                : null,
        ].filter((notice): notice is string => notice !== null);

        return (
            <p role="status" className="text-sm text-slate-400">
                {data.results.length} results. {notices.join(" ")}
            </p>
        );
    }

    const data = props.pathSearch.data;

    if (!data) return null;

    return (
        <p role="status" className="text-sm text-slate-400">
            Found{" "}
            <Tooltip content="100 is the maximum number of results a search can return.">
                <span>{data.results.length}</span>
            </Tooltip>{" "}
            {data.results.length === 1 ? "result" : "results"} in{" "}
            <Tooltip content="Search duration was measured on the device.">
                <span>{data.duration_ms}ms</span>
            </Tooltip>
            . {data.timed_out ? "Search timed out." : ""}
        </p>
    );
}

/**
 * Lucide has Aa and aa glyphs, but nothing for smart case, so this keeps the
 * same letterforms and adds a sparkle to show automatic case matching.
 */
function SmartCaseIcon(props: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16" />
            <path d="M3.304 13h6.392" />
            <path d="M22 11v5" />
            <circle cx="18.5" cy="13.5" r="3.5" />
            <path d="M19 3v4" />
            <path d="M17 5h4" />
        </svg>
    );
}
