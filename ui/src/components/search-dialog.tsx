import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getRouteApi, useLocation, useMatches } from "@tanstack/react-router";
import { Eye, EyeOff, File, Folder, GitBranch, Regex } from "lucide-react";

import type { ContentGrepMatch } from "#bindings/ContentGrepMatch";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { FileSearchEntry } from "#bindings/FileSearchEntry";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import {
    isLsDirectoryResponse,
    isLsFileResponse,
    type Agent,
} from "#ui/api-client";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { InputControl } from "#ui/components/input-control";
import { ToggleButton } from "#ui/components/toggle-button";
import { Tooltip } from "#ui/components/tooltip";
import { contentGrepQueryOptions, fileSearchQueryOptions } from "#ui/queries";
import { useUserState } from "#ui/user-state";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";

const agentRoute = getRouteApi("/agents/$agentId");

/** Reads worktree root from already-loaded browser context so searching never probes git again. */
function gitRootFromContext(gitContext: GitContextResponse | undefined) {
    return gitContext?.status === "inside_worktree"
        ? gitContext.repository_root
        : null;
}

/** Derives the agent-wide search scope from browser loader data, with cwd as fallback. */
function useSearchScope(agent: Agent): {
    directory: string | null;
    gitRoot: string | null;
} {
    return useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            const lsResult = browserMatch?.loaderData?.lsResult;
            const gitRoot = gitRootFromContext(
                browserMatch?.loaderData?.gitContext,
            );
            if (lsResult && isLsDirectoryResponse(lsResult)) {
                return { directory: lsResult.path, gitRoot };
            }
            if (lsResult && isLsFileResponse(lsResult)) {
                return {
                    directory: getImmediateParentPath(lsResult.path) ?? "/",
                    gitRoot,
                };
            }
            return {
                directory: agent.status === "connected" ? agent.cwd : null,
                gitRoot: null,
            };
        },
    });
}

type SearchChanges = Record<string, string | number | boolean | undefined>;

/** Owns the single route-wide path and content search workflow. */
export function SearchDialog(props: { agent: Agent }) {
    const search = agentRoute.useSearch();
    const navigate = agentRoute.useNavigate();
    const location = useLocation();
    const { directory, gitRoot } = useSearchScope(props.agent);
    const [userState, setUserState] = useUserState();
    const isOpen = search.q !== undefined;
    const isContentSearch = search.mode === "content";
    const query = search.q ?? "";
    const timeoutSeconds =
        search.timeout ?? userState.recursiveSearchTimeoutSeconds;
    const includeHidden =
        search.hidden ?? userState.recursiveSearchIncludeHidden;
    const respectGitignore =
        search.gitignore ?? userState.recursiveSearchRespectGitignore;
    const regex = search.regex ?? false;
    const searchFromGitRoot = gitRoot !== null && (search.gitroot ?? false);
    const searchDirectory = searchFromGitRoot ? gitRoot : directory;
    const [debouncedQuery, setDebouncedQuery] = React.useState(query);
    const resultsRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
        return () => window.clearTimeout(timer);
    }, [query]);

    React.useEffect(() => {
        /** Cmd/Ctrl+K remains available in text controls to match platform search conventions. */
        const openSearch = (event: KeyboardEvent) => {
            if (
                isOpen ||
                event.key.toLowerCase() !== "k" ||
                event.altKey ||
                event.shiftKey ||
                (!event.metaKey && !event.ctrlKey)
            ) {
                return;
            }
            event.preventDefault();
            const params = new URLSearchParams(location.searchStr);
            params.set("q", "");
            params.delete("mode");
            void navigate({
                to: `${location.pathname}?${params.toString()}${location.hash}`,
                replace: true,
            });
        };
        window.addEventListener("keydown", openSearch);
        return () => window.removeEventListener("keydown", openSearch);
    }, [
        isOpen,
        location.hash,
        location.pathname,
        location.searchStr,
        navigate,
    ]);

    const canSearch =
        isOpen &&
        props.agent.status === "connected" &&
        searchDirectory !== null &&
        debouncedQuery.trim() !== "";
    const pathSearch = useQuery({
        ...fileSearchQueryOptions(props.agent, searchDirectory ?? "", {
            query: canSearch && !isContentSearch ? debouncedQuery : "",
            timeoutSeconds,
            includeHidden,
            respectGitignore,
        }),
        enabled: canSearch && !isContentSearch,
    });
    const contentSearch = useQuery({
        ...contentGrepQueryOptions(props.agent, searchDirectory ?? "", {
            query: canSearch && isContentSearch ? debouncedQuery : "",
            timeoutSeconds,
            includeHidden,
            respectGitignore,
            regex,
        }),
        enabled: canSearch && isContentSearch,
    });
    const getResults = React.useCallback(
        () =>
            resultsRef.current
                ? [
                      ...resultsRef.current.querySelectorAll<HTMLElement>(
                          "button",
                      ),
                  ]
                : [],
        [],
    );
    useArrayKeyboardFocus(getResults, isOpen);

    /** Changes only dialog-owned URL state so child-view parameters survive. */
    const updateSearch = (changes: SearchChanges, replace = true) => {
        const params = new URLSearchParams(location.searchStr);
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) params.delete(key);
            else params.set(key, String(value));
        }
        const searchString = params.toString();
        return navigate({
            to: `${location.pathname}${searchString ? `?${searchString}` : ""}${location.hash}`,
            replace,
        });
    };
    const close = () =>
        void updateSearch({
            q: undefined,
            mode: undefined,
            timeout: undefined,
            hidden: undefined,
            gitignore: undefined,
            regex: undefined,
            gitroot: undefined,
        });

    /** Persists common traversal defaults while keeping the current URL shareable. */
    const updateOption = (
        changes: SearchChanges,
        preferenceChanges: Partial<typeof userState>,
    ) => {
        setUserState((current) => ({ ...current, ...preferenceChanges }));
        void updateSearch(changes);
    };

    /** Opens a path result directly without carrying modal state into the destination. */
    const openPathResult = (result: FileSearchEntry) =>
        navigate({ to: props.agent.getBrowserUrl(result.path) });

    /** Opens a grep match at its one-based line destination. */
    const openContentResult = (result: ContentGrepMatch) =>
        navigate({
            to: `${props.agent.getBrowserUrl(result.path)}?line=${result.line_number}`,
        });

    return (
        <Dialog
            isOpen={isOpen}
            title="Search agent"
            description={
                searchDirectory
                    ? `Searching in ${searchDirectory}`
                    : "Search is unavailable while this agent is disconnected."
            }
            closeAriaLabel="Close search"
            size="search"
            onClose={close}
        >
            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
                <SearchControls
                    query={query}
                    isContentSearch={isContentSearch}
                    timeoutSeconds={timeoutSeconds}
                    includeHidden={includeHidden}
                    respectGitignore={respectGitignore}
                    regex={regex}
                    gitRoot={gitRoot}
                    searchFromGitRoot={searchFromGitRoot}
                    disabled={directory === null}
                    onModeChange={(checked) =>
                        void updateSearch(
                            { mode: checked ? "content" : undefined },
                            false,
                        )
                    }
                    onUpdate={updateSearch}
                    onUpdateOption={updateOption}
                />
                <SearchStatus
                    isContentSearch={isContentSearch}
                    query={query}
                    debouncedQuery={debouncedQuery}
                    pathSearch={pathSearch}
                    contentSearch={contentSearch}
                />
                <div
                    ref={resultsRef}
                    aria-label="Search results"
                    className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-800"
                >
                    {isContentSearch
                        ? contentSearch.data?.results.map((result) => (
                              <ContentResult
                                  key={`${result.path}:${result.line_number}:${result.line}`}
                                  result={result}
                                  onOpen={openContentResult}
                              />
                          ))
                        : pathSearch.data?.results.map((result) => (
                              <PathResult
                                  key={result.path}
                                  result={result}
                                  onOpen={openPathResult}
                              />
                          ))}
                </div>
            </div>
        </Dialog>
    );
}

/** Groups URL-backed controls while exposing content-only options only in grep mode. */
function SearchControls(props: {
    query: string;
    isContentSearch: boolean;
    timeoutSeconds: number;
    includeHidden: boolean;
    respectGitignore: boolean;
    regex: boolean;
    gitRoot: string | null;
    searchFromGitRoot: boolean;
    disabled: boolean;
    onModeChange: (checked: boolean) => void;
    onUpdate: (changes: SearchChanges) => Promise<void>;
    onUpdateOption: (
        changes: SearchChanges,
        preferences: Record<string, number | boolean>,
    ) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <InputControl
                key={props.isContentSearch ? "content" : "path"}
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
                    void props.onUpdate({ q: event.target.value })
                }
                placeholder={
                    props.isContentSearch
                        ? "Search file contents"
                        : "Search file paths"
                }
                className="min-w-48 flex-1"
            />
            <Tooltip content="Search inside files instead of matching file paths">
                <Checkbox
                    checked={props.isContentSearch}
                    role="checkbox"
                    label="Search file contents"
                    title={false}
                    onCheckedChange={props.onModeChange}
                >
                    Search file contents
                </Checkbox>
            </Tooltip>
            <InputControl
                type="number"
                aria-label="Search timeout in seconds"
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
                className="w-20"
            />
            <ToggleButton
                label="Include hidden files and directories"
                pressed={props.includeHidden}
                tooltip="Include hidden files and directories"
                onClick={() =>
                    props.onUpdateOption(
                        { hidden: !props.includeHidden },
                        {
                            recursiveSearchIncludeHidden: !props.includeHidden,
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
                tooltip="Respect .gitignore files"
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
            {props.isContentSearch ? (
                <ToggleButton
                    label="Use regular expressions"
                    pressed={props.regex}
                    tooltip="Use regular expressions"
                    onClick={() => void props.onUpdate({ regex: !props.regex })}
                >
                    <Regex className="h-4 w-4" />
                </ToggleButton>
            ) : null}
            {props.gitRoot ? (
                <Tooltip content="Search the entire Git repository instead of the current directory">
                    <Checkbox
                        checked={props.searchFromGitRoot}
                        role="checkbox"
                        label="Search from git root"
                        title={false}
                        onCheckedChange={(checked) =>
                            void props.onUpdate({ gitroot: checked })
                        }
                    >
                        Search from git root
                    </Checkbox>
                </Tooltip>
            ) : null}
        </div>
    );
}

/** Presents one fuzzy path match with enough context to distinguish duplicate names. */
function PathResult(props: {
    result: FileSearchEntry;
    onOpen: (result: FileSearchEntry) => void;
}) {
    const ResultIcon = props.result.type === "directory" ? Folder : File;
    return (
        <Button
            type="button"
            variant="subtle"
            onClick={() => props.onOpen(props.result)}
            className="flex w-full items-start gap-3 rounded-none border-b border-slate-800 px-3 py-2 text-left hover:bg-white/5 focus:bg-blue-500/10 focus:outline-none"
            aria-label={`Open path ${props.result.path}`}
        >
            <ResultIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
            <span className="min-w-0">
                <span className="block font-medium text-blue-300">
                    {props.result.name}
                </span>
                <span className="block truncate font-mono text-xs font-normal text-slate-500">
                    {props.result.path}
                </span>
            </span>
        </Button>
    );
}

/** Presents a grep match with its line preview and exact navigation destination. */
function ContentResult(props: {
    result: ContentGrepMatch;
    onOpen: (result: ContentGrepMatch) => void;
}) {
    return (
        <Button
            type="button"
            variant="subtle"
            onClick={() => props.onOpen(props.result)}
            className="block w-full rounded-none border-b border-slate-800 px-3 py-2 text-left hover:bg-white/5 focus:bg-blue-500/10 focus:outline-none"
            aria-label={`Open ${props.result.path} at line ${props.result.line_number}`}
        >
            <span className="block text-sm text-blue-300">
                {props.result.path}:{props.result.line_number}
            </span>
            <span className="block truncate font-mono text-sm font-normal text-slate-300">
                {props.result.line}
                {props.result.line_truncated ? "…" : ""}
            </span>
        </Button>
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
            <Tooltip content="Search duration was measured on the agent.">
                <span>{data.duration_ms}ms</span>
            </Tooltip>
            . {data.timed_out ? "Search timed out." : ""}
        </p>
    );
}
