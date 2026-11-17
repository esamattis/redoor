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
    const toggleFolded = (
        row: Extract<ChangedFilesTreeRow, { kind: "directory" }>,
    ) => {
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
 * a heading of the files below rather than as one more file. Clicking it folds them away.
 */
function ChangedDirectoryRow(props: {
    row: Extract<ChangedFilesTreeRow, { kind: "directory" }>;
    /** Phones get taller rows, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
    onToggle: (
        row: Extract<ChangedFilesTreeRow, { kind: "directory" }>,
    ) => void;
}) {
    const Chevron = props.row.isFolded ? ChevronRight : ChevronDown;

    return (
        <li
            className="mt-0.5"
            style={{ paddingLeft: props.row.depth * TREE_INDENT_PX }}
        >
            <Button
                type="button"
                variant="ghost"
                aria-expanded={!props.row.isFolded}
                tooltip={`${props.row.isFolded ? "Unfold" : "Fold"} ${props.row.path}`}
                tooltipClassName="w-full min-w-0"
                onClick={() => props.onToggle(props.row)}
                className={cn(
                    "w-full min-w-0 justify-start gap-1 rounded-sm bg-tint px-1 text-left text-[11px] leading-4 font-normal text-slate-400",
                    props.isCompact ? "py-1.5" : "py-0",
                )}
            >
                <Chevron aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{props.row.label}</span>
            </Button>
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
