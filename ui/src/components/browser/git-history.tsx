import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
    ArrowDownAZ,
    Clock,
    FolderOpen,
    GitBranch,
    GitCompareArrows,
    History,
    Tag,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { CopyableGitRef } from "#ui/components/copyable-git-ref";
import { IconLinkButton } from "#ui/components/icon-button";
import { LinkButton } from "#ui/components/link-button";
import { Tooltip } from "#ui/components/tooltip";
import {
    SegmentedControl,
    type SegmentedControlOption,
} from "#ui/components/segmented-control";
import {
    AuthorAvatar,
    CommitAge,
    GitPanelBar,
    ListMessage,
    commitRunRevision,
    shortCommitId,
} from "#ui/components/browser/git-parts";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import {
    GIT_LIST_PAGE_SIZE,
    gitLogQueryOptions,
    gitRefsQueryOptions,
    type GitRefListKind,
} from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import type { GitCommitSummary } from "#bindings/GitCommitSummary";
import type { GitRef } from "#bindings/GitRef";
import type { GitRefSort } from "#bindings/GitRefSort";

const browserRouteApi = getRouteApi("/_app/agents/$deviceName/browser/$");

/** The orders a branch or tag list offers, recent first because it is the default. */
const REF_SORT_OPTIONS: ReadonlyArray<SegmentedControlOption<GitRefSort>> = [
    {
        value: "recent",
        label: "Recent",
        icon: Clock,
        tooltip: "Most recently committed first",
    },
    {
        value: "name",
        label: "Name",
        icon: ArrowDownAZ,
        tooltip: "By name, with version numbers in numeric order",
    },
];

/** Asks for the next page of a list, which only exists while the agent reports more rows. */
function LoadMore(props: {
    label: string;
    /** Says how far the list has come, such as "Showing 100 of 345". */
    progress: string;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    onLoadMore: () => void;
}) {
    if (!props.hasNextPage) {
        return null;
    }

    return (
        <div className="flex flex-col items-center gap-2 px-4 pb-5 @xl:px-5">
            <Button
                type="button"
                size="sm"
                variant="secondary"
                tooltip={`Load the next ${GIT_LIST_PAGE_SIZE} rows`}
                disabled={props.isFetchingNextPage}
                onClick={props.onLoadMore}
            >
                {props.isFetchingNextPage ? "Loading..." : props.label}
            </Button>
            <p className="text-xs text-slate-500">{props.progress}</p>
        </div>
    );
}

/**
 * The ends of the run of commits picked in a history list, kept per history entry so Back
 * returns to the same selection after its changes were opened.
 */
const commitSelections = new HistoryEntryStore<string[]>();

/**
 * Picks the ends of a run of commits. The first click starts the run and every later click
 * moves its other end, so two clicks pick any run and a third adjusts it without starting
 * over. Clicking an end drops it.
 */
function toggleCommitSelection(ends: string[], commitId: string): string[] {
    if (ends.includes(commitId)) {
        return ends.filter((id) => id !== commitId);
    }

    const first = ends[0];

    return first === undefined ? [commitId] : [first, commitId];
}

/**
 * The run of listed commits between the picked ends, newest first like the list. An end no
 * longer listed, such as one on a page that was not loaded again, is ignored.
 */
function selectedRun(commits: GitCommitSummary[], ends: string[]) {
    const indices = ends.flatMap((id) => {
        const index = commits.findIndex((commit) => commit.id === id);

        return index === -1 ? [] : [index];
    });

    const run = commits.slice(Math.min(...indices), Math.max(...indices) + 1);

    const newest = run[0];
    const oldest = run.at(-1);

    if (newest === undefined || oldest === undefined) {
        return null;
    }

    return {
        newest,
        oldest,
        count: run.length,
        ids: new Set(run.map((commit) => commit.id)),
    };
}

/**
 * Groups consecutive commits by the local day they were authored, keeping the walk's order.
 * The walk is ordered by commit time, so a rebased or cherry-picked commit can bring a day
 * back after another one; each group is therefore identified by its first commit, not its day.
 */
function groupByDay(commits: GitCommitSummary[]) {
    const groups: Array<{
        id: string;
        day: string;
        commits: GitCommitSummary[];
    }> = [];

    for (const commit of commits) {
        const day = new Date(commit.authored_at * 1000).toLocaleDateString(
            undefined,
            { year: "numeric", month: "short", day: "numeric" },
        );

        const last = groups.at(-1);

        if (last?.day === day) {
            last.commits.push(commit);
        } else {
            groups.push({ id: commit.id, day, commits: [commit] });
        }
    }

    return groups;
}

/**
 * The commits that changed the browsed path, newest first and grouped by day like a
 * timeline. Each opens the same path at that commit's changes, so stepping through
 * history keeps the scope the user chose. A run of them can be picked to show as one diff,
 * the range from the oldest's parent to the newest.
 */
export function GitCommitList(props: {
    agent: Agent;
    path: string;
    /** The browsed commit history starts at, or null for HEAD. */
    commitId: string | null;
    /**
     * HEAD's commit when the worktree is browsed. History is read from this id rather than
     * from HEAD, so every page walks the same history even if HEAD moves between pages.
     */
    headCommitId: string | null;
    /**
     * The worktree's checked-out branch, so the header can say whose history this is
     * instead of an opaque HEAD. Null for a detached HEAD or a browsed revision.
     */
    branchName: string | null;
}) {
    const query = useInfiniteQuery(
        gitLogQueryOptions(
            props.agent,
            props.path,
            props.commitId ?? props.headCommitId,
        ),
    );

    const [selectionEnds, setSelectionEnds] = useHistoryEntryState({
        store: commitSelections,
        scope: `${props.agent.id}:${props.path}:${props.commitId ?? props.headCommitId}`,
        initial: () => [],
    });

    if (query.isPending) {
        return <ListMessage role="status">Loading commits...</ListMessage>;
    }

    if (query.isError) {
        return (
            <ListMessage role="alert">
                {getErrorMessage(query.error, "Failed to load commits")}
            </ListMessage>
        );
    }

    const relativePath = query.data.pages[0]?.repository_relative_path ?? "";
    const commits = query.data.pages.flatMap((page) => page.commits);
    const now = Date.now();

    // The walk only follows the starting commit's ancestors, so name the branch when there
    // is one; otherwise the commit itself is the most precise description.
    const startCommitId = props.commitId ?? props.headCommitId;
    const branchName = props.commitId === null ? props.branchName : null;
    const run = selectedRun(commits, selectionEnds);

    return (
        <>
            <GitPanelBar>
                <span className="inline-flex items-center gap-2 font-medium text-slate-100">
                    <History
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                    />
                    {branchName === null ? "History from" : "History of"}{" "}
                    {branchName !== null ? (
                        <CopyableGitRef kind="branch" value={branchName} />
                    ) : startCommitId !== null ? (
                        <CopyableGitRef kind="commit" value={startCommitId} />
                    ) : (
                        <code className="font-mono">HEAD</code>
                    )}
                </span>
                <span className="text-slate-400">
                    {relativePath === "" ? (
                        branchName === null ? (
                            "This commit and its ancestors."
                        ) : (
                            "Commits reachable from this branch."
                        )
                    ) : (
                        <>
                            Only commits that changed{" "}
                            <code className="font-mono text-slate-200">
                                {relativePath}
                            </code>
                            .
                        </>
                    )}
                </span>
            </GitPanelBar>
            {run === null ? null : (
                <CommitSelectionBar
                    agent={props.agent}
                    path={props.path}
                    newest={run.newest}
                    oldest={run.oldest}
                    count={run.count}
                    onClear={() => setSelectionEnds(() => [])}
                />
            )}
            {commits.length === 0 ? (
                <ListMessage role="status">
                    {relativePath === ""
                        ? "This repository has no commits yet."
                        : "No commits changed this path."}
                </ListMessage>
            ) : (
                <div
                    role="group"
                    aria-label="Commit history"
                    className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-4 @xl:px-5"
                >
                    {groupByDay(commits).map((group) => (
                        <section key={group.id} aria-label={group.day}>
                            <h3 className="mb-2 text-xs font-semibold text-slate-400">
                                {group.day}
                            </h3>
                            <ol className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800">
                                {group.commits.map((commit) => (
                                    <CommitRow
                                        key={commit.id}
                                        agent={props.agent}
                                        path={props.path}
                                        commit={commit}
                                        current={commit.id === props.commitId}
                                        selected={
                                            run?.ids.has(commit.id) ?? false
                                        }
                                        onToggleSelected={() =>
                                            setSelectionEnds((ends) =>
                                                toggleCommitSelection(
                                                    ends,
                                                    commit.id,
                                                ),
                                            )
                                        }
                                        now={now}
                                    />
                                ))}
                            </ol>
                        </section>
                    ))}
                </div>
            )}
            <LoadMore
                label="Load more commits"
                progress={`Showing ${commits.length} commits`}
                hasNextPage={query.hasNextPage}
                isFetchingNextPage={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
            />
        </>
    );
}

/**
 * Opens the picked run of commits as one diff. The range starts at the parent of the oldest,
 * so the oldest commit's own changes are included; a single picked commit opens as itself.
 */
function CommitSelectionBar(props: {
    agent: Agent;
    path: string;
    newest: GitCommitSummary;
    oldest: GitCommitSummary;
    count: number;
    onClear: () => void;
}) {
    const rev =
        props.count === 1
            ? props.newest.id
            : commitRunRevision(props.oldest.id, props.newest.id);

    return (
        <div
            role="group"
            aria-label="Selected commits"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 bg-blue-400/5 px-4 py-2 text-sm @xl:px-5"
        >
            <span role="status" className="min-w-0 flex-1 text-slate-300">
                {props.count === 1
                    ? "1 commit selected. Select another to pick a range."
                    : `${props.count} commits selected`}
            </span>
            <div className="flex items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    tooltip="Clear the selected commits"
                    onClick={props.onClear}
                >
                    Clear
                </Button>
                <Tooltip
                    content={
                        props.count === 1
                            ? "Show the changes of this commit"
                            : "Show the changes of the selected commits as one diff"
                    }
                >
                    <LinkButton
                        {...browserRoute(props.agent, props.path)}
                        search={{ view: "git", rev }}
                        size="sm"
                    >
                        Show changes
                    </LinkButton>
                </Tooltip>
            </div>
        </div>
    );
}

/**
 * One commit of the history. Its message and id open what it changed below the browsed
 * path, the folder opens the path's files at that commit, and the checkbox picks it as an
 * end of a run to show as one diff.
 */
function CommitRow(props: {
    agent: Agent;
    path: string;
    commit: GitCommitSummary;
    /** True for the commit the page is browsing, so the list shows where the user is. */
    current: boolean;
    /** True for commits inside the picked run, its ends included. */
    selected: boolean;
    onToggleSelected: () => void;
    now: number;
}) {
    const commit = props.commit;
    const shortId = shortCommitId(commit.id);

    return (
        <li
            aria-current={props.current ? "true" : undefined}
            className={cn(
                "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors @xl:flex-nowrap",
                props.current
                    ? "bg-blue-400/10"
                    : props.selected
                      ? "bg-blue-400/5"
                      : "hover:bg-tint",
            )}
        >
            <Checkbox
                role="checkbox"
                checked={props.selected}
                onCheckedChange={props.onToggleSelected}
                label={`Select commit ${shortId}`}
                title={
                    props.selected
                        ? "Selected for a combined diff"
                        : "Select to show this and other commits as one diff"
                }
                className="-ml-1 shrink-0"
            />
            <AuthorAvatar name={commit.author_name} />
            <div className="min-w-0 flex-1">
                <Link
                    {...browserRoute(props.agent, props.path)}
                    search={{ view: "git", rev: commit.id }}
                    className="block truncate text-sm font-medium text-slate-100 hover:text-blue-300 hover:underline"
                    title={commit.summary}
                >
                    {commit.summary || "(no message)"}
                </Link>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                    <span className="text-slate-400">{commit.author_name}</span>{" "}
                    committed{" "}
                    <CommitAge
                        authoredAt={commit.authored_at}
                        now={props.now}
                    />
                </p>
            </div>
            {/* In a narrow column the actions take their own row so the message is not cut off
                after a few words. */}
            <span className="flex shrink-0 basis-full items-center justify-end gap-1.5 @xl:basis-auto">
                {props.current ? (
                    <span className="rounded-full border border-blue-400/40 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                        Viewing
                    </span>
                ) : null}
                {commit.parent_ids.length > 1 ? (
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
                        Merge
                    </span>
                ) : null}
                <IconLinkButton
                    {...browserRoute(props.agent, props.path)}
                    search={{ rev: commit.id }}
                    label={`Browse files at ${shortId}`}
                    variant="ghost"
                    size="sm"
                >
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                </IconLinkButton>
                <CopyableGitRef
                    kind="commit"
                    value={commit.id}
                    className="text-slate-400"
                >
                    <Link
                        {...browserRoute(props.agent, props.path)}
                        search={{ view: "git", rev: commit.id }}
                        aria-label={`Changes of commit ${shortId}`}
                        className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 font-mono text-xs text-slate-300 hover:border-blue-400/50 hover:text-blue-300"
                    >
                        {shortId.slice(0, 7)}
                    </Link>
                </CopyableGitRef>
            </span>
        </li>
    );
}

/**
 * A repository's branches or tags, most recently committed first or by name. A ref's name
 * opens the browsed path at that ref, and its commit id opens what the commit changed there.
 * The order is the `refSort` search key, so it survives reload and Back and is shared by
 * both lists.
 */
export function GitRefList(props: {
    agent: Agent;
    path: string;
    /** The repository the page resolved, whose refs are listed. */
    repositoryRoot: string;
    kind: GitRefListKind;
}) {
    const navigate = browserRouteApi.useNavigate();
    const sort = browserRouteApi.useSearch().refSort ?? "recent";

    const query = useInfiniteQuery(
        gitRefsQueryOptions(props.agent, props.repositoryRoot, {
            kind: props.kind,
            sort,
        }),
    );

    const isBranches = props.kind === "branches";
    const noun = isBranches ? "branches" : "tags";

    // The control stays put while a new order loads, so the user can switch straight back.
    const sortControl = (
        <SegmentedControl
            label={`Sort ${noun}`}
            options={REF_SORT_OPTIONS}
            value={sort}
            onChange={(value) =>
                void navigate({
                    search: (previous) => ({
                        ...previous,
                        refSort: value === "recent" ? undefined : value,
                    }),
                    replace: true,
                })
            }
            // A fixed width, because the control is a size container that cannot grow to fit
            // its segments, and one wide enough to show their icons.
            className="w-60 max-w-full"
        />
    );

    if (query.isPending) {
        return (
            <>
                <GitPanelBar actions={sortControl}>{null}</GitPanelBar>
                <ListMessage role="status">{`Loading ${noun}...`}</ListMessage>
            </>
        );
    }

    if (query.isError) {
        return (
            <>
                <GitPanelBar actions={sortControl}>{null}</GitPanelBar>
                <ListMessage role="alert">
                    {getErrorMessage(query.error, `Failed to load ${noun}`)}
                </ListMessage>
            </>
        );
    }

    const refs = query.data.pages.flatMap((page) => page.refs);
    const total = query.data.pages.at(-1)?.total ?? refs.length;
    const now = Date.now();
    const Icon = isBranches ? GitBranch : Tag;

    return (
        <>
            <GitPanelBar actions={sortControl}>
                <span className="inline-flex items-center gap-2 font-medium text-slate-100">
                    <Icon
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                    />
                    {total === 1
                        ? `1 ${isBranches ? "branch" : "tag"}`
                        : `${total} ${noun}`}
                </span>
                <span className="text-slate-400">
                    {sort === "name"
                        ? isBranches
                            ? "Default branch first, then by name, local before remote-tracking."
                            : "By name."
                        : isBranches
                          ? "Default branch first, then most recently committed, including remote-tracking branches."
                          : "Most recently committed first."}
                </span>
            </GitPanelBar>
            {refs.length === 0 ? (
                <ListMessage role="status">
                    {`This repository has no ${noun}.`}
                </ListMessage>
            ) : (
                <div className="px-4 py-4 @xl:px-5">
                    <ul
                        aria-label={isBranches ? "Branches" : "Tags"}
                        className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800"
                    >
                        {refs.map((ref) => (
                            <RefRow
                                key={ref.full_name}
                                agent={props.agent}
                                path={props.path}
                                gitRef={ref}
                                now={now}
                            />
                        ))}
                    </ul>
                </div>
            )}
            <LoadMore
                label={`Load more ${noun}`}
                progress={`Showing ${refs.length} of ${total}`}
                hasNextPage={query.hasNextPage}
                isFetchingNextPage={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
            />
        </>
    );
}

/**
 * One branch or tag. It links by full ref name, which a tag and a branch cannot share, and
 * offers to compare the checkout with it, the usual way to review a branch against `main`.
 */
function RefRow(props: {
    agent: Agent;
    path: string;
    gitRef: GitRef;
    now: number;
}) {
    const ref = props.gitRef;
    const commit = ref.commit;
    const shortId = shortCommitId(commit.id);
    const Icon = ref.kind === "tag" ? Tag : GitBranch;

    return (
        <li
            className={`flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-tint ${ref.is_head ? "bg-emerald-400/5" : ""}`}
        >
            <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ref.is_head ? "bg-emerald-400/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}
            >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                    <CopyableGitRef
                        kind={ref.kind === "tag" ? "tag" : "branch"}
                        value={ref.name}
                        className="text-slate-400"
                    >
                        <Link
                            {...browserRoute(props.agent, props.path)}
                            search={{ rev: ref.full_name }}
                            className="truncate font-mono text-sm font-medium text-slate-100 hover:text-blue-300 hover:underline"
                            title={`Browse ${ref.full_name}`}
                        >
                            {ref.name}
                        </Link>
                    </CopyableGitRef>
                    {ref.is_head ? (
                        <span className="shrink-0 rounded-full border border-emerald-400/40 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                            HEAD
                        </span>
                    ) : null}
                    {ref.is_default ? (
                        <span className="shrink-0 rounded-full border border-blue-400/40 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                            Default
                        </span>
                    ) : null}
                    {ref.kind === "remote_branch" ? (
                        <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
                            Remote
                        </span>
                    ) : null}
                </span>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                    <span title={commit.summary} className="text-slate-400">
                        {commit.summary || "(no message)"}
                    </span>{" "}
                    · {commit.author_name} ·{" "}
                    <CommitAge
                        authoredAt={commit.authored_at}
                        now={props.now}
                    />
                </p>
            </div>
            {/* The checked-out branch compared with itself would always be empty. */}
            {ref.is_head ? null : (
                <IconLinkButton
                    {...browserRoute(props.agent, props.path)}
                    // Symmetric, like `git diff main...HEAD`, so the diff holds only what the
                    // checkout added since it split from this ref, not the reverse of what
                    // the ref gained meanwhile. HEAD stays symbolic so the link follows new
                    // commits.
                    search={{ view: "git", rev: `${ref.full_name}...HEAD` }}
                    label={`Compare checkout with ${ref.name}`}
                    tooltip={`Show what the checked-out commit adds compared with ${ref.name}`}
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                >
                    <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
                </IconLinkButton>
            )}
            <CopyableGitRef
                kind="commit"
                value={commit.id}
                className="shrink-0 text-slate-400"
            >
                <Link
                    {...browserRoute(props.agent, props.path)}
                    search={{ view: "git", rev: commit.id }}
                    aria-label={`Changes of commit ${shortId}`}
                    className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 font-mono text-xs text-slate-300 hover:border-blue-400/50 hover:text-blue-300"
                >
                    {shortId.slice(0, 7)}
                </Link>
            </CopyableGitRef>
        </li>
    );
}
