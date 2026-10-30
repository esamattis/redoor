import type { GitDirectoryEntriesResponse } from "#bindings/GitDirectoryEntriesResponse";
import type { GitDirectoryEntryState } from "#bindings/GitDirectoryEntryState";
import type { GitDirectoryChanges } from "#bindings/GitDirectoryChanges";
import { Tooltip } from "#ui/components/tooltip";
import { cn } from "#ui/utils/cn";
import { getBaseName, getParentPath } from "#ui/utils/path";

/**
 * The size of the row's type icon. Every symbol sits in a slot of this size, and the header
 * is wider than it, so a symbol arriving after the list rendered never changes a row's height
 * or the column's width.
 */
const SLOT_CLASS_NAME =
    "inline-flex h-4 w-4 shrink-0 items-center justify-center @xl:h-5 @xl:w-5";

/** How a cell's symbol looks and what it says to people who cannot see it. */
type GitSymbol = {
    glyph: string;
    label: string;
    className: string;
};

/**
 * What the column shows for one directory: nothing yet (loading or failed, both leave the
 * rows empty), a walk the agent stopped, or the state of each entry.
 */
export type GitColumnData =
    | { kind: "pending" }
    | { kind: "failed" }
    | { kind: "timed_out" }
    | { kind: "all_ignored" }
    | { kind: "entries"; entries: Map<string, GitDirectoryEntryState> };

/** Turns the agent's answer into what the column needs per row. */
export function gitColumnData(
    response: GitDirectoryEntriesResponse | undefined,
    failed: boolean,
): GitColumnData {
    if (response === undefined) {
        return failed ? { kind: "failed" } : { kind: "pending" };
    }

    switch (response.status) {
        case "entries":
            return {
                kind: "entries",
                entries: new Map(
                    response.entries.map((entry) => [entry.name, entry.state]),
                ),
            };
        case "ignored":
            return { kind: "all_ignored" };
        case "timed_out":
            return { kind: "timed_out" };
        case "outside_worktree":
            // The column is only shown inside a worktree; a stale context leaves it empty.
            return { kind: "pending" };
    }
}

/** The state of the entry `name`, or null when it is clean or not known yet. */
export function gitEntryState(
    data: GitColumnData,
    name: string,
): GitDirectoryEntryState | null {
    if (data.kind === "all_ignored") {
        return { type: "ignored" };
    }

    if (data.kind !== "entries") {
        return null;
    }

    return data.entries.get(name) ?? null;
}

/**
 * Why the column is empty when the walk did not answer, for the header's tooltip; null when
 * there is nothing to explain.
 */
export function gitColumnNote(data: GitColumnData): string | null {
    switch (data.kind) {
        case "timed_out":
            return "Git status took too long and was stopped";
        case "failed":
            return "Git status could not be read";
        default:
            return null;
    }
}

/**
 * Ranks entries for the Git sort so the ones that need attention come first: conflicts,
 * then the entry's own changes, then directories holding changes, then new files, then clean
 * entries, with ignored ones last because they are the least interesting.
 */
export function gitSortRank(state: GitDirectoryEntryState | null): number {
    if (state === null) {
        return 4;
    }

    switch (state.type) {
        case "changed":
            return state.conflicted ? 0 : 1;
        case "contains_changes":
            return 2;
        case "untracked":
            return 3;
        case "ignored":
            return 5;
    }
}

/**
 * Ranks rows by their Git state for `compareFileEntries`, or null until a state is known for
 * every row, so the Git sort keeps the name order while loading, after a failure or timeout.
 */
export function gitRankByName(
    data: GitColumnData,
): ((name: string) => number) | null {
    if (data.kind !== "entries" && data.kind !== "all_ignored") {
        return null;
    }

    return (name) => gitSortRank(gitEntryState(data, name));
}

/** One row's cell; empty for clean tracked entries and while the state is unknown. */
export function GitStatusCell(props: {
    name: string;
    state: GitDirectoryEntryState | null;
    directoryPath: string;
}) {
    const symbol =
        props.state === null
            ? null
            : gitSymbol(props.state, props.directoryPath);

    return (
        <td
            className="w-px whitespace-nowrap px-1 py-0.5 @xl:px-1.5 @xl:py-2"
            aria-label={`Git status of ${props.name}`}
        >
            <span className={SLOT_CLASS_NAME}>
                {symbol === null ? null : (
                    <Tooltip
                        // Keyed by what it says, so a refetch with the same answer keeps the
                        // element and only a new or changed symbol fades in.
                        key={symbol.label}
                        content={symbol.label}
                    >
                        <span
                            role="img"
                            aria-label={symbol.label}
                            className={cn(
                                SLOT_CLASS_NAME,
                                "animate-fade-in select-none text-sm font-bold leading-none motion-reduce:animate-none",
                                symbol.className,
                            )}
                        >
                            {symbol.glyph}
                        </span>
                    </Tooltip>
                )}
            </span>
        </td>
    );
}

/** Picks the symbol for one entry. Color reinforces the glyph and label, never replaces them. */
function gitSymbol(
    state: GitDirectoryEntryState,
    directoryPath: string,
): GitSymbol {
    switch (state.type) {
        case "ignored":
            return {
                glyph: "◌",
                label: "Ignored by .gitignore",
                className: "font-normal text-slate-600",
            };
        case "untracked":
            return {
                glyph: "?",
                label: "Untracked",
                className: "text-slate-400",
            };
        case "contains_changes":
            return containsChangesSymbol(state);
        case "changed":
            return changedSymbol(state, directoryPath);
    }
}

/** The symbol of a file, symlink or submodule that itself differs from HEAD. */
function changedSymbol(
    state: Extract<GitDirectoryEntryState, { type: "changed" }>,
    directoryPath: string,
): GitSymbol {
    if (state.conflicted) {
        return {
            glyph: "!",
            label: "Merge conflict",
            className: "text-red-400",
        };
    }

    if (
        (state.index_state === "renamed" || state.index_state === "copied") &&
        state.original_path !== null
    ) {
        const verb = state.index_state === "renamed" ? "Renamed" : "Copied";

        return {
            glyph: "→",
            label: `${verb} from ${displayOriginalPath(state.original_path, directoryPath)}`,
            className: "text-sky-400",
        };
    }

    const worktreeChanged = state.worktree_state !== "unmodified";

    if (state.index_state === "added") {
        return {
            glyph: "+",
            label: worktreeChanged ? "Added, partly staged" : "Added, staged",
            className: "text-emerald-400",
        };
    }

    const modified = { glyph: "●", className: "text-amber-400" };

    if (state.index_state === "deleted") {
        return { ...modified, label: "Removed from the index, staged" };
    }

    if (
        state.index_state === "type_changed" ||
        state.worktree_state === "type_changed"
    ) {
        return { ...modified, label: "Type changed" };
    }

    if (state.index_state === "unmodified") {
        return { ...modified, label: "Modified" };
    }

    return {
        ...modified,
        label: worktreeChanged ? "Modified, partly staged" : "Modified, staged",
    };
}

/** A rename within the directory names only the old file; others name the whole path. */
function displayOriginalPath(original: string, directoryPath: string): string {
    return getParentPath(original) === directoryPath
        ? getBaseName(original)
        : original;
}

/**
 * The small mark of a directory holding changes, colored by the most severe one, with the
 * counts in its label so the tooltip says what to expect inside.
 */
function containsChangesSymbol(changes: GitDirectoryChanges): GitSymbol {
    const more = changes.truncated ? "+" : "";

    const parts = [
        changes.conflicted > 0
            ? `${changes.conflicted}${more} conflicted`
            : null,
        changes.changed > 0 ? `${changes.changed}${more} changed` : null,
        changes.untracked > 0 ? `${changes.untracked}${more} untracked` : null,
    ].filter((part) => part !== null);

    const className =
        changes.most_severe === "conflicted"
            ? "text-red-400"
            : changes.most_severe === "changed"
              ? "text-amber-400"
              : "text-slate-400";

    return {
        glyph: "•",
        label:
            parts.length === 0
                ? "Contains changes"
                : `Contains ${parts.join(", ")}`,
        className,
    };
}
