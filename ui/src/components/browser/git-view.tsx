import React from "react";
import { Link } from "@tanstack/react-router";
import {
    FileDiff,
    FolderGit2,
    FolderTree,
    GitBranch,
    GitCommitHorizontal,
    History,
    Tag,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import type { GitTab } from "#ui/browser-search";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { CopyableGitRef } from "#ui/components/copyable-git-ref";
import { GitCommitList, GitRefList } from "#ui/components/browser/git-history";
import { GitWorktreeList } from "#ui/components/browser/git-worktrees";
import {
    displayRevision,
    revisionRefKind,
    shortCommitId,
} from "#ui/components/browser/git-parts";
import { cn } from "#ui/utils/cn";
import { getBaseName } from "#ui/utils/path";
import type { GitCommitSummary } from "#bindings/GitCommitSummary";
import type { GitContextResponse } from "#bindings/GitContextResponse";

/** Where the browsed path sits in its repository. */
export type GitViewRepository = {
    root: string;
    /** Empty at the repository root. */
    relativePath: string;
};

/** What the Git view is looking at: the checked-out worktree or a browsed revision. */
export type GitViewReference =
    | {
          type: "worktree";
          /** Absent when HEAD is detached. */
          branchName: string | null;
          /** Absent while the branch has no commits yet. */
          headCommitId: string | null;
      }
    | { type: "revision"; rev: string; commit: GitCommitSummary };

/**
 * The Git view of a worktree path, with the repository and HEAD read from its Git context
 * so every worktree page builds the header the same way. Outside a repository, which the
 * loader normally redirects away from, only the changes panel is shown.
 */
export function WorktreeGitView(props: {
    agent: Agent;
    path: string;
    tab: GitTab | undefined;
    context: GitContextResponse;
    changes: React.ReactNode;
}) {
    const context = props.context;

    if (context.status !== "inside_worktree") {
        return <BrowserViewCard>{props.changes}</BrowserViewCard>;
    }

    return (
        <GitView
            agent={props.agent}
            path={props.path}
            tab={props.tab}
            repository={{
                root: context.repository_root,
                relativePath: context.repository_relative_path,
            }}
            reference={{
                type: "worktree",
                branchName: context.branch_name,
                headCommitId: context.head_commit_id,
            }}
            changes={props.changes}
        />
    );
}

/**
 * The whole Git view: one card whose header names the repository, where the browsed path
 * sits in it and what is checked out, followed by a switch between the path's changes,
 * its history and the repository's branches, tags and worktrees. The switch is the `gitTab`
 * search key, so a list survives reload and Back like every other browser view.
 */
export function GitView(props: {
    agent: Agent;
    path: string;
    /** The tab in the URL; absent shows the changes. */
    tab: GitTab | undefined;
    repository: GitViewRepository;
    reference: GitViewReference;
    /** The changes panel: worktree status, a file diff or a commit's changes. */
    changes: React.ReactNode;
}) {
    // History starts at the browsed commit, or at HEAD in the worktree.
    const commitId =
        props.reference.type === "revision" ? props.reference.commit.id : null;

    const headCommitId =
        props.reference.type === "worktree"
            ? props.reference.headCommitId
            : null;

    return (
        <BrowserViewCard>
            <section
                aria-label="Git repository"
                className="border-b border-slate-800"
            >
                {/* Narrow columns keep the badge beside the name, so the header costs one row there. */}
                <div className="flex items-center gap-3 px-4 pt-3 @xl:flex-wrap @xl:gap-x-4 @xl:gap-y-3 @xl:px-5 @xl:pt-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3 @xl:basis-72">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-blue-400/30 bg-blue-400/10 text-blue-300 @xl:h-10 @xl:w-10">
                            <FolderGit2
                                className="h-4 w-4 @xl:h-5 @xl:w-5"
                                aria-hidden="true"
                            />
                        </span>
                        <div className="min-w-0">
                            <RepositoryScope
                                agent={props.agent}
                                repository={props.repository}
                                tab={props.tab}
                            />
                            <p
                                className="mt-0.5 truncate font-mono text-xs text-slate-500"
                                title={props.repository.root}
                            >
                                {props.repository.root}
                            </p>
                        </div>
                    </div>
                    <ReferenceBadge reference={props.reference} />
                </div>
                <GitViewNav
                    agent={props.agent}
                    path={props.path}
                    tab={props.tab}
                />
            </section>
            {props.tab === "commits" ? (
                <GitCommitList
                    agent={props.agent}
                    path={props.path}
                    commitId={commitId}
                    headCommitId={headCommitId}
                    branchName={
                        props.reference.type === "worktree"
                            ? props.reference.branchName
                            : null
                    }
                />
            ) : props.tab === "worktrees" ? (
                <GitWorktreeList
                    agent={props.agent}
                    repositoryRoot={props.repository.root}
                />
            ) : props.tab === "branches" || props.tab === "tags" ? (
                <GitRefList
                    key={props.tab}
                    agent={props.agent}
                    path={props.path}
                    repositoryRoot={props.repository.root}
                    kind={props.tab}
                />
            ) : (
                props.changes
            )}
        </BrowserViewCard>
    );
}

/**
 * Names the repository and the browsed path inside it as a breadcrumb that starts at the
 * repository root, so a subdirectory's Git view always shows which repository it belongs
 * to and is one click from the whole repository. Links keep the open tab.
 */
function RepositoryScope(props: {
    agent: Agent;
    repository: GitViewRepository;
    tab: GitTab | undefined;
}) {
    const root = props.repository.root;
    const name = getBaseName(root) || root;

    const segments =
        props.repository.relativePath === ""
            ? []
            : props.repository.relativePath.split("/");

    const base = root.endsWith("/") ? root : `${root}/`;
    const search = { view: "git" as const, gitTab: props.tab };

    return (
        <nav aria-label="Repository path">
            <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-base leading-tight">
                <li className="min-w-0">
                    {segments.length === 0 ? (
                        <span
                            aria-current="page"
                            className="break-all font-semibold text-slate-50"
                        >
                            {name}
                        </span>
                    ) : (
                        <Link
                            {...browserRoute(props.agent, root)}
                            search={search}
                            title="Open the whole repository"
                            className="break-all font-semibold text-blue-300 hover:underline"
                        >
                            {name}
                        </Link>
                    )}
                </li>
                {segments.map((segment, index) => {
                    const isLast = index === segments.length - 1;
                    const target = `${base}${segments.slice(0, index + 1).join("/")}`;

                    return (
                        <li
                            key={target}
                            className="flex min-w-0 items-center gap-x-1"
                        >
                            <span aria-hidden="true" className="text-slate-600">
                                /
                            </span>
                            {isLast ? (
                                <span
                                    aria-current="page"
                                    className="break-all font-semibold text-slate-50"
                                >
                                    {segment}
                                </span>
                            ) : (
                                <Link
                                    {...browserRoute(props.agent, target)}
                                    search={search}
                                    className="break-all text-slate-300 hover:text-blue-300 hover:underline"
                                >
                                    {segment}
                                </Link>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

/**
 * Shows what the view is looking at: the checked-out branch in green, or in amber a
 * detached HEAD or a browsed revision, which are not where new commits would go.
 */
function ReferenceBadge(props: { reference: GitViewReference }) {
    const reference = props.reference;

    const pill =
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium @max-xl:max-w-1/2 @max-xl:shrink-0 @max-xl:px-2.5";

    if (reference.type === "revision") {
        const showsId = !reference.commit.id.startsWith(reference.rev);

        const label = (
            <span title={`Browsing ${reference.rev}`} className="truncate">
                {displayRevision(reference.rev)}
            </span>
        );

        return (
            <span
                className={`${pill} border-amber-400/40 bg-amber-400/10 text-amber-300`}
            >
                <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="sr-only">Browsing revision</span>
                {/* A name is copied as people type it; a hash is copied whole, though shown short. */}
                {showsId ? (
                    <>
                        <CopyableGitRef
                            kind={revisionRefKind(reference.rev)}
                            value={displayRevision(reference.rev)}
                        >
                            {label}
                        </CopyableGitRef>
                        <CopyableGitRef
                            kind="commit"
                            value={reference.commit.id}
                            className="shrink-0"
                        >
                            <span className="font-mono text-xs opacity-75">
                                {shortCommitId(reference.commit.id)}
                            </span>
                        </CopyableGitRef>
                    </>
                ) : (
                    <CopyableGitRef kind="commit" value={reference.commit.id}>
                        {label}
                    </CopyableGitRef>
                )}
            </span>
        );
    }

    if (reference.branchName === null) {
        return (
            <span
                className={`${pill} border-amber-400/40 bg-amber-400/10 text-amber-300`}
            >
                <GitCommitHorizontal
                    className="h-4 w-4 shrink-0"
                    aria-hidden="true"
                />
                Detached
                {reference.headCommitId === null ? null : (
                    <CopyableGitRef
                        kind="commit"
                        value={reference.headCommitId}
                        className="shrink-0"
                    >
                        <span className="font-mono text-xs opacity-75">
                            {shortCommitId(reference.headCommitId)}
                        </span>
                    </CopyableGitRef>
                )}
            </span>
        );
    }

    return (
        <span
            className={`${pill} border-emerald-400/40 bg-emerald-400/10 text-emerald-300`}
        >
            <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="sr-only">Checked out branch</span>
            <CopyableGitRef kind="branch" value={reference.branchName}>
                <span className="truncate">{reference.branchName}</span>
            </CopyableGitRef>
            {reference.headCommitId === null ? (
                <span className="font-mono text-xs opacity-75">no commits</span>
            ) : (
                <CopyableGitRef
                    kind="commit"
                    value={reference.headCommitId}
                    className="shrink-0"
                >
                    <span className="font-mono text-xs opacity-75">
                        {shortCommitId(reference.headCommitId)}
                    </span>
                </CopyableGitRef>
            )}
        </span>
    );
}

/**
 * Switches between the Git view's panels. It is a segmented switch inside the repository
 * header rather than a second row of underlined tabs, so it reads as part of the Git view
 * and not as another level of page navigation. A narrow column keeps every panel reachable
 * by naming only the open one, so the switch never spills past its own border.
 */
function GitViewNav(props: {
    agent: Agent;
    path: string;
    tab: GitTab | undefined;
}) {
    const items: Array<{
        tab: GitTab | undefined;
        label: string;
        icon: React.ReactNode;
    }> = [
        {
            tab: undefined,
            label: "Changes",
            icon: <FileDiff className="h-4 w-4 shrink-0" aria-hidden="true" />,
        },
        {
            tab: "commits",
            label: "Commits",
            icon: <History className="h-4 w-4 shrink-0" aria-hidden="true" />,
        },
        {
            tab: "branches",
            label: "Branches",
            icon: <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />,
        },
        {
            tab: "tags",
            label: "Tags",
            icon: <Tag className="h-4 w-4 shrink-0" aria-hidden="true" />,
        },
        {
            tab: "worktrees",
            label: "Worktrees",
            icon: (
                <FolderTree className="h-4 w-4 shrink-0" aria-hidden="true" />
            ),
        },
    ];

    return (
        <nav
            aria-label="Git view"
            className="overflow-x-auto overscroll-x-contain px-4 py-3 @xl:px-5 @xl:pb-4"
        >
            <div className="flex w-full min-w-max gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1 @xl:inline-flex @xl:w-auto @xl:min-w-0">
                {items.map((item) => {
                    const active = item.tab === props.tab;

                    return (
                        <Link
                            key={item.label}
                            {...browserRoute(props.agent, props.path)}
                            // The branch and tag lists share their order, so it survives switching
                            // between them, and the branch scope survives a visit to another tab.
                            search={(previous) => ({
                                view: "git",
                                gitTab: item.tab,
                                refSort: previous.refSort,
                                branchScope: previous.branchScope,
                            })}
                            aria-current={active ? "page" : undefined}
                            className={
                                active
                                    ? "inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-surface-active px-2.5 py-1.5 text-sm font-medium @xl:flex-none @xl:px-3 text-slate-50 shadow-sm ring-1 ring-slate-700 [&_svg]:text-blue-400"
                                    : "inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium @xl:flex-none @xl:px-3 text-slate-400 transition-colors hover:bg-tint hover:text-slate-100"
                            }
                        >
                            {item.icon}
                            {/* A phone cannot fit every label, so only the active tab keeps
                                its label and the rest show their icon, like the browser's
                                own view switch. The label still names each link to
                                assistive technology. */}
                            <span className={cn(!active && "@max-xl:sr-only")}>
                                {item.label}
                            </span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
