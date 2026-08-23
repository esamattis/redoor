import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    AlertTriangle,
    CheckCircle2,
    GitBranch,
    MoreHorizontal,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { ActionMenu } from "#ui/components/action-menu";
import { Checkbox } from "#ui/components/checkbox";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { UnifiedDiff } from "#ui/components/browser/unified-diff";
import { gitDiffQueryOptions, gitStatusQueryOptions } from "#ui/queries";
import { getErrorMessage } from "#ui/components/browser/utils";
import type { GitChangeState } from "#bindings/GitChangeState";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { GitDiffResult } from "#bindings/GitDiffResult";
import type { GitStatusEntry } from "#bindings/GitStatusEntry";

type GitStatusItem = {
    entry: GitStatusEntry;
    state: GitChangeState | "conflicted" | "untracked";
};

/** Derives status sections and one de-duplicated diff order from the rendered rows. */
export function groupGitStatusEntries(entries: GitStatusEntry[]) {
    const ordinaryEntries = entries.filter(
        (entry) => entry.conflict_state === null,
    );
    const conflicts: GitStatusItem[] = entries
        .filter((entry) => entry.conflict_state !== null)
        .map((entry) => ({ entry, state: "conflicted" }));
    const untracked: GitStatusItem[] = ordinaryEntries
        .filter(
            (entry) =>
                entry.index_state === "unmodified" &&
                entry.worktree_state === "added",
        )
        .map((entry) => ({ entry, state: "untracked" }));
    const staged: GitStatusItem[] = ordinaryEntries
        .filter((entry) => entry.index_state !== "unmodified")
        .map((entry) => ({ entry, state: entry.index_state }));
    const unstaged: GitStatusItem[] = ordinaryEntries
        .filter(
            (entry) =>
                entry.worktree_state !== "unmodified" &&
                !untracked.some((item) => item.entry.path === entry.path),
        )
        .map((entry) => ({ entry, state: entry.worktree_state }));
    const seenPaths = new Set<string>();
    const diffEntries = [...conflicts, ...staged, ...unstaged, ...untracked]
        .map((item) => item.entry)
        .filter((entry) => {
            if (seenPaths.has(entry.path)) {
                return false;
            }
            seenPaths.add(entry.path);
            return true;
        });
    return { conflicts, staged, unstaged, untracked, diffEntries };
}

/** Presents repository identity consistently above status and file comparisons. */
function GitHeader(props: {
    agent: Agent;
    title: string;
    repositoryRoot: string;
    reference: string;
    description: string;
}) {
    return (
        <header className="border-b border-slate-800 bg-linear-to-br from-emerald-500/10 via-transparent to-transparent p-4 sm:p-5">
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                {props.reference}
            </p>
            <h1 className="break-all text-xl font-bold tracking-tight text-slate-50 sm:text-2xl">
                {props.title}
            </h1>
            <p className="mt-1.5 max-w-3xl text-sm text-slate-400">
                {props.description}
            </p>
            <Link
                to={props.agent.getBrowserUrl(props.repositoryRoot)}
                search={{ view: "git" }}
                className="mt-1.5 block break-all font-mono text-xs text-blue-300 hover:underline"
            >
                Repository: {props.repositoryRoot}
            </Link>
        </header>
    );
}

/** Converts API status vocabulary into compact labels suitable for repeated rows. */
function formatChangeState(
    state: GitChangeState | "conflicted" | "untracked",
): string {
    return state.replace("_", " ");
}

/** Lists one status category while preserving real links for new-tab navigation. */
function GitStatusSection(props: {
    agent: Agent;
    title: string;
    entries: GitStatusItem[];
    diffAnchorByPath: Map<string, string> | null;
}) {
    if (props.entries.length === 0) {
        return null;
    }
    return (
        <section
            aria-labelledby={`git-${props.title.toLowerCase().replace(" ", "-")}`}
        >
            <h2
                id={`git-${props.title.toLowerCase().replace(" ", "-")}`}
                className="mb-1 text-sm font-semibold text-slate-200"
            >
                {props.title}{" "}
                <span className="text-slate-500">({props.entries.length})</span>
            </h2>
            <ul className="divide-y divide-slate-800 overflow-hidden rounded-md border border-slate-800 bg-slate-950/40">
                {props.entries.map((item) => (
                    <li
                        key={`${props.title}:${item.entry.path}`}
                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                    >
                        <span className="min-w-0">
                            <Link
                                to={props.agent.getBrowserUrl(item.entry.path)}
                                search={{ view: "git" }}
                                className="block break-all font-mono text-sm text-blue-300 hover:underline"
                            >
                                {item.entry.repository_relative_path}
                            </Link>
                            {item.entry.original_path !== null ? (
                                <span className="mt-1 block break-all text-xs text-slate-500">
                                    from {item.entry.original_path}
                                </span>
                            ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                            {props.diffAnchorByPath === null ? null : (
                                <a
                                    href={`#${props.diffAnchorByPath.get(item.entry.path)}`}
                                    className="text-xs text-blue-300 hover:underline"
                                >
                                    Diff
                                </a>
                            )}
                            <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs capitalize text-slate-400">
                                {formatChangeState(item.state)}
                            </span>
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** Groups directory status into the same concepts users see in a normal Git workflow. */
export function GitDirectoryView(props: {
    agent: Agent;
    path: string;
    showDiffs: boolean;
}) {
    const statusQuery = useQuery(
        gitStatusQueryOptions(props.agent, props.path),
    );
    const groups = groupGitStatusEntries(statusQuery.data?.entries ?? []);
    const diffQuery = useQuery({
        ...gitDiffQueryOptions(
            props.agent,
            groups.diffEntries.map((entry) => entry.path),
            "full",
        ),
        enabled: props.showDiffs && groups.diffEntries.length > 0,
    });
    if (statusQuery.isPending) {
        return (
            <p role="status" className="text-sm text-slate-400">
                Loading Git status...
            </p>
        );
    }
    if (statusQuery.isError) {
        return (
            <p role="alert" className="text-sm text-red-300">
                {getErrorMessage(
                    statusQuery.error,
                    "Failed to load Git status",
                )}
            </p>
        );
    }

    const status = statusQuery.data;
    const { conflicts, staged, unstaged, untracked, diffEntries } = groups;
    const diffAnchorByPath = props.showDiffs
        ? new Map(
              diffEntries.map((entry, index) => [
                  entry.path,
                  `git-diff-${index}`,
              ]),
          )
        : null;
    const reference = status.branch_name
        ? `Branch ${status.branch_name}`
        : status.detached_head_id
          ? `Detached at ${status.detached_head_id.slice(0, 12)}`
          : "Unborn HEAD";
    const tracking = [
        status.upstream ? `Tracking ${status.upstream}` : null,
        status.ahead === null ? null : `${status.ahead} ahead`,
        status.behind === null ? null : `${status.behind} behind`,
    ].filter((part): part is string => part !== null);

    return (
        <BrowserViewCard>
            <GitHeader
                agent={props.agent}
                title={status.path.split("/").filter(Boolean).pop() ?? "/"}
                repositoryRoot={status.repository_root}
                reference={reference}
                description={
                    tracking.length > 0
                        ? tracking.join(" · ")
                        : "Changes below this directory, compared with HEAD and the index."
                }
            />
            <div className="grid gap-4 p-3 sm:p-5">
                {status.entries.length === 0 ? (
                    <div
                        role="status"
                        className="flex items-center gap-3 text-sm text-emerald-300"
                    >
                        <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                        Working tree is clean for this directory.
                    </div>
                ) : null}
                <GitStatusSection
                    agent={props.agent}
                    title="Conflicts"
                    entries={conflicts}
                    diffAnchorByPath={diffAnchorByPath}
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Staged changes"
                    entries={staged}
                    diffAnchorByPath={diffAnchorByPath}
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Unstaged changes"
                    entries={unstaged}
                    diffAnchorByPath={diffAnchorByPath}
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Untracked files"
                    entries={untracked}
                    diffAnchorByPath={diffAnchorByPath}
                />
                {status.entries.length > 0 && !props.showDiffs ? (
                    <Link
                        to={props.agent.getBrowserUrl(props.path)}
                        search={{ view: "git", diff: true }}
                        className="w-fit rounded-md border border-blue-400/40 bg-blue-500/15 px-3 py-2 text-sm font-semibold text-blue-200 transition-colors hover:border-blue-300/60 hover:bg-blue-500/25"
                    >
                        Load all diffs
                    </Link>
                ) : null}
                {status.truncated ? (
                    <p
                        role="status"
                        className="flex items-center gap-2 text-sm text-amber-300"
                    >
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        Status is truncated. Narrow the directory to inspect
                        more entries.
                    </p>
                ) : null}
                {status.omitted_non_utf8_entries > 0 ? (
                    <p role="status" className="text-sm text-amber-300">
                        {status.omitted_non_utf8_entries} non-UTF-8 path entries
                        were omitted.
                    </p>
                ) : null}
                {props.showDiffs && diffEntries.length > 0 ? (
                    <div className="grid gap-4">
                        {diffQuery.isPending ? (
                            <p role="status" className="text-sm text-slate-400">
                                Loading all Git diffs...
                            </p>
                        ) : diffQuery.isError ? (
                            <p role="alert" className="text-sm text-red-300">
                                {getErrorMessage(
                                    diffQuery.error,
                                    "Failed to load Git diffs",
                                )}
                            </p>
                        ) : (
                            diffQuery.data.diffs.map((diff, index) => (
                                <section
                                    key={`${diff.path}:${index}`}
                                    id={`git-diff-${index}`}
                                    aria-label={`Git diff for ${diff.path}`}
                                    className="scroll-mt-4 overflow-hidden rounded-md border border-slate-800 bg-slate-950/30"
                                >
                                    <h2 className="break-all border-b border-slate-800 px-3 py-2 font-mono text-sm font-semibold text-slate-200">
                                        {diffEntries[index]
                                            ?.repository_relative_path ??
                                            diff.path}
                                    </h2>
                                    <div className="file-diff-host git-file-diff w-full min-w-0 overflow-x-hidden">
                                        <GitDiffResultView
                                            result={diff.result}
                                        />
                                    </div>
                                </section>
                            ))
                        )}
                    </div>
                ) : null}
            </div>
        </BrowserViewCard>
    );
}

/** Explains all non-text outcomes rather than presenting them as empty patches. */
function GitDiffResultView(props: { result: GitDiffResult }) {
    if (props.result.type === "text") {
        return (
            <UnifiedDiff
                unifiedDiff={props.result.unified_diff}
                emptyMessage="No changes in this comparison."
            />
        );
    }
    const messages = {
        no_changes: "No changes in this comparison.",
        untracked:
            "This file is untracked. Git has no committed version to compare.",
        ignored: "This file is ignored by Git. No diff is generated.",
        binary: "This is a binary file, so a text diff is not available.",
        too_large:
            "This file or its generated patch is too large to display safely.",
        unsupported_entry: "This Git entry cannot be displayed as a text diff.",
    } satisfies Record<Exclude<GitDiffResult["type"], "text">, string>;
    return (
        <p role="status" className="text-sm text-slate-300">
            {messages[props.result.type]}
        </p>
    );
}

/** Fetches the selected file comparison while keeping full and staged results distinct. */
export function GitFileView(props: {
    agent: Agent;
    path: string;
    context: GitContextResponse;
}) {
    const [mode, setMode] = React.useState<GitDiffMode>("full");
    const diffQuery = useQuery(
        gitDiffQueryOptions(props.agent, [props.path], mode),
    );
    const repositoryRoot =
        props.context.status === "inside_worktree"
            ? props.context.repository_root
            : null;
    return (
        <BrowserViewCard>
            <header className="flex min-h-11 items-center justify-between gap-3 border-b border-slate-800 px-3 py-1.5 sm:px-4">
                <div className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                    <GitBranch
                        className="h-4 w-4 shrink-0 text-emerald-400"
                        aria-hidden="true"
                    />
                    <span className="min-w-0">
                        <span className="block truncate font-medium">
                            {mode === "staged"
                                ? "Staged changes"
                                : "All changes"}
                        </span>
                        {repositoryRoot === null ? null : (
                            <Link
                                to={props.agent.getBrowserUrl(repositoryRoot)}
                                search={{ view: "git" }}
                                className="block truncate font-mono text-[11px] leading-3.5 text-blue-300 hover:underline"
                            >
                                Repository: {repositoryRoot}
                            </Link>
                        )}
                    </span>
                </div>
                <ActionMenu
                    label="Git diff options"
                    title="Git diff options"
                    closeAriaLabel="Close Git diff options"
                    hideTitle={false}
                    icon={<MoreHorizontal className="h-4 w-4" />}
                    variant="icon"
                >
                    {() => (
                        <Checkbox
                            checked={mode === "staged"}
                            label="Staged changes only"
                            title={false}
                            className="w-full px-3 py-2"
                            onCheckedChange={(stagedOnly) =>
                                setMode(stagedOnly ? "staged" : "full")
                            }
                        >
                            Staged changes only
                        </Checkbox>
                    )}
                </ActionMenu>
            </header>
            <section
                aria-label={`${mode === "full" ? "Full" : "Staged"} Git diff`}
                className="file-diff-host git-file-diff w-full min-w-0 overflow-x-hidden bg-slate-950/30"
            >
                {diffQuery.isPending ? (
                    <p role="status" className="p-4 text-sm text-slate-400">
                        Loading {mode} Git diff...
                    </p>
                ) : diffQuery.isError ? (
                    <p role="alert" className="p-4 text-sm text-red-300">
                        {getErrorMessage(
                            diffQuery.error,
                            "Failed to load Git diff",
                        )}
                    </p>
                ) : (
                    <GitDiffResultView
                        result={
                            diffQuery.data.diffs[0]?.result ?? {
                                type: "no_changes",
                            }
                        }
                    />
                )}
            </section>
        </BrowserViewCard>
    );
}
