import React from "react";
import { Link } from "@tanstack/react-router";
import {
    Check,
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
    Copy,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { ClearableInput } from "#ui/components/clearable-input";
import { useCopyFeedback } from "#ui/components/copyable-code-row";
import { IconButton } from "#ui/components/icon-button";
import {
    DiffLayoutSwitch,
    WholeFileToggle,
    WrapDiffLinesToggle,
} from "#ui/components/browser/diff-layout-control";
import {
    ChangeBadge,
    type GitChangeKind,
} from "#ui/components/browser/git-parts";
import {
    OpenInBackgroundButton,
    useBackgroundOpen,
} from "#ui/components/browser/open-file-actions";
import { DiffSummarySlotContext } from "#ui/components/browser/unified-diff";
import { SelectionSearch } from "#ui/components/browser/selection-search";
import {
    DIFF_SEARCH_PATH_ATTRIBUTE,
    selectionAnchor,
} from "#ui/utils/diff-search-highlighter";
import {
    DiffSearch,
    DiffSearchCardContext,
    DiffSearchStore,
    DiffSearchStoreContext,
    useDiffSearchMatchCount,
    type DiffSearchListFile,
    type DiffSearchSource,
} from "#ui/components/browser/diff-search";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import { cn } from "#ui/utils/cn";
import { FileNameFilter } from "#ui/utils/file-name-filter";

/** How one diff card shows its patch, as chosen in the card's header. */
export type GitDiffBodyView = {
    /** Whether a similar removed and added line show as one row with inline changes. */
    mergeModifiedLines: boolean;
    /** Whether long lines wrap instead of scrolling the patch sideways. */
    wrapLines: boolean;
    /** Whether the patch shows its whole file instead of the changes with a little context. */
    wholeFile: boolean;
};

/** How a diff card's file name opens the file it shows, on the device it is on. */
export type GitDiffFileLink = {
    agent: Agent;
    /**
     * The search the link opens the file with, such as the revision a committed file exists
     * at. The link always opens the file itself, never its diff, because the diff is already
     * on screen.
     */
    search: { rev?: string };
    /**
     * Whether the file exists in the working tree. A deleted file only exists in history, so
     * it has nothing to open in the background.
     */
    hasWorkingCopy: boolean;
};

/** One file's diff, already resolved to what its card's header and body show. */
export type GitDiffListFile = {
    /** The absolute path, which is also the file's identity for collapsing and choices. */
    path: string;
    /** The repository-relative path, which names the file in its header. */
    relativePath: string;
    /** The path a rename or copy came from, shown beside the name. */
    originalPath: string | null;
    /**
     * The Git change badge. It is null where the kind of change is not known, such as a
     * single file's worktree diff or a Sync compare, whose header then names the change from
     * the patch instead.
     */
    change: GitChangeKind | null;
    /**
     * Opens the file from its name. It is null for a diff that is not one file on one
     * device, such as a Sync compare of two devices' files, which then has neither a link
     * nor a path to copy.
     */
    link: GitDiffFileLink | null;
    /** Names the file's region, so tests and assistive technology can find one patch. */
    regionLabel: string;
    /** Where the diff search reads the file's patch, including while its card is collapsed. */
    searchSource: DiffSearchSource;
    /**
     * Renders the patch or a message about it in the file's own layout. It is only called
     * while the file is expanded, so a body that fetches its own diff loads nothing for a
     * collapsed file.
     */
    renderBody: (view: GitDiffBodyView) => React.ReactNode;
};

/** Which diffs of a list are collapsed: a default plus the files toggled away from it. */
type CollapsedState = {
    collapsedByDefault: boolean;
    toggled: ReadonlySet<string>;
};

const collapsedStates = new HistoryEntryStore<CollapsedState>();

/**
 * Remembers which diffs of a list are collapsed. The state is a default plus the files toggled
 * away from it, so collapsing or expanding all is one change that also covers files the list
 * gains later. It belongs to one scope, such as one directory's changes, and starts over when
 * the scope changes, because the same view stays mounted while browsing to another directory.
 * It is kept per history entry, so coming back from a file shows the same files expanded.
 */
export function useCollapsedGitDiffs(options: {
    scope: string;
    initiallyCollapsed: boolean;
}) {
    const [state, update] = useHistoryEntryState<CollapsedState>({
        store: collapsedStates,
        scope: options.scope,
        initial: () => ({
            collapsedByDefault: options.initiallyCollapsed,
            toggled: new Set(),
        }),
    });

    // Stable, so toggling one file re-renders only that file's memoized card.
    const toggle = React.useCallback(
        (path: string) =>
            update((previous) => {
                const toggled = new Set(previous.toggled);

                if (!toggled.delete(path)) {
                    toggled.add(path);
                }

                return { ...previous, toggled };
            }),
        [update],
    );

    return {
        isCollapsed: (path: string) =>
            state.collapsedByDefault !== state.toggled.has(path),
        toggle,
        collapseAll: () =>
            update(() => ({ collapsedByDefault: true, toggled: new Set() })),
        expandAll: () =>
            update(() => ({ collapsedByDefault: false, toggled: new Set() })),
    };
}

/** The collapse state a diff list and its controls share. */
export type CollapsedGitDiffs = ReturnType<typeof useCollapsedGitDiffs>;

/** What the reader chose in one file's header. Unset choices follow the fixed defaults. */
type GitDiffFileChoices = {
    inline?: boolean;
    wrapLines?: boolean;
    wholeFile?: boolean;
};

/**
 * Resolves a file's choices against the fixed defaults. Files without a choice start inline,
 * unwrapped and folded.
 */
function gitDiffBodyView(
    choice: GitDiffFileChoices | undefined,
): GitDiffBodyView {
    return {
        mergeModifiedLines: choice?.inline ?? true,
        wrapLines: choice?.wrapLines ?? false,
        wholeFile: choice?.wholeFile ?? false,
    };
}

const fileChoiceStates = new HistoryEntryStore<
    ReadonlyMap<string, GitDiffFileChoices>
>();

/**
 * Remembers how each file of a list is shown, because one file's edits read best as inline
 * word changes while a rewritten file reads best as separate lines, and only a file with long
 * lines needs to wrap. The defaults are fixed rather than a saved preference, so a choice made
 * in one diff never changes another one on screen. The choices start over with the scope, like
 * the collapse state, since the same paths in another commit are other edits. They are kept
 * per history entry because wrapping and whole files change the list's height, which the
 * restored scroll position depends on, and so back restores every diff the way the reader
 * left it.
 *
 * The map keeps the same choice object for every file but the one just changed, and `choose`
 * is stable, so a choice re-renders only its own memoized card.
 */
function useGitDiffFileChoices(scope: string) {
    const [choices, update] = useHistoryEntryState<
        ReadonlyMap<string, GitDiffFileChoices>
    >({
        store: fileChoiceStates,
        scope,
        initial: () => new Map(),
    });

    const choose = React.useCallback(
        (path: string, choice: GitDiffFileChoices) =>
            update((previous) =>
                new Map(previous).set(path, {
                    ...previous.get(path),
                    ...choice,
                }),
            ),
        [update],
    );

    return { choices, choose };
}

const filterQueries = new HistoryEntryStore<string>();

/**
 * The file name filter of a diff list. It carries over to the next scope, so `-test` keeps
 * hiding tests while browsing directories or stepping through commits, and it is kept per
 * history entry because a filtered list has another height than the full one.
 *
 * The input shows `query` as typed, while the list is narrowed by `filter`, which follows it
 * through `useDeferredValue`. Narrowing a long list of expanded patches is slow, so typing
 * must not wait for it, and React can drop a list render that a newer keystroke made stale.
 */
export function useGitDiffFilterQuery(scope: string) {
    const [query, update] = useHistoryEntryState<string>({
        store: filterQueries,
        scope,
        initial: (previous) => previous ?? "",
    });

    const shownQuery = React.useDeferredValue(query);

    const filter = React.useMemo(
        () => FileNameFilter.parse(shownQuery),
        [shownQuery],
    );

    return {
        query,
        filter,
        setQuery: (next: string) => update(() => next),
    };
}

/**
 * Narrows a diff list by file name, so a large change set can be read one area at a time or
 * without its tests (`-test`). It names how many files the filter keeps, because a hidden
 * file would otherwise look like one the change never touched.
 */
export function GitDiffFilterField(props: {
    query: string;
    onChange: (query: string) => void;
    filter: FileNameFilter;
    shownCount: number;
    totalCount: number;
}) {
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <ClearableInput
                label="Filter files by name"
                clearLabel="Clear file filter"
                value={props.query}
                placeholder='Filter files, -test excludes, "-test" is literal'
                onChange={props.onChange}
                className="min-w-0 flex-1 @xl:max-w-md"
            />
            {props.filter.isActive ? (
                <span role="status" className="text-xs text-slate-400">
                    {props.shownCount === 0
                        ? "No files match the filter"
                        : `Showing ${props.shownCount} of ${props.totalCount} files`}
                </span>
            ) : null}
        </div>
    );
}

/**
 * Collapses or expands every diff at once, for the panel bar above a list, so a long change
 * set can be folded down to its file names and opened again without clicking each file.
 * In a narrow column the buttons shrink to their icons so they share one bar with the file
 * counts.
 */
export function GitDiffCollapseControls(props: {
    collapsed: CollapsedGitDiffs;
    fileCount: number;
    /**
     * Runs before every file expands, so a list that loads diffs on demand can fetch all the
     * missing ones in one request instead of one request per file.
     */
    onExpandAll?: () => void;
}) {
    if (props.fileCount === 0) {
        return null;
    }

    return (
        <>
            <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Collapse all"
                tooltip="Hide every patch and show only the file names"
                className="gap-1.5 px-2 py-1.5 @xl:px-3 @xl:py-2"
                onClick={props.collapsed.collapseAll}
            >
                <ChevronsDownUp className="h-4 w-4" aria-hidden="true" />
                <span className="hidden @xl:inline">Collapse all</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Expand all"
                tooltip="Show the patch of every file"
                className="gap-1.5 px-2 py-1.5 @xl:px-3 @xl:py-2"
                onClick={() => {
                    props.onExpandAll?.();
                    props.collapsed.expandAll();
                }}
            >
                <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
                <span className="hidden @xl:inline">Expand all</span>
            </Button>
        </>
    );
}

/**
 * Splits a repository-relative path into its name and its directory, so the header can lead
 * with the name and dim the directory below it.
 */
function splitRelativePath(relativePath: string) {
    const slash = relativePath.lastIndexOf("/");

    return slash === -1
        ? { name: relativePath, directory: "" }
        : {
              name: relativePath.slice(slash + 1),
              directory: relativePath.slice(0, slash),
          };
}

/**
 * Copies a diff file's name in the form the next step needs: the bare name for a search, the
 * repository path for Git commands and reviews, or the absolute path for a shell on the agent.
 * The menu closes on a pick, so the trigger itself shows that the copy landed.
 */
function GitDiffCopyPathMenu(props: { file: GitDiffListFile; name: string }) {
    const { isCopied, copy } = useCopyFeedback(props.file.path);

    const options = [
        { label: "Copy file name", value: props.name },
        { label: "Copy repository path", value: props.file.relativePath },
        { label: "Copy absolute path", value: props.file.path },
    ];

    return (
        <ActionMenu
            variant="icon"
            label="Copy path"
            triggerAriaLabel={
                isCopied ? "Copied!" : `Copy path of ${props.file.relativePath}`
            }
            closeAriaLabel="Close copy path menu"
            tooltip={isCopied ? "Copied!" : "Copy file name or path"}
            icon={
                isCopied ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                )
            }
            className={cn("h-7 w-7", isCopied && "text-emerald-300")}
        >
            {(close) =>
                options.map((option) => (
                    <ActionMenuButton
                        key={option.label}
                        onClick={() => {
                            close();
                            void copy(option.value);
                        }}
                    >
                        {/* The value is shown so the reader knows which form each option copies. */}
                        <span className="flex min-w-0 flex-col">
                            <span>{option.label}</span>
                            <span className="break-all font-mono text-xs font-normal text-slate-500">
                                {option.value}
                            </span>
                        </span>
                    </ActionMenuButton>
                ))
            }
        </ActionMenu>
    );
}

/**
 * One file's diff card, the only way the app shows a diff, so the switches mean the same
 * everywhere. Its header sticks to the top of the viewport while the patch scrolls under it,
 * so a long patch never leaves the reader guessing which file it belongs to. The section
 * clips instead of hiding overflow, because a hidden overflow would become the header's
 * scroll container and stop it from sticking.
 *
 * It is memoized and takes only stable props, so narrowing the list or changing another file
 * re-renders just the cards whose own state changed, instead of every expanded patch's rows.
 */
const GitDiffSection = React.memo(function GitDiffSection(props: {
    file: GitDiffListFile;
    collapsed: boolean;
    /** Null for a lone file, which has no list to fold it into and is always shown. */
    onToggle: ((path: string) => void) | null;
    /** Undefined until the reader picks a layout, wrapping or whole file for this file. */
    choice: GitDiffFileChoices | undefined;
    onChoose: (path: string, choice: GitDiffFileChoices) => void;
    /** Whether the list's file filter leaves the file out. */
    filteredOut: boolean;
}) {
    const file = props.file;
    const link = file.link;
    const collapsed = props.collapsed;
    const onToggle = props.onToggle;
    const view = gitDiffBodyView(props.choice);
    const parts = splitRelativePath(file.relativePath);
    const bodyId = React.useId();

    // A filtered-out card stays mounted but hidden, so when the filter is widened again its
    // patch comes back without parsing, highlighting and building its rows anew. A body that
    // has never been shown is not mounted while filtered out, though, so expanding all files
    // under a filter neither fetches nor renders the patches it hides.
    const [bodyMounted, setBodyMounted] = React.useState(false);
    const showsBody = !collapsed && (!props.filteredOut || bodyMounted);

    if (showsBody !== bodyMounted) {
        // Adjusting state while rendering keeps the decision in this render.
        setBodyMounted(showsBody);
    }

    // The body parses the patch, so it fills the header's counts in through this slot.
    const [summaryElement, setSummaryElement] =
        React.useState<HTMLElement | null>(null);

    const namesChange = file.change === null;
    const matchCount = useDiffSearchMatchCount(file.path);

    const summarySlot = React.useMemo(
        () =>
            summaryElement === null
                ? null
                : { element: summaryElement, namesChange },
        [summaryElement, namesChange],
    );

    // Only a file in the working tree can be opened without leaving the diff.
    const background = useBackgroundOpen(
        link === null || !link.hasWorkingCopy
            ? null
            : {
                  agentId: link.agent.id,
                  agentName: link.agent.name,
                  path: file.path,
                  name: parts.name,
              },
    );

    return (
        <section
            aria-label={file.regionLabel}
            {...{ [DIFF_SEARCH_PATH_ATTRIBUTE]: file.path }}
            hidden={props.filteredOut}
            className="overflow-clip rounded-lg border border-slate-800 bg-slate-950/30"
        >
            <div
                className={cn(
                    "git-diff-sticky-header sticky z-10 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 bg-surface px-3 py-2 @xl:flex-nowrap",
                    !collapsed && "border-b border-slate-800",
                )}
            >
                {onToggle === null ? null : (
                    <IconButton
                        type="button"
                        variant="ghost"
                        size="xs"
                        label={
                            collapsed
                                ? `Expand diff for ${file.relativePath}`
                                : `Collapse diff for ${file.relativePath}`
                        }
                        tooltip={collapsed ? "Show patch" : "Hide patch"}
                        aria-expanded={!collapsed}
                        aria-controls={bodyId}
                        onClick={() => onToggle(file.path)}
                    >
                        {collapsed ? (
                            <ChevronRight
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        ) : (
                            <ChevronDown
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        )}
                    </IconButton>
                )}
                {file.change === null ? null : (
                    <ChangeBadge kind={file.change} />
                )}
                {/* The directory sits below the name, so in a narrow column it gets the full
                    width left of the controls instead of being cut off right after the name. */}
                <h3 className="flex min-w-0 flex-1 flex-col text-sm">
                    {link === null ? (
                        <span
                            title={file.relativePath}
                            className="truncate font-medium text-slate-100"
                        >
                            {parts.name}
                        </span>
                    ) : (
                        <Link
                            {...browserRoute(link.agent, file.path)}
                            search={link.search}
                            title={file.relativePath}
                            className="truncate font-medium text-slate-100 hover:text-blue-300 hover:underline"
                        >
                            {parts.name}
                        </Link>
                    )}
                    {parts.directory === "" ? null : (
                        <span className="break-all font-mono text-xs text-slate-500">
                            {parts.directory}
                        </span>
                    )}
                    {file.originalPath === null ? null : (
                        <span className="break-all text-xs text-slate-500">
                            from {file.originalPath}
                        </span>
                    )}
                </h3>
                {/* In a narrow column the actions take their own row so the name and directory
                    keep the full width. A collapsed file has only two small actions that fit
                    beside it. */}
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-end gap-3",
                        !collapsed && "basis-full @xl:basis-auto",
                    )}
                >
                    {/* Tells which files the diff search found text in, also while collapsed. */}
                    {matchCount === 0 ? null : (
                        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-xs whitespace-nowrap text-amber-300 tabular-nums">
                            {matchCount === 1
                                ? "1 match"
                                : `${String(matchCount)} matches`}
                        </span>
                    )}
                    {/* Empty until the body has parsed its patch; on its own row in a narrow
                        column the counts lead and the switches stay at the right edge. */}
                    <span
                        ref={setSummaryElement}
                        className="mr-auto flex items-center gap-2 empty:hidden @xl:mr-0"
                    />
                    {background === null ? null : (
                        <OpenInBackgroundButton
                            target={background}
                            // Matches the height of the copy menu beside it.
                            className="h-7 w-7"
                        />
                    )}
                    {link === null ? null : (
                        <GitDiffCopyPathMenu file={file} name={parts.name} />
                    )}
                    {/* A collapsed file shows no patch, so it has no layout or wrapping to switch. */}
                    {collapsed ? null : (
                        <div className="flex shrink-0 items-center gap-2">
                            <DiffLayoutSwitch
                                label={`Diff layout for ${file.relativePath}`}
                                inline={view.mergeModifiedLines}
                                onChange={(inline) =>
                                    props.onChoose(file.path, { inline })
                                }
                            />
                            <WrapDiffLinesToggle
                                label={`Wrap diff lines for ${file.relativePath}`}
                                wrap={view.wrapLines}
                                onChange={(wrapLines) =>
                                    props.onChoose(file.path, { wrapLines })
                                }
                            />
                            <WholeFileToggle
                                label={`Show whole file ${file.relativePath}`}
                                shown={view.wholeFile}
                                onChange={(wholeFile) =>
                                    props.onChoose(file.path, { wholeFile })
                                }
                            />
                        </div>
                    )}
                </div>
            </div>
            {showsBody ? (
                <div
                    id={bodyId}
                    className="w-full min-w-0 overflow-x-hidden [&>p]:p-3"
                >
                    <DiffSearchCardContext.Provider value={file.path}>
                        <DiffSummarySlotContext.Provider value={summarySlot}>
                            {file.renderBody(view)}
                        </DiffSummarySlotContext.Provider>
                    </DiffSearchCardContext.Provider>
                </div>
            ) : null}
        </section>
    );
});

/**
 * Every file's diff in one scrolling list of cards. The headers replace a separate file list,
 * so each file is named exactly once, right above its own patch. A view of one file, such as
 * a file's worktree diff or a Sync compare, is a list of one without collapsing, so its diff
 * has the same switches in the same place and back restores them the same way.
 *
 * Every file is rendered, and the ones the filter leaves out are hidden. Hidden cards keep
 * their patch, so widening the filter again is instant, and `hidden` also takes them out of
 * layout, the tab order and the accessibility tree. The files should keep their identity
 * between renders, such as by being built in a `useMemo`, so the memoized cards can skip
 * re-rendering.
 */
export function GitDiffList(props: {
    files: GitDiffListFile[];
    /** Omitted for a lone file, which is always shown and has no chevron to fold it. */
    collapsed?: CollapsedGitDiffs;
    /** Omitted where the list has no filter field, which then shows every file. */
    filter?: FileNameFilter;
    /** The list's identity for remembering each file's layout, such as one commit. */
    scope: string;
}) {
    const fileChoices = useGitDiffFileChoices(props.scope);
    const collapsed = props.collapsed;
    const filter = props.filter;
    const choices = fileChoices.choices;
    const [searchStore] = React.useState(() => new DiffSearchStore());
    const listRef = React.useRef<HTMLDivElement>(null);

    // Built only when the files, filter or a layout change, so the search reruns only then.
    const searchFiles = React.useMemo(
        (): DiffSearchListFile[] =>
            props.files
                .filter(
                    (file) =>
                        filter === undefined ||
                        filter.matches(file.relativePath),
                )
                .map((file) => ({
                    path: file.path,
                    source: file.searchSource,
                    mergeModifiedLines: gitDiffBodyView(choices.get(file.path))
                        .mergeModifiedLines,
                })),
        [props.files, filter, choices],
    );

    /** Expands the card the search steps into, leaving an expanded one as it is. */
    const expand = (path: string) => {
        if (collapsed?.isCollapsed(path) === true) {
            collapsed.toggle(path);
        }
    };

    // Names in a patch are often worth looking up elsewhere in the repository or the change.
    return (
        <DiffSearchStoreContext.Provider value={searchStore}>
            <SelectionSearch
                onSearchInDiffs={(text, range) =>
                    searchStore.requestSearch({
                        text,
                        anchor: selectionAnchor(range),
                    })
                }
            >
                <div ref={listRef}>
                    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
                        {props.files.map((file) => (
                            <GitDiffSection
                                key={file.path}
                                file={file}
                                collapsed={
                                    collapsed?.isCollapsed(file.path) ?? false
                                }
                                onToggle={collapsed?.toggle ?? null}
                                choice={choices.get(file.path)}
                                onChoose={fileChoices.choose}
                                filteredOut={
                                    filter !== undefined &&
                                    !filter.matches(file.relativePath)
                                }
                            />
                        ))}
                    </div>
                    <DiffSearch
                        scope={props.scope}
                        files={searchFiles}
                        store={searchStore}
                        listRef={listRef}
                        expand={expand}
                    />
                </div>
            </SelectionSearch>
        </DiffSearchStoreContext.Provider>
    );
}
