import type { GitChangeState } from "#bindings/GitChangeState";
import type { GitRefKind } from "#ui/components/copyable-git-ref";
import { formatModifiedAge } from "#ui/components/browser/utils";
import { cn } from "#ui/utils/cn";

/** Shortens a commit id the way Git tools display it. */
export function shortCommitId(id: string): string {
    return id.slice(0, 12);
}

/**
 * Splits a revision range `A..B` or `A...B` into its sides and separator, or returns null for
 * a single revision. Ref names cannot contain `..`, so the first one always separates the
 * sides, and a third dot right after it makes the range symmetric (compared with the merge
 * base). An empty side stays empty, which the agent reads as `HEAD` like Git does.
 */
export function revisionRange(
    rev: string,
): { base: string; head: string; separator: ".." | "..." } | null {
    const index = rev.indexOf("..");

    if (index === -1) {
        return null;
    }

    const separator = rev.startsWith("...", index) ? "..." : "..";

    return {
        base: rev.slice(0, index),
        head: rev.slice(index + separator.length),
        separator,
    };
}

/**
 * The revision a commit diff is fetched and cached by. A single revision is pinned to the
 * commit the tree resolved, so a moved branch is a new diff. A range is pinned at its newer
 * end the same way and keeps its start as typed; ranges picked from the history list name
 * both ends by commit id, so their diff never changes.
 */
export function commitDiffRevision(rev: string, commitId: string): string {
    const range = revisionRange(rev);

    return range === null
        ? commitId
        : `${range.base}${range.separator}${commitId}`;
}

/**
 * The range that shows a run of consecutive commits as one change: from the parent of the
 * oldest to the newest. The agent reads the parent of a root commit as the empty tree, so a
 * run reaching the first commit still has a start.
 */
export function commitRunRevision(oldestId: string, newestId: string): string {
    return `${oldestId}^..${newestId}`;
}

/**
 * Full commit ids are unreadable in a banner, so they are shortened, also when followed by
 * a parent suffix such as `^`. Branch and tag lists link by full ref name to stay
 * unambiguous, so the ref namespace is dropped the way `git branch -a` shows names; anything
 * else stays as typed. A range shows both of its sides that way.
 */
export function displayRevision(rev: string): string {
    const range = revisionRange(rev);

    if (range !== null) {
        return `${displayRevision(range.base)}${range.separator}${displayRevision(range.head)}`;
    }

    const commit = /^([0-9a-f]{40,64})([~^].*)?$/i.exec(rev);

    if (commit !== null) {
        return `${shortCommitId(commit[1] ?? "")}${commit[2] ?? ""}`;
    }

    const namespace = ["refs/heads/", "refs/remotes/", "refs/tags/"].find(
        (prefix) => rev.startsWith(prefix),
    );

    return namespace === undefined ? rev : rev.slice(namespace.length);
}

/**
 * Tells what a browsed revision name refers to, so copying it is worded as the branch or tag
 * people would type. Anything else, such as `HEAD~2`, is only known to be some ref.
 */
export function revisionRefKind(rev: string): GitRefKind {
    if (rev.startsWith("refs/heads/") || rev.startsWith("refs/remotes/")) {
        return "branch";
    }

    if (rev.startsWith("refs/tags/")) {
        return "tag";
    }

    return "ref";
}

/** Every state a changed file can be listed in, worktree status and commits alike. */
export type GitChangeKind = GitChangeState | "conflicted" | "untracked";

/**
 * The letter `git status --short` uses for each state, so the badges read like the tool
 * people already know, with a color per kind of change.
 */
const changeStyles = {
    unmodified: {
        letter: "·",
        label: "Unmodified",
        className: "border-slate-700 text-slate-500",
    },
    added: {
        letter: "A",
        label: "Added",
        className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
    },
    modified: {
        letter: "M",
        label: "Modified",
        className: "border-amber-400/40 bg-amber-400/10 text-amber-300",
    },
    deleted: {
        letter: "D",
        label: "Deleted",
        className: "border-red-400/40 bg-red-400/10 text-red-300",
    },
    renamed: {
        letter: "R",
        label: "Renamed",
        className: "border-blue-400/40 bg-blue-400/10 text-blue-300",
    },
    copied: {
        letter: "C",
        label: "Copied",
        className: "border-blue-400/40 bg-blue-400/10 text-blue-300",
    },
    type_changed: {
        letter: "T",
        label: "Type changed",
        className: "border-blue-400/40 bg-blue-400/10 text-blue-300",
    },
    conflicted: {
        letter: "U",
        label: "Conflicted",
        className: "border-red-400/60 bg-red-400/20 text-red-200",
    },
    untracked: {
        letter: "?",
        label: "Untracked",
        className: "border-slate-600 bg-slate-800/60 text-slate-300",
    },
} satisfies Record<
    GitChangeKind,
    { letter: string; label: string; className: string }
>;

/** Names a change state in words, for counts and accessible text. */
export function changeLabel(kind: GitChangeKind): string {
    return changeStyles[kind].label;
}

/**
 * A compact status letter for one changed file. The letter is decorative; assistive
 * technology hears the state's name instead.
 */
export function ChangeBadge(props: { kind: GitChangeKind }) {
    const style = changeStyles[props.kind];

    return (
        <span
            title={style.label}
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[11px] font-bold ${style.className}`}
        >
            <span aria-hidden="true">{style.letter}</span>
            <span className="sr-only">{style.label}</span>
        </span>
    );
}

/** Shows when a commit was authored, relative for scanning and exact on hover. */
export function CommitAge(props: { authoredAt: number; now: number }) {
    const date = new Date(props.authoredAt * 1000);

    return (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
            {formatModifiedAge(props.authoredAt, props.now)}
        </time>
    );
}

/**
 * A round initial standing in for an author's avatar. Git records no picture, and the hue
 * follows the name so one author's commits are recognisable down a long list.
 */
export function AuthorAvatar(props: {
    name: string;
    /** `xs` fits inside a line of text, such as a commit's byline. */
    size?: "xs" | "sm" | "md";
}) {
    const initial = props.name.trim().charAt(0).toUpperCase() || "?";

    const hues = [
        "bg-blue-400/20 text-blue-300",
        "bg-emerald-400/20 text-emerald-300",
        "bg-amber-400/20 text-amber-300",
        "bg-red-400/20 text-red-300",
    ];

    let hash = 0;

    for (let index = 0; index < props.name.length; index += 1) {
        hash += props.name.charCodeAt(index);
    }

    const size = {
        xs: "h-5 w-5 text-xs",
        sm: "h-7 w-7 text-xs",
        md: "h-9 w-9 text-sm",
    }[props.size ?? "sm"];

    return (
        <span
            aria-hidden="true"
            className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${size} ${hues[hash % hues.length] ?? ""}`}
        >
            {initial}
        </span>
    );
}

/**
 * The short strip that opens every Git panel: a count or title on the left and the panel's
 * own controls on the right. It replaces a second card header under the repository header.
 */
export function GitPanelBar(props: {
    children: React.ReactNode;
    actions?: React.ReactNode;
}) {
    return (
        <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 px-4 py-2 @xl:px-5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-300">
                {props.children}
            </div>
            {props.actions === undefined ? null : (
                // Actions wrap so several controls still fit a phone-width bar.
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    {props.actions}
                </div>
            )}
        </div>
    );
}

/** A short status line for the loading, error and empty states every Git list shares. */
export function ListMessage(props: {
    role: "status" | "alert";
    children: string;
}) {
    return (
        <p
            role={props.role}
            className={cn(
                "px-4 py-10 text-center text-sm @xl:px-5",
                props.role === "alert" ? "text-red-300" : "text-slate-400",
            )}
        >
            {props.children}
        </p>
    );
}

/**
 * Marks an item that comes from Git history rather than the working tree, wherever the
 * selection is listed, so copying it is never mistaken for copying the current file.
 */
export function RevisionBadge(props: { commitId: string }) {
    return (
        <span
            aria-label={`At commit ${shortCommitId(props.commitId)}`}
            title={props.commitId}
            className="ml-1.5 inline-flex shrink-0 items-center rounded border border-amber-600/60 bg-amber-900/30 px-1 font-mono text-xs font-normal text-amber-200"
        >
            @{shortCommitId(props.commitId)}
        </span>
    );
}
