import React from "react";
import {
    findNext,
    findPrevious,
    replaceAll,
    replaceNext,
    SearchQuery,
    selectMatches,
    setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import {
    ChevronDown,
    ChevronUp,
    Replace,
    ReplaceAll,
    TextSelect,
} from "lucide-react";
import { Checkbox } from "#ui/components/checkbox";
import { Button } from "#ui/components/button";
import { FoldingSection } from "#ui/components/folding-section";
import { InputControl } from "#ui/components/input-control";
import { Tooltip } from "#ui/components/tooltip";
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
}) {
    const searchInputRef = React.useRef<HTMLInputElement>(null);
    const [open, setOpen] = React.useState(false);
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
                caseSensitive,
                regexp,
                wholeWord,
            }),
        [search, replace, caseSensitive, regexp, wholeWord],
    );
    const canSearch = query.valid;
    const canReplace = props.editable && canSearch;
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
        props.view?.focus();
        return true;
    }, [open, props.view]);

    const findNextMatch = React.useCallback(() => {
        if (props.view === null || !query.valid) {
            return false;
        }
        applyQuery(query);
        return findNext(props.view);
    }, [applyQuery, props.view, query]);

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

    return (
        <div className="shrink-0 px-3 pt-3 pb-3">
            <FoldingSection
                title="Search & Replace"
                open={open}
                onOpenChange={setOpen}
                tooltip="Search and replace in the file (Ctrl+F)"
            >
                <SearchReplaceFields
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
                />
                <SearchReplaceActions
                    canSearch={canSearch}
                    canReplace={canReplace}
                    caseSensitive={caseSensitive}
                    regexp={regexp}
                    wholeWord={wholeWord}
                    onFindNext={findNextMatch}
                    onFindPrevious={findPreviousMatch}
                    onSelectAll={() => {
                        if (props.view === null || !canSearch) {
                            return;
                        }
                        applyQuery(query);
                        selectMatches(props.view);
                    }}
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
                    onCaseSensitiveChange={setCaseSensitive}
                    onRegexpChange={setRegexp}
                    onWholeWordChange={setWholeWord}
                />
            </FoldingSection>
        </div>
    );
}

/**
 * Intercepts editor-wide find keys even when CodeMirror is not focused.
 */
function useEditorSearchWindowShortcuts(props: {
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
                event.altKey
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
 * Keeps query fields compact so the folding section does not crowd the editor.
 */
function SearchReplaceFields(props: {
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
}) {
    return (
        <div className="grid gap-2 md:grid-cols-2">
            <label className="min-w-0">
                <span className="mb-1 block text-xs font-medium text-slate-400">
                    Find
                </span>
                <InputControl
                    ref={props.searchInputRef}
                    type="search"
                    aria-label="Find in file"
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
                    className="w-full bg-slate-900 py-1.5 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500"
                />
                <span
                    aria-label="Search match count"
                    className="mt-1 block text-xs text-slate-500"
                >
                    {props.search === ""
                        ? "Enter a search query"
                        : props.queryValid
                          ? props.matchCount
                          : "Invalid regular expression"}
                </span>
            </label>
            <label className="min-w-0">
                <span className="mb-1 block text-xs font-medium text-slate-400">
                    Replace
                </span>
                <InputControl
                    type="text"
                    aria-label="Replace with"
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
                    className="w-full bg-slate-900 py-1.5 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500"
                />
            </label>
        </div>
    );
}

/**
 * Mirrors CodeMirror's search commands with the same controls the default panel exposes.
 */
function SearchReplaceActions(props: {
    canSearch: boolean;
    canReplace: boolean;
    caseSensitive: boolean;
    regexp: boolean;
    wholeWord: boolean;
    onFindNext: () => void;
    onFindPrevious: () => void;
    onSelectAll: () => void;
    onReplaceNext: () => void;
    onReplaceAll: () => void;
    onCaseSensitiveChange: (checked: boolean) => void;
    onRegexpChange: (checked: boolean) => void;
    onWholeWordChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
                <SearchActionButton
                    label="Find previous"
                    tooltip="Find previous (Shift+Ctrl+G)"
                    icon={
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    disabled={!props.canSearch}
                    onClick={props.onFindPrevious}
                />
                <SearchActionButton
                    label="Find next"
                    tooltip="Find next (Ctrl+G)"
                    icon={
                        <ChevronDown
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    }
                    disabled={!props.canSearch}
                    onClick={props.onFindNext}
                />
                <SearchActionButton
                    label="Select all"
                    tooltip="Select all matches"
                    icon={
                        <TextSelect
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    }
                    disabled={!props.canSearch}
                    onClick={props.onSelectAll}
                />
                <SearchActionButton
                    label="Replace"
                    tooltip="Replace the current match"
                    icon={
                        <Replace className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    disabled={!props.canReplace}
                    onClick={props.onReplaceNext}
                />
                <SearchActionButton
                    label="Replace all"
                    tooltip="Replace all matches"
                    icon={
                        <ReplaceAll
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    }
                    disabled={!props.canReplace}
                    onClick={props.onReplaceAll}
                />
            </div>
            <div className="flex flex-wrap gap-2">
                <Tooltip content="Match the exact letter case">
                    <Checkbox
                        checked={props.caseSensitive}
                        onCheckedChange={props.onCaseSensitiveChange}
                        label="Match case"
                        title={false}
                    >
                        Match case
                    </Checkbox>
                </Tooltip>
                <Tooltip content="Interpret the query as a regular expression">
                    <Checkbox
                        checked={props.regexp}
                        onCheckedChange={props.onRegexpChange}
                        label="Regular expression"
                        title={false}
                    >
                        Regular expression
                    </Checkbox>
                </Tooltip>
                <Tooltip content="Match whole words only">
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
                className="gap-1.5 rounded-md bg-slate-800/80 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-700"
            >
                {props.icon}
                {props.label}
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
