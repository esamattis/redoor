import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    GitCommitHorizontal,
    History,
    Undo2,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { CopyableGitRef } from "#ui/components/copyable-git-ref";
import { Tooltip } from "#ui/components/tooltip";
import { GitDiffResultView } from "#ui/components/browser/git";
import {
    GitDiffCollapseControls,
    GitDiffFilterField,
    GitDiffList,
    useCollapsedGitDiffs,
    useGitDiffFilterQuery,
    type GitDiffListFile,
} from "#ui/components/browser/git-diff-list";
import {
    AuthorAvatar,
    ChangeBadge,
    CommitAge,
    GitPanelBar,
    changeLabel,
    displayRevision,
    revisionRefKind,
    shortCommitId,
} from "#ui/components/browser/git-parts";
import { formatModifiedAge } from "#ui/components/browser/utils";
import { SelectionSearch } from "#ui/components/browser/selection-search";
import {
    gitCommitDiffQueryOptions,
    gitCommitNeighborsQueryOptions,
} from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import type { GitChangeState } from "#bindings/GitChangeState";
import type { GitCommitDiffResponse } from "#bindings/GitCommitDiffResponse";
import type { GitCommitSummary } from "#bindings/GitCommitSummary";
import type { GitRevisionEntry } from "#bindings/GitRevisionEntry";
import type { GitTreeEntry } from "#bindings/GitTreeEntry";
import type { LsEntry } from "#bindings/LsEntry";

/**
 * Marks the page as a read-only view of history, directly below the breadcrumbs, so it is
 * impossible to mistake committed content for the working files. It also offers the way
 * back to the working tree, which drops only the revision from the URL. In a narrow column it
 * keeps to one row: the summary already heads the page's own views, and the links show their icons.
 */
export function RevisionBanner(props: {
    agent: Agent;
    path: string;
    rev: string;
    /** Absent while the revision could not be resolved. */
    commit: GitCommitSummary | null;
}) {
    const now = Date.now();
    const commit = props.commit;
    const showsCommitId = commit !== null && !commit.id.startsWith(props.rev);

    // A name is copied as people type it; a hash is copied whole, though shown short.
    const copiedRevision =
        commit === null || showsCommitId
            ? {
                  kind: revisionRefKind(props.rev),
                  value: displayRevision(props.rev),
              }
            : { kind: "commit" as const, value: commit.id };

    return (
        <section
            aria-label="Git revision"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm"
        >
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-600/70 bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-200">
                <History className="h-3.5 w-3.5" aria-hidden="true" />
                History
            </span>
            <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-amber-100">
                Viewing
                <CopyableGitRef
                    kind={copiedRevision.kind}
                    value={copiedRevision.value}
                >
                    <code
                        aria-label="Revision"
                        title={props.rev}
                        className="truncate rounded bg-amber-900/40 px-1 font-mono text-amber-50"
                    >
                        {displayRevision(props.rev)}
                    </code>
                </CopyableGitRef>
                {showsCommitId ? (
                    <CopyableGitRef
                        kind="commit"
                        value={commit.id}
                        className="text-amber-200/80"
                    >
                        <span className="font-mono text-xs">
                            ({shortCommitId(commit.id)})
                        </span>
                    </CopyableGitRef>
                ) : null}
            </span>
            {commit === null ? null : (
                <span className="min-w-0 flex-1 truncate text-slate-300 @max-xl:hidden">
                    <span title={commit.summary}>{commit.summary}</span>
                    <span className="text-slate-500">
                        {" "}
                        · {commit.author_name} ·{" "}
                        <time
                            dateTime={new Date(
                                commit.authored_at * 1000,
                            ).toISOString()}
                            title={new Date(
                                commit.authored_at * 1000,
                            ).toLocaleString()}
                        >
                            {formatModifiedAge(commit.authored_at, now)}
                        </time>
                    </span>
                </span>
            )}
            <span className="text-xs text-amber-200/80 @max-xl:hidden">
                Read-only
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
                {commit === null ? null : (
                    <Tooltip content="Show the changes this commit made">
                        <Link
                            {...browserRoute(props.agent, props.path)}
                            search={{ view: "git", rev: props.rev }}
                            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900/50 @max-xl:p-2"
                        >
                            <GitCommitHorizontal
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                            />
                            <span className="@max-xl:sr-only">
                                Commit changes
                            </span>
                        </Link>
                    </Tooltip>
                )}
                <Tooltip content="Leave history and show the current working files">
                    {/* Only the revision goes, so the reader stays on the same view, such as
                        the Git changes, instead of falling back to the file list. */}
                    <Link
                        {...browserRoute(props.agent, props.path)}
                        search={(previous) => ({ ...previous, rev: undefined })}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900/50 @max-xl:p-2"
                    >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="@max-xl:sr-only">Working tree</span>
                    </Link>
                </Tooltip>
            </div>
        </section>
    );
}

/**
 * Converts a committed tree listing into file-list rows, so a revision is listed by the same
 * component as a working directory. Git records no owner, group or modification time, so
 * those stay empty and the read-only list does not show them. Submodules are directories in
 * a checkout, so they list among the directories.
 */
export function revisionListingEntries(entries: GitTreeEntry[]): LsEntry[] {
    return entries.map((entry) => ({
        name: entry.name,
        type:
            entry.kind === "directory" || entry.kind === "submodule"
                ? "directory"
                : "file",
        size: entry.size ?? 0,
        owner: null,
        group: null,
        uid: 0,
        gid: 0,
        modified_at: 0,
    }));
}

/**
 * The Git revision a listing shows. Its entries can be selected and downloaded at the
 * commit, except names Git records as symlinks or submodules: Git stores a symlink as its
 * target and a submodule as a commit id, so neither has content a copy or download could
 * write.
 */
export type RevisionListing = {
    commitId: string;
    nonTransferableNames: ReadonlySet<string>;
};

/** Describes a committed directory listing for the shared file list. */
export function revisionListing(
    commitId: string,
    entry: Extract<GitRevisionEntry, { type: "directory" }>,
): RevisionListing {
    return {
        commitId,
        nonTransferableNames: new Set(
            entry.entries.flatMap((child) =>
                child.kind === "symlink" || child.kind === "submodule"
                    ? [child.name]
                    : [],
            ),
        ),
    };
}

/**
 * Explains a committed listing that is not complete. Without it a directory cut at the
 * listing limit, or one with names that cannot be linked, would look like it has no more
 * entries than are shown.
 */
export function RevisionListingNotice(props: {
    entry: Extract<GitRevisionEntry, { type: "directory" }>;
}) {
    const omitted = props.entry.omitted_non_utf8_entries;

    if (!props.entry.truncated && omitted === 0) {
        return null;
    }

    return (
        <div
            role="status"
            className="m-2 grid gap-1 rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200 @4xl:m-4"
        >
            {props.entry.truncated ? (
                <p className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    This directory has more entries than can be listed. Only the
                    first {props.entry.entries.length} are shown.
                </p>
            ) : null}
            {omitted === 0 ? null : (
                <p className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    {omitted === 1
                        ? "1 entry is hidden because its name is not valid UTF-8."
                        : `${omitted} entries are hidden because their names are not valid UTF-8.`}
                </p>
            )}
        </div>
    );
}

/** Counts a commit's changed files per kind, in a stable order for the summary bar. */
function countChanges(diff: GitCommitDiffResponse) {
    const order: GitChangeState[] = [
        "added",
        "modified",
        "deleted",
        "renamed",
        "copied",
        "type_changed",
    ];

    return order.flatMap((kind) => {
        const count = diff.files.filter((file) => file.change === kind).length;

        return count === 0 ? [] : [{ kind, count }];
    });
}

/**
 * One side of the commit stepper. It names the neighbouring commit by its summary, because
 * a short id says nothing about where the step leads, and stays in place as a disabled
 * cell when there is no commit that way, so the other side never jumps across.
 */
function CommitStepLink(props: {
    agent: Agent;
    path: string;
    direction: "previous" | "next";
    commit: GitCommitSummary | null;
    /** Shown instead of a commit while the neighbours load or when there is none. */
    placeholder: string;
}) {
    const isPrevious = props.direction === "previous";
    const label = isPrevious ? "Previous" : "Next";
    const Icon = isPrevious ? ChevronLeft : ChevronRight;
    const commit = props.commit;

    const content = (
        <>
            <Icon
                className={cn(
                    "h-4 w-4 shrink-0",
                    isPrevious ? "order-first" : "order-last",
                )}
                aria-hidden="true"
            />
            <span
                className={cn(
                    "min-w-0 flex-1",
                    isPrevious ? "text-left" : "text-right",
                )}
            >
                <span className="block text-xs font-medium text-slate-400">
                    {label}
                </span>
                <span
                    className={cn(
                        "block truncate text-sm",
                        commit === null ? "text-slate-500" : "text-slate-100",
                    )}
                >
                    {commit === null
                        ? props.placeholder
                        : commit.summary || shortCommitId(commit.id)}
                </span>
            </span>
        </>
    );

    const cell =
        "flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 @xl:px-3";

    if (commit === null) {
        return (
            <span
                aria-disabled="true"
                className={cn(cell, "border-slate-800/60 text-slate-600")}
            >
                {content}
            </span>
        );
    }

    return (
        <Tooltip
            content={`${isPrevious ? "Older" : "Newer"} change to this path: ${shortCommitId(commit.id)} ${commit.summary}`}
            className="min-w-0"
        >
            <Link
                {...browserRoute(props.agent, props.path)}
                search={{ view: "git", rev: commit.id }}
                aria-label={`${label} commit: ${commit.summary || shortCommitId(commit.id)}`}
                className={cn(
                    cell,
                    "border-slate-700 bg-slate-900/40 text-slate-300 transition-colors hover:border-blue-400/50 hover:bg-tint hover:text-blue-300",
                )}
            >
                {content}
            </Link>
        </Tooltip>
    );
}

/**
 * Steps to the commit before or after this one in the browsed path's history, the same
 * history the Commits tab lists, so a reader can page through changes without going back
 * to the list. The neighbours load apart from the diff because finding the newer one walks
 * from HEAD, which takes longer the older the commit is.
 */
function CommitStepper(props: {
    agent: Agent;
    path: string;
    commitId: string;
}) {
    const query = useQuery(
        gitCommitNeighborsQueryOptions(props.agent, props.path, props.commitId),
    );

    const placeholder = (none: string) =>
        query.isPending ? "Loading..." : query.isError ? "Unavailable" : none;

    return (
        <nav
            aria-label="Commit navigation"
            className="grid grid-cols-2 gap-2 @xl:grid-cols-[minmax(0,20rem)_minmax(0,20rem)] @xl:justify-between"
        >
            <CommitStepLink
                agent={props.agent}
                path={props.path}
                direction="previous"
                commit={query.data?.older ?? null}
                placeholder={placeholder("First change")}
            />
            <CommitStepLink
                agent={props.agent}
                path={props.path}
                direction="next"
                commit={query.data?.newer ?? null}
                placeholder={placeholder("Latest change")}
            />
        </nav>
    );
}

/**
 * Resolves a commit's changed files to the diff cards that show them. File names link to the
 * file at the commit, or at the parent for deleted files, which no longer exist at the
 * commit, and links keep the browsed revision so they follow a branch rather than pin it.
 */
function commitDiffFiles(options: {
    agent: Agent;
    rev: string;
    diff: GitCommitDiffResponse;
}): GitDiffListFile[] {
    const parentId = options.diff.parent_id;

    return options.diff.files.map((file) => ({
        path: file.path,
        relativePath: file.repository_relative_path,
        originalPath: null,
        change: file.change,
        link: {
            agent: options.agent,
            search: {
                rev:
                    file.change === "deleted" && parentId !== null
                        ? parentId
                        : options.rev,
            },
            hasWorkingCopy: file.change !== "deleted",
        },
        regionLabel: `Commit diff for ${file.repository_relative_path}`,
        renderBody: (view) => (
            <GitDiffResultView
                result={file.result}
                view={view}
                editorFile={
                    file.change === "deleted"
                        ? undefined
                        : { device: options.agent, path: file.path }
                }
            />
        ),
    }));
}

/**
 * Shows what the revision's commit changed below the browsed path, compared with its first
 * parent: who made the commit and when, a way to step to the neighbouring commits, a
 * summary of the changed files, then each file's diff under a header naming it. It is laid
 * out for phones first: the header is a title over one line of facts, and the summary and
 * diff controls share one bar, so the first patch starts high on a small screen. File names
 * link to the file at the commit, or at the parent for deleted files, which no longer exist
 * at the commit.
 */
export function GitCommitView(props: {
    agent: Agent;
    path: string;
    /** The revision as browsed, which links keep so they follow a branch rather than pin it. */
    rev: string;
    /** The commit `rev` resolved to, which the diff is fetched and cached by. */
    commitId: string;
}) {
    const diffQuery = useQuery(
        gitCommitDiffQueryOptions(props.agent, props.path, props.commitId),
    );

    const scope = `${props.agent.id}:${props.path}:${props.commitId}`;

    // The commit's patches arrive in one response anyway, so they start expanded.
    const collapsed = useCollapsedGitDiffs({
        scope,
        initiallyCollapsed: false,
    });

    const filterQuery = useGitDiffFilterQuery(scope);

    // Built once per commit diff, so the memoized diff cards keep their props while the
    // filter or another file's state changes.
    const files = React.useMemo(
        () =>
            diffQuery.data === undefined
                ? []
                : commitDiffFiles({
                      agent: props.agent,
                      rev: props.rev,
                      diff: diffQuery.data,
                  }),
        [props.agent, props.rev, diffQuery.data],
    );

    if (diffQuery.isPending) {
        return (
            <p
                role="status"
                className="px-4 py-10 text-center text-sm text-slate-400"
            >
                Loading commit changes...
            </p>
        );
    }

    if (diffQuery.isError) {
        return (
            <p
                role="alert"
                className="px-4 py-10 text-center text-sm text-red-300"
            >
                {getErrorMessage(
                    diffQuery.error,
                    "Failed to load commit changes",
                )}
            </p>
        );
    }

    const diff = diffQuery.data;
    const commit = diff.commit;
    const now = Date.now();

    const filter = filterQuery.filter;

    const shownFiles = files.filter((file) =>
        filter.matches(file.relativePath),
    );

    return (
        <>
            <header className="grid gap-3 border-b border-slate-800 px-4 py-3 @xl:px-5 @xl:py-4">
                <div className="min-w-0">
                    {/* Names in a commit message are often worth looking up in the repository. */}
                    <SelectionSearch>
                        <h2 className="break-words text-base font-semibold leading-snug text-slate-50">
                            {commit.summary || "(no message)"}
                        </h2>
                        {/* The body keeps its own line breaks, since commit messages are wrapped by hand. */}
                        {diff.body ? (
                            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">
                                {diff.body}
                            </p>
                        ) : null}
                    </SelectionSearch>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-400">
                        <AuthorAvatar name={commit.author_name} size="xs" />
                        <span
                            className="font-medium text-slate-200"
                            title={commit.author_email}
                        >
                            {commit.author_name}
                        </span>
                        <span>
                            <span className="hidden @xl:inline">
                                committed{" "}
                            </span>
                            <CommitAge
                                authoredAt={commit.authored_at}
                                now={now}
                            />
                        </span>
                        {/* The dot wraps with the id, so no line ends in a dangling separator. */}
                        <span className="whitespace-nowrap">
                            <span aria-hidden="true" className="text-slate-600">
                                ·{" "}
                            </span>
                            <CopyableGitRef
                                kind="commit"
                                value={commit.id}
                                className="align-middle"
                            >
                                <code
                                    aria-label="Commit id"
                                    title={commit.id}
                                    className="font-mono text-slate-300"
                                >
                                    {shortCommitId(commit.id)}
                                </code>
                            </CopyableGitRef>
                        </span>
                    </p>
                    <CommitNotes
                        agent={props.agent}
                        path={props.path}
                        diff={diff}
                    />
                </div>
                <CommitStepper
                    agent={props.agent}
                    path={props.path}
                    commitId={props.commitId}
                />
            </header>
            <GitPanelBar
                actions={
                    <>
                        <GitDiffCollapseControls
                            collapsed={collapsed}
                            fileCount={diff.files.length}
                        />
                    </>
                }
            >
                <span className="font-medium text-slate-100">
                    {diff.files.length}
                    {diff.truncated ? "+" : ""}
                    <span className="hidden @xl:inline"> changed</span>
                    {diff.files.length === 1 ? " file" : " files"}
                </span>
                {countChanges(diff).map((entry) => (
                    <span
                        key={entry.kind}
                        className="inline-flex items-center gap-1 text-xs text-slate-400"
                    >
                        <ChangeBadge kind={entry.kind} />
                        {entry.count}
                        <span className="hidden @xl:inline">
                            {changeLabel(entry.kind).toLowerCase()}
                        </span>
                    </span>
                ))}
            </GitPanelBar>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-2 py-3 @xl:gap-4 @xl:px-5 @xl:py-4">
                {diff.files.length === 0 ? (
                    <p
                        role="status"
                        className="px-2 text-sm text-slate-300 @xl:px-0"
                    >
                        This commit changed nothing below this path.
                    </p>
                ) : null}
                {diff.truncated ? (
                    <p
                        role="status"
                        className="flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-300"
                    >
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        The commit changed more files than can be shown. Open a
                        subdirectory to see the rest.
                    </p>
                ) : null}
                {files.length === 0 ? null : (
                    <GitDiffFilterField
                        query={filterQuery.query}
                        onChange={filterQuery.setQuery}
                        filter={filter}
                        shownCount={shownFiles.length}
                        totalCount={files.length}
                    />
                )}
                <GitDiffList
                    files={files}
                    collapsed={collapsed}
                    filter={filter}
                    scope={scope}
                />
            </div>
        </>
    );
}

/**
 * The facts about a commit that only some commits have: that it is the root, a merge
 * compared with one of its parents, or that the view leaves out changes outside the
 * browsed path. They read as small print under the header instead of crowding its line.
 */
function CommitNotes(props: {
    agent: Agent;
    path: string;
    diff: GitCommitDiffResponse;
}) {
    const diff = props.diff;
    const parentId = diff.parent_id;
    const isMerge = diff.commit.parent_ids.length > 1;
    const isScoped = diff.repository_relative_path !== "";

    if (parentId !== null && !isMerge && !isScoped) {
        return null;
    }

    return (
        <ul className="mt-1.5 grid gap-0.5 text-xs text-slate-500">
            {parentId === null ? (
                <li>Root commit: every file was added.</li>
            ) : isMerge ? (
                // The stepper follows the path's history, so the compared parent gets its own link.
                <li>
                    Merge, compared with first parent{" "}
                    <CopyableGitRef
                        kind="commit"
                        value={parentId}
                        className="align-middle"
                    >
                        <Link
                            {...browserRoute(props.agent, props.path)}
                            search={{ view: "git", rev: parentId }}
                            className="font-mono text-blue-300 hover:underline"
                        >
                            {shortCommitId(parentId)}
                        </Link>
                    </CopyableGitRef>
                </li>
            ) : null}
            {isScoped ? (
                <li>
                    Only changes to{" "}
                    <code className="break-all font-mono text-slate-300">
                        {diff.repository_relative_path}
                    </code>
                </li>
            ) : null}
        </ul>
    );
}
