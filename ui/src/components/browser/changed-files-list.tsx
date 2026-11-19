import {
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
} from "lucide-react";

import type { ChangedFilesOutlineSnapshot } from "#ui/components/browser/changed-files-outline";
import {
    buildChangedFilesTree,
    type ChangedFilesTreeRow,
} from "#ui/components/browser/changed-files-tree";
import { ChangeBadge } from "#ui/components/browser/git-parts";
import { Button } from "#ui/components/button";
import { ClearableInput } from "#ui/components/clearable-input";
import { IconButton } from "#ui/components/icon-button";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import { useCloseSideMenu } from "#ui/side-menu-state";
import { cn } from "#ui/utils/cn";

/**
 * The changed files filter of each history entry, so going back to a diff shows the same
 * narrowed list the reader left.
 */
const changedFilesFilters = new HistoryEntryStore<string>();

/**
 * The folded directories of the changed files tree for each history entry, so going back to a
 * diff keeps the directories the reader put away out of the way.
 */
const changedFilesFolds = new HistoryEntryStore<ReadonlySet<string>>();

/** A directory row of the changed files tree. */
type DirectoryRow = Extract<ChangedFilesTreeRow, { kind: "directory" }>;

/**
 * Lists the files of the diff on screen, so a long change set can be navigated by name
 * instead of scrolling past every patch. Picking one expands its diff and scrolls to it.
 */
export function ChangedFiles(props: {
    outline: ChangedFilesOutlineSnapshot;
    isCompact: boolean;
}) {
    const closeMenu = useCloseSideMenu();
    const files = props.outline.files;

    const [filter, setFilter] = useHistoryEntryState({
        store: changedFilesFilters,
        scope: "changed-files",
        initial: (previous) => previous ?? "",
    });

    const needle = filter.trim().toLowerCase();

    const [foldedPaths, setFoldedPaths] = useHistoryEntryState({
        store: changedFilesFolds,
        scope: "changed-files",
        initial: (previous) => previous ?? new Set<string>(),
    });

    /** Unfolding clears the whole chain, since any folded directory in it folds the row. */
    const toggleFolded = (row: DirectoryRow) => {
        setFoldedPaths((current) => {
            const next = new Set(current);

            if (row.isFolded) {
                for (const chainPath of row.chainPaths) {
                    next.delete(chainPath);
                }
            } else {
                next.add(row.path);
            }

            return next;
        });
    };

    const shownFiles =
        needle === ""
            ? files
            : files.filter((file) =>
                  file.relativePath.toLowerCase().includes(needle),
              );

    const rows = buildChangedFilesTree(shownFiles, foldedPaths);

    // Taken from every file rather than the filtered ones, so a directory folded by "Fold
    // all" stays folded when a changed filter brings it back into the list.
    const directoryRows = buildChangedFilesTree(files, new Set()).flatMap(
        (row) => (row.kind === "directory" ? [row] : []),
    );

    /**
     * The directories below a row, taken from the unfiltered tree like "Fold all", so the
     * folds still cover the directories a filter currently hides.
     */
    const descendantRowsOf = (row: DirectoryRow) =>
        directoryRows.filter((other) => other.path.startsWith(`${row.path}/`));

    /** Tells whether a folded path belongs to the row or to a directory below it. */
    const isInsideRow = (row: DirectoryRow, path: string) =>
        row.chainPaths.includes(path) || path.startsWith(`${row.path}/`);

    /**
     * Folds every directory below the row but opens the row itself, so a big directory can be
     * reduced to an overview of what it holds without folding its neighbours.
     */
    const foldInside = (row: DirectoryRow) => {
        setFoldedPaths((current) => {
            const next = new Set(current);

            for (const chainPath of row.chainPaths) {
                next.delete(chainPath);
            }

            for (const descendant of descendantRowsOf(row)) {
                next.add(descendant.path);
            }

            return next;
        });
    };

    /** Opens the row and everything below it, leaving folds elsewhere in the tree alone. */
    const unfoldInside = (row: DirectoryRow) => {
        setFoldedPaths(
            (current) =>
                new Set([...current].filter((path) => !isInsideRow(row, path))),
        );
    };

    /**
     * The fold-inside actions of a row, left out for directories without subdirectories,
     * where they would only repeat what clicking the row does.
     */
    const directoryRowFolding = (row: DirectoryRow) => {
        if (descendantRowsOf(row).length === 0) {
            return {};
        }

        return { onFoldInside: foldInside, onUnfoldInside: unfoldInside };
    };

    return (
        <section
            aria-label="Changed files"
            className="flex min-h-24 flex-1 flex-col"
        >
            <div className="flex min-h-7 items-center gap-1.5 py-1 pl-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Changed files
                <span
                    className="rounded-full bg-tint-strong px-1.5 text-[10px] leading-4 tracking-normal text-slate-300"
                    aria-label={`${files.length} changed`}
                >
                    {files.length}
                </span>
                {directoryRows.length === 0 ? null : (
                    <span className="ml-auto flex items-center gap-0.5 normal-case">
                        <IconButton
                            type="button"
                            label="Fold all directories"
                            variant="quiet"
                            size={props.isCompact ? "sm" : "xs"}
                            // A row already counts as folded through any directory of its
                            // chain, and the existing folds are kept, since a filter may have
                            // merged a folded directory into a longer row.
                            disabled={directoryRows.every((row) =>
                                row.chainPaths.some((path) =>
                                    foldedPaths.has(path),
                                ),
                            )}
                            onClick={() =>
                                setFoldedPaths(
                                    (current) =>
                                        new Set([
                                            ...current,
                                            ...directoryRows.map(
                                                (row) => row.path,
                                            ),
                                        ]),
                                )
                            }
                        >
                            <ChevronsDownUp
                                className="size-3.5"
                                aria-hidden="true"
                            />
                        </IconButton>
                        <IconButton
                            type="button"
                            label="Unfold all directories"
                            variant="quiet"
                            size={props.isCompact ? "sm" : "xs"}
                            disabled={foldedPaths.size === 0}
                            onClick={() => setFoldedPaths(() => new Set())}
                        >
                            <ChevronsUpDown
                                className="size-3.5"
                                aria-hidden="true"
                            />
                        </IconButton>
                    </span>
                )}
            </div>
            {files.length === 0 ? null : (
                <ClearableInput
                    label="Filter changed files"
                    clearLabel="Clear changed files filter"
                    value={filter}
                    placeholder="Filter"
                    onChange={(value) => setFilter(() => value)}
                    className="mt-1 shrink-0"
                />
            )}
            {shownFiles.length === 0 ? (
                <p className="mt-1 px-1 text-xs text-slate-500">
                    {files.length === 0
                        ? "No files to show"
                        : "No files match the filter"}
                </p>
            ) : (
                // Positioned so the badges' absolutely placed screen reader labels are
                // clipped by the list instead of hanging below the window, which would make
                // the whole shell scrollable.
                <ul
                    aria-label="Changed files"
                    className="relative mt-1 flex min-h-0 flex-col overflow-y-auto"
                >
                    {rows.map((row) =>
                        row.kind === "directory" ? (
                            <ChangedDirectoryRow
                                key={`directory:${row.path}`}
                                row={row}
                                isCompact={props.isCompact}
                                onToggle={toggleFolded}
                                {...directoryRowFolding(row)}
                            />
                        ) : (
                            <ChangedFileRow
                                key={row.file.path}
                                row={row}
                                isCompact={props.isCompact}
                                onReveal={(path) => {
                                    // The drawer covers the diff on phones, so it gets out of the way.
                                    closeMenu();
                                    props.outline.reveal(path);
                                }}
                            />
                        ),
                    )}
                </ul>
            )}
        </section>
    );
}

/**
 * How far each tree level is indented. It is kept tiny because the side menu is narrow and
 * deep trees would otherwise squeeze the file names out.
 */
const TREE_INDENT_PX = 6;

/**
 * A directory of the changed files tree, drawn as a slim bar in a smaller font so it reads as
 * a heading of the files below rather than as one more file. Clicking it folds them away, and
 * its own buttons fold or unfold everything below it at once.
 */
function ChangedDirectoryRow(props: {
    row: DirectoryRow;
    /** Phones get taller rows, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
    onToggle: (row: DirectoryRow) => void;
    /** Left out when the directory has no subdirectories to fold. */
    onFoldInside?: (row: DirectoryRow) => void;
    onUnfoldInside?: (row: DirectoryRow) => void;
}) {
    const Chevron = props.row.isFolded ? ChevronRight : ChevronDown;
    const onFoldInside = props.onFoldInside;
    const onUnfoldInside = props.onUnfoldInside;

    return (
        <li
            className="mt-0.5"
            style={{ paddingLeft: props.row.depth * TREE_INDENT_PX }}
        >
            <div className="group flex min-w-0 items-center rounded-sm bg-tint">
                <Button
                    type="button"
                    variant="ghost"
                    aria-expanded={!props.row.isFolded}
                    tooltip={`${props.row.isFolded ? "Unfold" : "Fold"} ${props.row.path}`}
                    tooltipClassName="min-w-0 flex-1"
                    onClick={() => props.onToggle(props.row)}
                    className={cn(
                        "w-full min-w-0 justify-start gap-1 rounded-sm px-1 text-left text-[11px] leading-4 font-normal text-slate-400",
                        props.isCompact ? "py-2" : "py-1",
                    )}
                >
                    <Chevron aria-hidden className="size-3 shrink-0" />
                    <span className="truncate">{props.row.label}</span>
                </Button>
                {onFoldInside === undefined ||
                onUnfoldInside === undefined ? null : (
                    // Revealed on hover where there is a pointer, so the bars stay calm, but
                    // always shown on touch screens, which cannot hover.
                    <span className="flex shrink-0 items-center pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100">
                        <IconButton
                            type="button"
                            label={`Fold directories inside ${props.row.path}`}
                            variant="quiet"
                            size={props.isCompact ? "sm" : "xs"}
                            className={props.isCompact ? undefined : "p-0.5"}
                            onClick={() => onFoldInside(props.row)}
                        >
                            <ChevronsDownUp
                                className="size-3"
                                aria-hidden="true"
                            />
                        </IconButton>
                        <IconButton
                            type="button"
                            label={`Unfold everything inside ${props.row.path}`}
                            variant="quiet"
                            size={props.isCompact ? "sm" : "xs"}
                            className={props.isCompact ? undefined : "p-0.5"}
                            onClick={() => onUnfoldInside(props.row)}
                        >
                            <ChevronsUpDown
                                className="size-3"
                                aria-hidden="true"
                            />
                        </IconButton>
                    </span>
                )}
            </div>
        </li>
    );
}

/** One changed file of the tree, named without its directory, which the bars above give. */
function ChangedFileRow(props: {
    row: Extract<ChangedFilesTreeRow, { kind: "file" }>;
    /** Phones get taller rows, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
    onReveal: (path: string) => void;
}) {
    const file = props.row.file;

    return (
        <li style={{ paddingLeft: props.row.depth * TREE_INDENT_PX }}>
            <Button
                type="button"
                variant="ghost"
                aria-label={file.relativePath}
                tooltip={`Show the diff of ${file.relativePath}`}
                tooltipClassName="w-full min-w-0"
                onClick={() => props.onReveal(file.path)}
                className={cn(
                    "w-full min-w-0 justify-start gap-2 px-1.5 text-left font-normal text-slate-300",
                    props.isCompact ? "py-2" : "py-1",
                )}
            >
                {file.change === null ? null : (
                    <ChangeBadge kind={file.change} />
                )}
                <span className="truncate text-sm text-slate-200">
                    {props.row.label}
                </span>
            </Button>
        </li>
    );
}
