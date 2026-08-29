import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getRouteApi, useLocation, useMatches } from "@tanstack/react-router";
import { Eye, EyeOff, GitBranch, Regex } from "lucide-react";

import type { ContentGrepMatch } from "#bindings/ContentGrepMatch";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import {
    isLsDirectoryResponse,
    isLsFileResponse,
    type Agent,
} from "#ui/api-client";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { InputControl } from "#ui/components/input-control";
import { ToggleButton } from "#ui/components/toggle-button";
import { contentGrepQueryOptions } from "#ui/queries";
import { useUserState } from "#ui/user-state";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";

const agentRoute = getRouteApi("/agents/$agentId");

/** Derives grep scope from canonical browser loader metadata without another filesystem request. */
function useContentSearchDirectory(agent: Agent): string | null {
    return useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            const lsResult = browserMatch?.loaderData?.lsResult;
            if (lsResult && isLsDirectoryResponse(lsResult)) {
                return lsResult.path;
            }
            if (lsResult && isLsFileResponse(lsResult)) {
                return getImmediateParentPath(lsResult.path) ?? "/";
            }
            return agent.status === "connected" ? agent.cwd : null;
        },
    });
}

/** Owns the route-wide grep workflow so navigation between agent views cannot duplicate it. */
export function ContentSearchDialog(props: { agent: Agent }) {
    const search = agentRoute.useSearch();
    const navigate = agentRoute.useNavigate();
    const location = useLocation();
    const directory = useContentSearchDirectory(props.agent);
    const [userState] = useUserState();
    const isOpen = search.q !== undefined;
    const query = search.q ?? "";
    const timeoutSeconds =
        search.timeout ?? userState.recursiveSearchTimeoutSeconds;
    const includeHidden =
        search.hidden ?? userState.recursiveSearchIncludeHidden;
    const respectGitignore =
        search.gitignore ?? userState.recursiveSearchRespectGitignore;
    const regex = search.regex ?? false;
    const [debouncedQuery, setDebouncedQuery] = React.useState(query);
    const resultsRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
        return () => window.clearTimeout(timer);
    }, [query]);

    React.useEffect(() => {
        /** Cmd/Ctrl+K is deliberate even in text entry, matching platform search conventions. */
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
            void navigate({
                to: `${location.pathname}${location.searchStr ? `${location.searchStr}&q=` : "?q="}`,
                replace: true,
            });
        };
        window.addEventListener("keydown", openSearch);
        return () => window.removeEventListener("keydown", openSearch);
    }, [isOpen, location.pathname, location.searchStr, navigate]);

    const grep = useQuery({
        ...contentGrepQueryOptions(props.agent, directory ?? "", {
            query: isOpen && directory ? debouncedQuery : "",
            timeoutSeconds,
            includeHidden,
            respectGitignore,
            regex,
        }),
        enabled:
            isOpen &&
            props.agent.status === "connected" &&
            directory !== null &&
            debouncedQuery.trim() !== "",
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

    /** Replaces only dialog-owned URL state so child view parameters remain intact. */
    const updateSearch = (
        changes: Record<string, string | number | boolean | undefined>,
    ) => {
        const params = new URLSearchParams(location.searchStr);
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) params.delete(key);
            else params.set(key, String(value));
        }
        const searchString = params.toString();
        return navigate({
            to: `${location.pathname}${searchString ? `?${searchString}` : ""}${location.hash}`,
            replace: true,
        });
    };
    const close = () =>
        void updateSearch({
            q: undefined,
            timeout: undefined,
            hidden: undefined,
            gitignore: undefined,
            regex: undefined,
        });

    /** Pushes a clean file destination after preserving the final query on the current entry. */
    const openResult = async (result: ContentGrepMatch) => {
        await updateSearch({ q: query });
        await navigate({
            to: `${props.agent.getBrowserUrl(result.path)}?line=${result.line_number}`,
        });
    };

    return (
        <Dialog
            isOpen={isOpen}
            title="Search agent content"
            description={
                directory
                    ? `Searching in ${directory}`
                    : "Search is unavailable while this agent is disconnected."
            }
            closeAriaLabel="Close content search"
            size="search"
            onClose={close}
        >
            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
                <SearchControls
                    query={query}
                    timeoutSeconds={timeoutSeconds}
                    includeHidden={includeHidden}
                    respectGitignore={respectGitignore}
                    regex={regex}
                    disabled={directory === null}
                    onUpdate={updateSearch}
                />
                <SearchStatus
                    query={query}
                    debouncedQuery={debouncedQuery}
                    grep={grep}
                />
                <div
                    ref={resultsRef}
                    aria-label="Content search results"
                    className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-800"
                >
                    {grep.data?.results.map((result) => {
                        const key = `${result.path}:${result.line_number}:${result.line}`;
                        return (
                            <Button
                                key={key}
                                type="button"
                                variant="subtle"
                                onClick={() => void openResult(result)}
                                className="block w-full rounded-none border-b border-slate-800 px-3 py-2 text-left hover:bg-white/5 focus:bg-blue-500/10 focus:outline-none"
                                aria-label={`Open ${result.path} at line ${result.line_number}`}
                            >
                                <span className="block text-sm text-blue-300">
                                    {result.path}:{result.line_number}
                                </span>
                                <span className="block truncate font-mono text-sm font-normal text-slate-300">
                                    {result.line}
                                    {result.line_truncated ? "…" : ""}
                                </span>
                            </Button>
                        );
                    })}
                </div>
            </div>
        </Dialog>
    );
}

/** Groups URL-backed grep controls so the dialog owner stays focused on orchestration. */
function SearchControls(props: {
    query: string;
    timeoutSeconds: number;
    includeHidden: boolean;
    respectGitignore: boolean;
    regex: boolean;
    disabled: boolean;
    onUpdate: (
        changes: Record<string, string | number | boolean | undefined>,
    ) => Promise<void>;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <InputControl
                autoFocus
                type="search"
                aria-label="Search content"
                value={props.query}
                disabled={props.disabled}
                onChange={(event) =>
                    void props.onUpdate({ q: event.target.value })
                }
                placeholder="Search file contents"
                className="min-w-48 flex-1"
            />
            <InputControl
                type="number"
                aria-label="Search timeout in seconds"
                min={1}
                max={60}
                value={props.timeoutSeconds}
                onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isInteger(value)) {
                        void props.onUpdate({
                            timeout: Math.min(60, Math.max(1, value)),
                        });
                    }
                }}
                className="w-20"
            />
            <ToggleButton
                label="Include hidden files and directories"
                pressed={props.includeHidden}
                tooltip="Include hidden files and directories"
                onClick={() =>
                    void props.onUpdate({ hidden: !props.includeHidden })
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
                    void props.onUpdate({
                        gitignore: !props.respectGitignore,
                    })
                }
            >
                <GitBranch className="h-4 w-4" />
            </ToggleButton>
            <ToggleButton
                label="Use regular expressions"
                pressed={props.regex}
                tooltip="Use regular expressions"
                onClick={() => void props.onUpdate({ regex: !props.regex })}
            >
                <Regex className="h-4 w-4" />
            </ToggleButton>
        </div>
    );
}

/** Announces progress and bounded-result conditions without replacing retained matches. */
function SearchStatus(props: {
    query: string;
    debouncedQuery: string;
    grep: UseQueryResult<ContentGrepResponse>;
}) {
    if (props.query.trim() === "") {
        return (
            <p role="status" className="text-sm text-slate-400">
                Enter text to search.
            </p>
        );
    }
    if (props.query !== props.debouncedQuery || props.grep.isFetching) {
        return (
            <p role="status" className="text-sm text-slate-400">
                Searching…
            </p>
        );
    }
    if (props.grep.isError) {
        return (
            <p role="alert" className="text-sm text-red-300">
                Content search failed.
            </p>
        );
    }
    const data = props.grep.data;
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
