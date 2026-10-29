import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    FolderOpen,
    FolderTree,
    GitBranch,
    GitCommitHorizontal,
} from "lucide-react";
import { useRef } from "react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { CopyableGitRef } from "#ui/components/copyable-git-ref";
import { IconLinkButton } from "#ui/components/icon-button";
import {
    CommitAge,
    GitPanelBar,
    ListMessage,
    shortCommitId,
} from "#ui/components/browser/git-parts";
import {
    gitWorktreeStatusQueryOptions,
    gitWorktreesQueryOptions,
} from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import { getBaseName } from "#ui/utils/path";
import { useHasBeenVisible } from "#ui/utils/use-has-been-visible";
import type { GitWorktree } from "#bindings/GitWorktree";
import type { GitWorktreeChanges } from "#bindings/GitWorktreeChanges";

/** The pill every worktree row uses for its flags, so they line up across rows. */
const pill =
    "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";

/**
 * Every checkout of the repository, main first and then the most recently active, so the
 * worktrees people are working in lead the list. Each row names the branch it has checked
 * out and whether it holds uncommitted or untracked work, which is what decides whether a
 * worktree is safe to remove or needs attention.
 */
export function GitWorktreeList(props: {
    agent: Agent;
    /** The repository the page resolved, whose worktrees are listed. */
    repositoryRoot: string;
}) {
    const query = useQuery(
        gitWorktreesQueryOptions(props.agent, props.repositoryRoot),
    );

    if (query.isPending) {
        return <ListMessage role="status">Loading worktrees...</ListMessage>;
    }

    if (query.isError) {
        return (
            <ListMessage role="alert">
                {getErrorMessage(query.error, "Failed to load worktrees")}
            </ListMessage>
        );
    }

    const worktrees = query.data.worktrees;
    const now = Date.now();

    return (
        <>
            <GitPanelBar>
                <span className="inline-flex items-center gap-2 font-medium text-slate-100">
                    <FolderTree
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                    />
                    {worktrees.length === 1
                        ? "1 worktree"
                        : `${worktrees.length} worktrees`}
                </span>
                <span className="text-slate-400">
                    Main worktree first, then the most recently active.
                </span>
            </GitPanelBar>
            {worktrees.length === 0 ? (
                <ListMessage role="status">
                    This repository has no worktrees.
                </ListMessage>
            ) : (
                <div className="px-4 py-4 @xl:px-5">
                    <ul
                        aria-label="Worktrees"
                        className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800"
                    >
                        {worktrees.map((worktree) => (
                            <WorktreeRow
                                key={worktree.path}
                                agent={props.agent}
                                worktree={worktree}
                                now={now}
                            />
                        ))}
                    </ul>
                </div>
            )}
            {query.data.truncated ? (
                <p className="px-4 pb-5 text-center text-xs text-slate-500 @xl:px-5">
                    {`Only the first ${worktrees.length} worktrees are shown.`}
                </p>
            ) : null}
        </>
    );
}

/**
 * One checkout. Its name opens the checkout's own Git changes and the folder opens its
 * files; a missing checkout has nothing to open, so it only names where it was registered.
 */
function WorktreeRow(props: {
    agent: Agent;
    worktree: GitWorktree;
    now: number;
}) {
    const worktree = props.worktree;
    const name = getBaseName(worktree.path) || worktree.path;
    const commit = worktree.head_commit;
    const rowRef = useRef<HTMLLIElement>(null);
    const visible = useHasBeenVisible(rowRef);

    return (
        <li
            ref={rowRef}
            aria-current={worktree.is_current ? "true" : undefined}
            className={cn(
                "flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-tint",
                { "bg-blue-400/5": worktree.is_current },
            )}
        >
            <span
                className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    worktree.is_current
                        ? "bg-blue-400/15 text-blue-300"
                        : "bg-slate-800 text-slate-400",
                )}
            >
                <FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {worktree.missing ? (
                        <span
                            className="truncate text-sm font-medium text-slate-400 line-through"
                            title={worktree.path}
                        >
                            {name}
                        </span>
                    ) : (
                        <Link
                            {...browserRoute(props.agent, worktree.path)}
                            search={{ view: "git" }}
                            className="truncate text-sm font-medium text-slate-100 hover:text-blue-300 hover:underline"
                            title={`Open the changes in ${worktree.path}`}
                        >
                            {name}
                        </Link>
                    )}
                    <BranchPill worktree={worktree} />
                    {worktree.is_main ? (
                        <span
                            className={cn(
                                pill,
                                "border-blue-400/40 text-blue-300",
                            )}
                        >
                            Main
                        </span>
                    ) : null}
                    {worktree.is_current ? (
                        <span
                            className={cn(
                                pill,
                                "border-blue-400/40 bg-blue-400/10 text-blue-300",
                            )}
                        >
                            Current
                        </span>
                    ) : null}
                    {worktree.locked ? (
                        <span
                            className={cn(
                                pill,
                                "border-slate-700 text-slate-400",
                            )}
                        >
                            Locked
                        </span>
                    ) : null}
                </span>
                <p
                    className="mt-0.5 truncate font-mono text-xs text-slate-500"
                    title={worktree.path}
                >
                    {worktree.path}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                    {commit === null ? (
                        "No commits yet"
                    ) : (
                        <span title={commit.summary} className="text-slate-400">
                            {commit.summary || "(no message)"}
                        </span>
                    )}
                    {worktree.last_activity_at === null ? null : (
                        <>
                            {" "}
                            · changed{" "}
                            <CommitAge
                                authoredAt={worktree.last_activity_at}
                                now={props.now}
                            />
                        </>
                    )}
                </p>
            </div>
            <span className="flex shrink-0 flex-col items-end gap-1.5 @xl:flex-row @xl:items-center">
                <ChangesSummary
                    agent={props.agent}
                    worktree={worktree}
                    visible={visible}
                />
                {worktree.missing ? null : (
                    <span className="flex items-center gap-1.5">
                        <IconLinkButton
                            {...browserRoute(props.agent, worktree.path)}
                            label={`Browse files in ${name}`}
                            variant="ghost"
                            size="sm"
                        >
                            <FolderOpen
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        </IconLinkButton>
                        {commit === null ? null : (
                            <CopyableGitRef
                                kind="commit"
                                value={commit.id}
                                className="text-slate-400"
                            >
                                <Link
                                    {...browserRoute(
                                        props.agent,
                                        worktree.path,
                                    )}
                                    search={{ view: "git", rev: commit.id }}
                                    aria-label={`Changes of commit ${shortCommitId(commit.id)}`}
                                    className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 font-mono text-xs text-slate-300 hover:border-blue-400/50 hover:text-blue-300"
                                >
                                    {shortCommitId(commit.id).slice(0, 7)}
                                </Link>
                            </CopyableGitRef>
                        )}
                    </span>
                )}
            </span>
        </li>
    );
}

/**
 * Names what a checkout has checked out, in green for a branch and in amber for a detached
 * HEAD, which is where commits are easiest to lose, like the Git view header does.
 */
function BranchPill(props: { worktree: GitWorktree }) {
    const branchName = props.worktree.branch_name;

    if (branchName === null) {
        return (
            <span
                className={cn(
                    pill,
                    "border-amber-400/40 bg-amber-400/10 text-amber-300",
                )}
            >
                <GitCommitHorizontal className="h-3 w-3" aria-hidden="true" />
                Detached
            </span>
        );
    }

    // The pill is the copyable wrapper, so its copy button sits inside the pill's border.
    return (
        <CopyableGitRef
            kind="branch"
            value={branchName}
            className={cn(
                pill,
                "min-w-0 border-emerald-400/40 bg-emerald-400/10 py-0 pr-0.5 font-mono text-emerald-300",
            )}
        >
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">Branch</span>
            <span title={`Branch ${branchName}`} className="truncate">
                {branchName}
            </span>
        </CopyableGitRef>
    );
}

/**
 * Says at a glance whether a checkout holds uncommitted work. A missing checkout has nothing
 * to walk, so it is flagged from the list alone without asking the agent.
 */
function ChangesSummary(props: {
    agent: Agent;
    worktree: GitWorktree;
    /** Whether the row has scrolled into view, so its checkout is worth walking. */
    visible: boolean;
}) {
    if (props.worktree.missing) {
        return (
            <span
                title="The worktree directory no longer exists"
                className={cn(pill, "border-red-400/40 text-red-300")}
            >
                Missing
            </span>
        );
    }

    return (
        <WorktreeStatus
            agent={props.agent}
            path={props.worktree.path}
            visible={props.visible}
        />
    );
}

/**
 * The uncommitted changes of one checkout, fetched apart from the list because counting them
 * walks every file: tracked changes in amber and untracked files apart from them, because
 * `git stash` and `git worktree remove` treat the two differently. Only rows that have been
 * scrolled into view ask, so a long list does not walk checkouts nobody looks at.
 */
function WorktreeStatus(props: {
    agent: Agent;
    path: string;
    visible: boolean;
}) {
    const query = useQuery({
        ...gitWorktreeStatusQueryOptions(props.agent, props.path),
        enabled: props.visible,
    });

    if (query.isPending) {
        return (
            <span
                role="status"
                title="Counting uncommitted changes"
                className={cn(pill, "border-slate-800 text-slate-500")}
            >
                Checking...
            </span>
        );
    }

    if (query.isError) {
        return (
            <span
                title={getErrorMessage(
                    query.error,
                    "Failed to count uncommitted changes",
                )}
                className={cn(pill, "border-red-400/40 text-red-300")}
            >
                Status unavailable
            </span>
        );
    }

    const changes = query.data;

    if (changes.changed === 0 && changes.untracked === 0) {
        return (
            <span
                title="No uncommitted changes"
                className={cn(pill, "border-slate-700 text-slate-400")}
            >
                Clean
            </span>
        );
    }

    return (
        <span className="flex items-center gap-1.5">
            {changes.changed === 0 ? null : (
                <span
                    title="Tracked files with uncommitted changes"
                    className={cn(
                        pill,
                        "border-amber-400/40 bg-amber-400/10 text-amber-300",
                    )}
                >
                    {countLabel(changes, changes.changed, "changed")}
                </span>
            )}
            {changes.untracked === 0 ? null : (
                <span
                    title="Files Git does not track"
                    className={cn(
                        pill,
                        "border-slate-600 bg-slate-800/60 text-slate-300",
                    )}
                >
                    {countLabel(changes, changes.untracked, "untracked")}
                </span>
            )}
        </span>
    );
}

/** Formats a change count, marking it as a lower bound when the agent stopped counting. */
function countLabel(
    changes: GitWorktreeChanges,
    count: number,
    noun: string,
): string {
    return `${count}${changes.truncated ? "+" : ""} ${noun}`;
}
