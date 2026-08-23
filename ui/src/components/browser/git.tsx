import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, GitBranch } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { DetailCard } from "#ui/components/detail-card";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { UnifiedDiff } from "#ui/components/browser/unified-diff";
import { gitDiffQueryOptions, gitStatusQueryOptions } from "#ui/queries";
import { getErrorMessage } from "#ui/components/browser/utils";
import type { GitChangeState } from "#bindings/GitChangeState";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { GitDiffResult } from "#bindings/GitDiffResult";
import type { GitStatusEntry } from "#bindings/GitStatusEntry";

/** Presents repository identity consistently above status and file comparisons. */
function GitHeader(props: {
    title: string;
    repositoryRoot: string;
    reference: string;
    description: string;
}) {
    return (
        <header className="border-b border-slate-800 bg-linear-to-br from-emerald-500/10 via-transparent to-transparent p-6 md:p-8">
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                {props.reference}
            </p>
            <h1 className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl">
                {props.title}
            </h1>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">
                {props.description}
            </p>
            <p className="mt-3 break-all font-mono text-xs text-slate-500">
                Repository: {props.repositoryRoot}
            </p>
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
    entries: Array<{
        entry: GitStatusEntry;
        state: GitChangeState | "conflicted" | "untracked";
    }>;
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
                className="mb-2 text-sm font-semibold text-slate-200"
            >
                {props.title}{" "}
                <span className="text-slate-500">({props.entries.length})</span>
            </h2>
            <ul className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/40">
                {props.entries.map((item) => (
                    <li
                        key={`${props.title}:${item.entry.path}`}
                        className="flex min-w-0 items-center justify-between gap-4 px-4 py-3"
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
                        <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-xs capitalize text-slate-400">
                            {formatChangeState(item.state)}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** Groups directory status into the same concepts users see in a normal Git workflow. */
export function GitDirectoryView(props: { agent: Agent; path: string }) {
    const statusQuery = useQuery(
        gitStatusQueryOptions(props.agent, props.path),
    );
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
    const ordinaryEntries = status.entries.filter(
        (entry) => entry.conflict_state === null,
    );
    const conflicts = status.entries
        .filter((entry) => entry.conflict_state !== null)
        .map((entry) => ({ entry, state: "conflicted" as const }));
    const untracked = ordinaryEntries
        .filter(
            (entry) =>
                entry.index_state === "unmodified" &&
                entry.worktree_state === "added",
        )
        .map((entry) => ({ entry, state: "untracked" as const }));
    const staged = ordinaryEntries
        .filter((entry) => entry.index_state !== "unmodified")
        .map((entry) => ({ entry, state: entry.index_state }));
    const unstaged = ordinaryEntries
        .filter(
            (entry) =>
                entry.worktree_state !== "unmodified" &&
                !untracked.some((item) => item.entry.path === entry.path),
        )
        .map((entry) => ({ entry, state: entry.worktree_state }));
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
        <DetailCard>
            <GitHeader
                title={status.path.split("/").filter(Boolean).pop() ?? "/"}
                repositoryRoot={status.repository_root}
                reference={reference}
                description={
                    tracking.length > 0
                        ? tracking.join(" · ")
                        : "Changes below this directory, compared with HEAD and the index."
                }
            />
            <div className="grid gap-6 p-6 md:p-8">
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
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Staged changes"
                    entries={staged}
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Unstaged changes"
                    entries={unstaged}
                />
                <GitStatusSection
                    agent={props.agent}
                    title="Untracked files"
                    entries={untracked}
                />
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
            </div>
        </DetailCard>
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
        gitDiffQueryOptions(props.agent, props.path, mode),
    );
    const repositoryRoot =
        props.context.repository_root ?? "Unknown repository";
    const relativePath = props.context.repository_relative_path ?? props.path;

    return (
        <DetailCard>
            <GitHeader
                title={
                    relativePath.split("/").filter(Boolean).pop() ??
                    relativePath
                }
                repositoryRoot={repositoryRoot}
                reference={props.context.tracking_state ?? "Git file"}
                description="Compare this path with HEAD using the current worktree or only the staged index entry."
            />
            <div className="grid gap-6 p-6 md:p-8">
                <RadioCardGroup
                    legend="Comparison"
                    legendClassName="text-sm font-medium text-slate-200"
                    optionsClassName="sm:grid-cols-2"
                >
                    <RadioCardOption
                        name="git-diff-mode"
                        value="full"
                        label="Full"
                        description="HEAD compared with the current worktree file, including staged and unstaged edits."
                        checked={mode === "full"}
                        layout="descriptive"
                        onChange={() => setMode("full")}
                    />
                    <RadioCardOption
                        name="git-diff-mode"
                        value="staged"
                        label="Staged"
                        description="HEAD compared only with the index entry."
                        checked={mode === "staged"}
                        layout="descriptive"
                        onChange={() => setMode("staged")}
                    />
                </RadioCardGroup>
                <section
                    aria-label={`${mode === "full" ? "Full" : "Staged"} Git diff`}
                    className="file-diff-host w-full min-w-0 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/30 p-4 md:p-6"
                >
                    {diffQuery.isPending ? (
                        <p role="status" className="text-sm text-slate-400">
                            Loading {mode} Git diff...
                        </p>
                    ) : diffQuery.isError ? (
                        <p role="alert" className="text-sm text-red-300">
                            {getErrorMessage(
                                diffQuery.error,
                                "Failed to load Git diff",
                            )}
                        </p>
                    ) : (
                        <GitDiffResultView result={diffQuery.data.result} />
                    )}
                </section>
            </div>
        </DetailCard>
    );
}
