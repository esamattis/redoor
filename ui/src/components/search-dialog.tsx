import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
    getRouteApi,
    Link,
    useLocation,
    useMatches,
} from "@tanstack/react-router";
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
    const contextSize = search.context ?? 4;
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
            contextSize,
        }),
        enabled: canSearch && isContentSearch,
    });
    const getResults = React.useCallback(
        () =>
            resultsRef.current
                ? [...resultsRef.current.querySelectorAll<HTMLElement>("a")]
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
            context: undefined,
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

    return (
        <Dialog
            isOpen={isOpen}
            title="Search agent"
            description={
                searchDirectory ? (
                    <span>
                        Current folder:{" "}
                        <span className="break-all font-mono text-slate-300">
                            {searchDirectory}
                        </span>
                    </span>
                ) : (
                    "Search is unavailable while this agent is disconnected."
                )
            }
            closeAriaLabel="Close search"
            size="search"
            onClose={close}
        >
            <div className="mt-4 grid gap-4">
                <SearchControls
                    query={query}
                    isContentSearch={isContentSearch}
                    timeoutSeconds={timeoutSeconds}
                    includeHidden={includeHidden}
                    respectGitignore={respectGitignore}
                    regex={regex}
                    contextSize={contextSize}
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
                    className="overflow-hidden rounded-lg border border-slate-800"
                >
                    {isContentSearch
                        ? contentSearch.data?.results.map((result) => (
                              <ContentResult
                                  key={`${result.path}:${result.line_number}:${result.line}`}
                                  result={result}
                                  href={`${props.agent.getBrowserUrl(result.path)}?line=${result.line_number}`}
                              />
                          ))
                        : pathSearch.data?.results.map((result) => (
                              <PathResult
                                  key={result.path}
                                  result={result}
                                  href={props.agent.getBrowserUrl(result.path)}
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
    contextSize: number;
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
    const queryLabel = props.isContentSearch
        ? "Text to find"
        : "File or folder name";

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
                    autoFocus
                    type="search"
                    value={props.query}
                    disabled={props.disabled}
                    onChange={(event) =>
                        void props.onUpdate({ q: event.target.value })
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
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
                    <label className="grid gap-1 text-xs text-slate-400">
                        Timeout (seconds)
                        <InputControl
                            type="number"
                            min={1}
                            max={60}
                            value={props.timeoutSeconds}
                            onChange={(event) => {
                                const value = event.target.valueAsNumber;
                                if (Number.isInteger(value)) {
                                    const timeout = Math.min(
                                        60,
                                        Math.max(1, value),
                                    );
                                    props.onUpdateOption(
                                        { timeout },
                                        {
                                            recursiveSearchTimeoutSeconds:
                                                timeout,
                                        },
                                    );
                                }
                            }}
                            className="h-9 w-full py-1 text-sm font-normal sm:w-28"
                        />
                    </label>
                    {props.isContentSearch ? (
                        <label className="grid gap-1 text-xs text-slate-400">
                            Context lines
                            <InputControl
                                type="number"
                                min={0}
                                max={20}
                                value={props.contextSize}
                                onChange={(event) => {
                                    const value = event.target.valueAsNumber;
                                    if (Number.isInteger(value)) {
                                        void props.onUpdate({
                                            context: Math.min(
                                                20,
                                                Math.max(0, value),
                                            ),
                                        });
                                    }
                                }}
                                className="h-9 w-full py-1 text-sm font-normal sm:w-28"
                            />
                        </label>
                    ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <ToggleButton
                        label="Include hidden files and directories"
                        pressed={props.includeHidden}
                        tooltip="Include hidden files and directories"
                        size="sm"
                        className="h-9 w-full justify-start sm:w-auto"
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
                        Hidden files
                    </ToggleButton>
                    <ToggleButton
                        label="Respect .gitignore files"
                        pressed={props.respectGitignore}
                        tooltip="Respect .gitignore files"
                        size="sm"
                        className="h-9 w-full justify-start sm:w-auto"
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
                        .gitignore
                    </ToggleButton>
                    {props.isContentSearch ? (
                        <ToggleButton
                            label="Use regular expressions"
                            pressed={props.regex}
                            tooltip="Use regular expressions"
                            size="sm"
                            className="h-9 w-full justify-start sm:w-auto"
                            onClick={() =>
                                void props.onUpdate({ regex: !props.regex })
                            }
                        >
                            <Regex className="h-4 w-4" />
                            Regular expression
                        </ToggleButton>
                    ) : null}
                    {props.gitRoot ? (
                        <Tooltip
                            content="Search the entire Git repository instead of the current directory"
                            className="w-full sm:w-auto"
                        >
                            <Checkbox
                                checked={props.searchFromGitRoot}
                                role="checkbox"
                                label="Search from git root"
                                title={false}
                                className="h-9 w-full justify-start border border-slate-700 bg-slate-900 px-3 py-2 sm:w-auto"
                                onCheckedChange={(checked) =>
                                    void props.onUpdate({ gitroot: checked })
                                }
                            >
                                Git root
                            </Checkbox>
                        </Tooltip>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** Presents one fuzzy path match with enough context to distinguish duplicate names. */
function PathResult(props: { result: FileSearchEntry; href: string }) {
    const ResultIcon = props.result.type === "directory" ? Folder : File;
    return (
        <Link
            to={props.href}
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
        </Link>
    );
}

/** Presents a grep match with its line preview and exact navigation destination. */
function ContentResult(props: { result: ContentGrepMatch; href: string }) {
    return (
        <Link
            to={props.href}
            className="block w-full rounded-none border-b border-slate-800 px-3 py-2 text-left hover:bg-white/5 focus:bg-blue-500/10 focus:outline-none"
            aria-label={`Open ${props.result.path} at line ${props.result.line_number}`}
        >
            <span className="block text-sm text-blue-300">
                {props.result.path}:{props.result.line_number}
            </span>
            <span className="mt-1 block font-mono text-sm font-normal">
                {props.result.before_context.map((line) => (
                    <span
                        key={line.line_number}
                        className="grid grid-cols-[3rem_minmax(0,1fr)] text-slate-500"
                    >
                        <span className="pr-3 text-right select-none">
                            {line.line_number}
                        </span>
                        <span className="truncate">
                            {line.line}
                            {line.line_truncated ? "…" : ""}
                        </span>
                    </span>
                ))}
                <span className="grid grid-cols-[3rem_minmax(0,1fr)] bg-blue-500/10 text-slate-200">
                    <span className="pr-3 text-right text-blue-300 select-none">
                        {props.result.line_number}
                    </span>
                    <span className="truncate">
                        {props.result.line}
                        {props.result.line_truncated ? "…" : ""}
                    </span>
                </span>
                {props.result.after_context.map((line) => (
                    <span
                        key={line.line_number}
                        className="grid grid-cols-[3rem_minmax(0,1fr)] text-slate-500"
                    >
                        <span className="pr-3 text-right select-none">
                            {line.line_number}
                        </span>
                        <span className="truncate">
                            {line.line}
                            {line.line_truncated ? "…" : ""}
                        </span>
                    </span>
                ))}
            </span>
        </Link>
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
