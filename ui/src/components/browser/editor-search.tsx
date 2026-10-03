import React from "react";
import {
    findNext,
    findPrevious,
    replaceAll,
    replaceNext,
    SearchQuery,
    setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import {
    ChevronDown,
    ChevronUp,
    Replace,
    ReplaceAll,
    SlidersHorizontal,
} from "lucide-react";
import { Checkbox } from "#ui/components/checkbox";
import { Button } from "#ui/components/button";
import { InputControl } from "#ui/components/input-control";
import { Tooltip } from "#ui/components/tooltip";
import { ToggleButton } from "#ui/components/toggle-button";
import { isTerminalInputTarget } from "#ui/utils/keyboard";

export type EditorSearchHandle = {
    open: () => void;
    close: () => boolean;
    findNext: () => boolean;
    findPrevious: () => boolean;
};

/**
 * Replaces CodeMirror's unstyled search panel with app-styled find/replace above the editor.
 */
export function EditorSearch(props: {
    view: EditorView | null;
    editable: boolean;
    documentRevision: number;
    handleRef: React.RefObject<EditorSearchHandle | null>;
    onOpenChange: (open: boolean) => void;
    captureFindKeys: boolean;
}) {
    const searchInputRef = React.useRef<HTMLInputElement>(null);
    const [open, setOpen] = React.useState(false);
    const [advanced, setAdvanced] = React.useState(false);
    const [focusNonce, setFocusNonce] = React.useState(0);
    const [search, setSearch] = React.useState("");
    const [replace, setReplace] = React.useState("");
    const [caseSensitive, setCaseSensitive] = React.useState(false);
    const [regexp, setRegexp] = React.useState(false);
    const [wholeWord, setWholeWord] = React.useState(false);
    const query = React.useMemo(
        () =>
            new SearchQuery({
                search,
                replace,
                caseSensitive: advanced && caseSensitive,
                regexp: advanced && regexp,
                wholeWord: advanced && wholeWord,
            }),
        [search, replace, advanced, caseSensitive, regexp, wholeWord],
    );
    const canSearch = query.valid;
    const selection = props.view?.state.selection.main;
    const selectedText =
        selection === undefined
            ? ""
            : (props.view?.state.sliceDoc(selection.from, selection.to) ?? "");
    const canFindNext =
        canSearch ||
        (search === "" && selectedText !== "" && !selectedText.includes("\n"));
    const canReplace = props.editable && advanced && canSearch;
    const matchCount = React.useMemo(
        () => currentMatchStatus(props.view, query, open),
        [open, props.documentRevision, props.view, query],
    );

    const applyQuery = React.useCallback(
        (nextQuery: SearchQuery) => {
            applySearchQuery(props.view, nextQuery);
        },
        [props.view],
    );

    const openSearch = React.useCallback(() => {
        const view = props.view;
        if (view !== null) {
            const selected = view.state.sliceDoc(
                view.state.selection.main.from,
                view.state.selection.main.to,
            );
            if (selected !== "" && !selected.includes("\n")) {
                setSearch(selected);
            }
        }
        setOpen(true);
        setFocusNonce((nonce) => nonce + 1);
    }, [props.view]);

    const closeSearch = React.useCallback(() => {
        if (!open) {
            return false;
        }
        setOpen(false);
        setAdvanced(false);
        props.view?.focus();
        return true;
    }, [open, props.view]);

    const findNextMatch = React.useCallback(() => {
        const view = props.view;
        if (view === null) {
            return false;
        }
        let nextQuery = query;
        if (search === "") {
            const selection = view.state.selection.main;
            const selected = view.state.sliceDoc(selection.from, selection.to);
            if (selected === "" || selected.includes("\n")) {
                return false;
            }
            nextQuery = new SearchQuery({
                search: selected,
                replace: query.replace,
                caseSensitive: query.caseSensitive,
                regexp: query.regexp,
                wholeWord: query.wholeWord,
            });
            setSearch(selected);
        }
        if (!nextQuery.valid) {
            return false;
        }
        applyQuery(nextQuery);
        return findNext(view);
    }, [applyQuery, props.view, query, search]);

    const findPreviousMatch = React.useCallback(() => {
        if (props.view === null || !query.valid) {
            return false;
        }
        applyQuery(query);
        return findPrevious(props.view);
    }, [applyQuery, props.view, query]);

    React.useEffect(() => {
        if (!open) {
            applySearchQuery(props.view, new SearchQuery({ search: "" }));
            return;
        }
        applySearchQuery(props.view, query);
    }, [open, props.view, query]);

    /** The toolbar tooltip names close vs open, so unmount and Escape must clear that state. */
    React.useEffect(() => {
        props.onOpenChange(open);
        return () => {
            if (open) {
                props.onOpenChange(false);
            }
        };
    }, [open, props.onOpenChange]);

    React.useLayoutEffect(() => {
        if (!open || focusNonce === 0) {
            return;
        }
        const input = searchInputRef.current;
        if (input === null) {
            return;
        }
        input.focus();
        input.select();
    }, [focusNonce, open]);

    useEditorSearchWindowShortcuts({
        captureFindKeys: props.captureFindKeys,
        openSearch,
        closeSearch,
        findNextMatch,
        findPreviousMatch,
    });

    props.handleRef.current = {
        open: openSearch,
        close: closeSearch,
        findNext: findNextMatch,
        findPrevious: findPreviousMatch,
    };

    if (!open) {
        return null;
    }

    return (
        <div className="shrink-0 p-3">
            <section aria-label="Search & Replace" className="space-y-2">
                <div className="space-y-2">
                    <SearchReplaceFields
                        advanced={advanced}
                        canSearch={canSearch}
                        canFindNext={canFindNext}
                        canReplace={canReplace}
                        editable={props.editable}
                        onAdvancedChange={() =>
                            setAdvanced((enabled) => !enabled)
                        }
                        search={search}
                        replace={replace}
                        searchInputRef={searchInputRef}
                        matchCount={matchCount}
                        queryValid={query.valid}
                        onSearchChange={setSearch}
                        onReplaceChange={setReplace}
                        onFindNext={findNextMatch}
                        onFindPrevious={findPreviousMatch}
                        onReplaceNext={() => {
                            if (props.view === null || !canReplace) {
                                return;
                            }
                            applyQuery(query);
                            replaceNext(props.view);
                        }}
                        onReplaceAll={() => {
                            if (props.view === null || !canReplace) {
                                return;
                            }
                            applyQuery(query);
                            replaceAll(props.view);
                        }}
                    />
                    {advanced && (
                        <SearchOptions
                            caseSensitive={caseSensitive}
                            regexp={regexp}
                            wholeWord={wholeWord}
                            onCaseSensitiveChange={setCaseSensitive}
                            onRegexpChange={setRegexp}
                            onWholeWordChange={setWholeWord}
                        />
                    )}
                </div>
            </section>
        </div>
    );
}

/**
 * Intercepts editor-wide find keys even when CodeMirror is not focused.
 * Markdown preview keeps the editor mounted and hidden, so capture must turn
 * off there or native Cmd/Ctrl+F never reaches the browser.
 */
function useEditorSearchWindowShortcuts(props: {
    captureFindKeys: boolean;
    openSearch: () => void;
    closeSearch: () => boolean;
    findNextMatch: () => boolean;
    findPreviousMatch: () => boolean;
}) {
    const propsRef = React.useRef(props);
    propsRef.current = props;

    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented ||
                isTerminalInputTarget(event.target) ||
                event.altKey ||
                !propsRef.current.captureFindKeys
            ) {
                return;
            }

            const commands = propsRef.current;
            if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "f"
            ) {
                event.preventDefault();
                commands.openSearch();
                return;
            }
            if (
                ((event.ctrlKey || event.metaKey) &&
                    event.key.toLowerCase() === "g") ||
                event.key === "F3"
            ) {
                event.preventDefault();
                if (event.shiftKey) {
                    commands.findPreviousMatch();
                    return;
                }
                commands.findNextMatch();
                return;
            }
            if (event.key === "Escape") {
                if (!commands.closeSearch()) {
                    return;
                }
                event.preventDefault();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);
}

/**
 * Keeps basic navigation on one row and replacement actions next to their input.
 */
function SearchReplaceFields(props: {
    advanced: boolean;
    canSearch: boolean;
    canFindNext: boolean;
    canReplace: boolean;
    editable: boolean;
    onAdvancedChange: () => void;
    search: string;
    replace: string;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    matchCount: string;
    queryValid: boolean;
    onSearchChange: (value: string) => void;
    onReplaceChange: (value: string) => void;
    onFindNext: () => void;
    onFindPrevious: () => void;
    onReplaceNext: () => void;
    onReplaceAll: () => void;
}) {
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <label className="min-w-0 flex-1">
                    <InputControl
                        ref={props.searchInputRef}
                        type="search"
                        aria-label="Find in file"
                        placeholder="Find in file"
                        value={props.search}
                        onChange={(event) =>
                            props.onSearchChange(event.target.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") {
                                return;
                            }
                            event.preventDefault();
                            if (event.shiftKey) {
                                props.onFindPrevious();
                                return;
                            }
                            props.onFindNext();
                        }}
                        className="h-9 w-full bg-slate-900 px-3 py-0 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500"
                    />
                </label>
                <SearchActionButton
                    label="Find previous"
                    tooltip="Find previous (Shift+Ctrl+G)"
                    icon={<ChevronUp className="h-4 w-4" aria-hidden="true" />}
                    disabled={!props.canSearch}
                    onClick={props.onFindPrevious}
                />
                <SearchActionButton
                    label="Find next"
                    tooltip="Find next (Ctrl+G)"
                    icon={
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    }
                    disabled={!props.canFindNext}
                    onClick={props.onFindNext}
                />
                <ToggleButton
                    pressed={props.advanced}
                    label="Advanced"
                    tooltip={
                        props.advanced
                            ? "Hide advanced search options"
                            : "Show advanced search options"
                    }
                    onClick={props.onAdvancedChange}
                    className="h-9 w-9 shrink-0 p-0"
                >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                </ToggleButton>
                <span
                    aria-label="Search match count"
                    className="flex h-9 w-20 shrink-0 items-center justify-center text-center text-xs text-slate-500 tabular-nums"
                >
                    {props.search === ""
                        ? null
                        : props.queryValid
                          ? props.matchCount
                          : "Invalid regular expression"}
                </span>
            </div>
            {props.advanced && props.editable && (
                <div className="flex items-center gap-2">
                    <label className="min-w-0 flex-1">
                        <InputControl
                            type="text"
                            aria-label="Replace with"
                            placeholder="Replace with"
                            value={props.replace}
                            onChange={(event) =>
                                props.onReplaceChange(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") {
                                    return;
                                }
                                event.preventDefault();
                                props.onReplaceNext();
                            }}
                            className="h-9 w-full bg-slate-900 px-3 py-0 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500"
                        />
                    </label>
                    <SearchActionButton
                        label="Replace"
                        tooltip="Replace the current match"
                        icon={
                            <Replace className="h-4 w-4" aria-hidden="true" />
                        }
                        disabled={!props.canReplace}
                        onClick={props.onReplaceNext}
                    />
                    <SearchActionButton
                        label="Replace all"
                        tooltip="Replace all matches"
                        icon={
                            <ReplaceAll
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        }
                        disabled={!props.canReplace}
                        onClick={props.onReplaceAll}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * Keeps optional search constraints behind Advanced so basic find stays compact.
 */
function SearchOptions(props: {
    caseSensitive: boolean;
    regexp: boolean;
    wholeWord: boolean;
    onCaseSensitiveChange: (checked: boolean) => void;
    onRegexpChange: (checked: boolean) => void;
    onWholeWordChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2">
                <Tooltip
                    content={
                        props.caseSensitive
                            ? "Ignore letter case"
                            : "Match the exact letter case"
                    }
                >
                    <Checkbox
                        checked={props.caseSensitive}
                        onCheckedChange={props.onCaseSensitiveChange}
                        label="Match case"
                        title={false}
                    >
                        Match case
                    </Checkbox>
                </Tooltip>
                <Tooltip
                    content={
                        props.regexp
                            ? "Search as literal text"
                            : "Interpret the query as a regular expression"
                    }
                >
                    <Checkbox
                        checked={props.regexp}
                        onCheckedChange={props.onRegexpChange}
                        label="Regular expression"
                        title={false}
                    >
                        Regular expression
                    </Checkbox>
                </Tooltip>
                <Tooltip
                    content={
                        props.wholeWord
                            ? "Allow partial word matches"
                            : "Match whole words only"
                    }
                >
                    <Checkbox
                        checked={props.wholeWord}
                        onCheckedChange={props.onWholeWordChange}
                        label="Match whole word"
                        title={false}
                    >
                        Whole word
                    </Checkbox>
                </Tooltip>
            </div>
        </div>
    );
}

/**
 * Shares button chrome so search actions stay visually consistent with the rest of the app.
 */
function SearchActionButton(props: {
    label: string;
    tooltip: string;
    icon: React.ReactNode;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <Tooltip content={props.tooltip}>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={props.label}
                disabled={props.disabled}
                onClick={props.onClick}
                className="h-9 w-9 shrink-0 rounded-md p-0"
            >
                {props.icon}
            </Button>
        </Tooltip>
    );
}

/**
 * Pushes the React query into CodeMirror so match highlighting uses the same engine as the commands.
 */
function applySearchQuery(view: EditorView | null, query: SearchQuery) {
    if (view === null) {
        return;
    }
    view.dispatch({ effects: setSearchQuery.of(query) });
}

/**
 * Reports the selected match without walking the document while the section is closed.
 */
function currentMatchStatus(
    view: EditorView | null,
    query: SearchQuery,
    open: boolean,
) {
    if (!open || view === null || !query.valid) {
        return "No matches";
    }
    const matches = collectSearchMatches(view, query);
    if (matches.length === 0) {
        return "No matches";
    }
    const selection = view.state.selection.main;
    const currentIndex = matches.findIndex(
        (match) => match.from === selection.from && match.to === selection.to,
    );
    if (currentIndex === -1) {
        return `${matches.length} matches`;
    }
    return `${currentIndex + 1} of ${matches.length}`;
}

/**
 * Uses CodeMirror's cursor so the count stays consistent with next/previous wrapping.
 */
function collectSearchMatches(view: EditorView, query: SearchQuery) {
    const matches: Array<{ from: number; to: number }> = [];
    const cursor = query.getCursor(view.state);
    while (true) {
        const step = cursor.next();
        if (step.done === true) {
            break;
        }
        matches.push(step.value);
    }
    return matches;
}
