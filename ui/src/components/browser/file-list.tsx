import React from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    ArrowDownUp,
    ChevronDown,
    ChevronUp,
    Download,
    File,
    Folder,
    GitBranch,
    Files,
    Search,
} from "lucide-react";
import type { LsEntry } from "#bindings/LsEntry";
import type { MountPoint } from "#bindings/MountPoint";
import type { GitDirectoryEntryState } from "#bindings/GitDirectoryEntryState";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { PathActionMenu } from "#ui/components/browser/path-actions";
import { DeletePathDialog } from "#ui/components/browser/delete-path-dialog";
import { CreateArchiveDialog } from "#ui/components/browser/create-archive-dialog";
import { InputControl } from "#ui/components/input-control";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { TextField } from "#ui/components/text-field";
import { Tooltip } from "#ui/components/tooltip";
import { cn } from "#ui/utils/cn";
import {
    getSelectedFileKey,
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
} from "#ui/selected-files";
import {
    compareFileEntries,
    type FileSort,
    formatModifiedAge,
    joinBrowserPath,
    sortFileEntries,
} from "#ui/components/browser/utils";
import {
    getPendingTransferSortEntry,
    PendingFileEntry,
    type PendingTransfer,
    usePendingTransfers,
} from "#ui/components/browser/pending-transfers";
import type { FileSortColumn } from "#ui/browser-search";
import { browserRoute } from "#ui/browser-route";
import { formatSize } from "#ui/utils/path";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { isPlainKey } from "#ui/utils/keyboard";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";
import {
    buildUnarchiveCommand,
    getArchiveInfo,
    getDirectoryArchiveName,
    getCustomArchiveDirectoryError,
    type UnarchiveDestination,
} from "#ui/utils/archive";
import { useTerminals } from "#ui/use-terminals";
import type { RevisionListing } from "#ui/components/browser/revision";
import {
    type GitColumnData,
    gitColumnData,
    gitColumnNote,
    gitEntryState,
    gitRankByName,
    GitStatusCell,
} from "#ui/components/browser/git-status-column";
import { gitDirectoryEntriesQueryOptions } from "#ui/queries";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";

/**
 * One displayed row: a listed entry, or an incoming transfer whose `entry` is a stand-in so it
 * filters and sorts by the same rules as the real entries around it.
 */
type FileListRow = {
    name: string;
    entry: LsEntry;
    pending: PendingTransfer | null;
};

/**
 * Orders rows like the listing does when no column is chosen: directories first in listing
 * order, then files, with pending rows placed among the files by name.
 */
function orderRowsWithoutSort(rows: FileListRow[]): FileListRow[] {
    const directoryRows = rows.filter(
        (row) => row.pending === null && row.entry.type === "directory",
    );

    const fileRows = rows.filter(
        (row) => row.pending !== null || row.entry.type !== "directory",
    );

    // Listed files already arrive in this order, so only pending rows actually move.
    return [...directoryRows, ...sortFileEntries(fileRows)];
}

/** Identifies the destination that should restore filter focus after Enter navigation. */
const filterFocusPathAtom = atom<string | null>(null);

const filterQueries = new HistoryEntryStore<string>();

/**
 * The name filter of one directory listing. It is kept per history entry, so coming back
 * from a file shows the same narrowed list, whose height the restored scroll position
 * depends on. Each directory starts unfiltered, because a filter for one directory's names
 * rarely means anything in another.
 */
function useFileListFilter(scope: string) {
    const [filter, update] = useHistoryEntryState<string>({
        store: filterQueries,
        scope,
        initial: () => "",
    });

    return [filter, (next: string) => update(() => next)] as const;
}

/** Handles shortcuts that only exist while the file list is mounted. */
function useFileListShortcuts(props: {
    filterInputRef: React.RefObject<HTMLInputElement | null>;
    filter: string;
    setFilter: (filter: string) => void;
}) {
    // Both keys stay out of text controls, so typing an f or leaving the filter box with
    // Escape never triggers them; Escape clears the filter only once focus is elsewhere.
    useShortcut({
        name: "file-list-focus-filter",
        phase: "bubble",
        priority: shortcutPriority.view,
        skipTypingTargets: true,
        match: (event) => isPlainKey(event, "f"),
        run: () => {
            props.filterInputRef.current?.focus();
        },
    });

    useShortcut({
        name: "file-list-clear-filter",
        phase: "bubble",
        priority: shortcutPriority.view,
        skipTypingTargets: true,
        match: (event) => isPlainKey(event, "Escape"),
        run: () => {
            if (props.filter === "") {
                return false;
            }

            props.setFilter("");
        },
    });
}

/** Filters only the loaded directory entries so recursive search remains in the shared dialog. */
export function FileList(props: {
    agent: Agent;
    directoryPath: string;
    actions: React.ReactNode;
    files: LsEntry[];
    showHiddenFiles: boolean;
    mountPoint: MountPoint | null;
    /** Comes from the URL so the order survives a reload; null keeps the listing order. */
    sort: FileSort | null;
    onSort: (column: FileSortColumn) => void;
    /**
     * Lists a committed Git revision: row write actions are disabled, selection and
     * downloads read the commit, no uploads are pending into it, and modification times are
     * not shown because Git does not record them.
     */
    revision?: RevisionListing;
    /**
     * Shows the Git status column. It depends only on the Git context the loader already
     * has, so the column is there from the first render and its data arriving never shifts
     * the table.
     */
    showGitStatus: boolean;
}) {
    const navigate = useNavigate();
    const readOnly = props.revision !== undefined;
    const agent = props.agent;
    const [filterFocusPath, setFilterFocusPath] = useAtom(filterFocusPathAtom);
    const filterInputRef = React.useRef<HTMLInputElement>(null);

    const [filter, setFilter] = useFileListFilter(
        JSON.stringify([
            props.agent.id,
            props.directoryPath,
            props.revision?.commitId,
        ]),
    );

    const normalizedFilter = filter.toLowerCase();
    // A leading dot is a hidden-name query, so include those entries without flipping the toggle.
    const includeHiddenFiles = props.showHiddenFiles || filter.startsWith(".");

    const visibleFiles = includeHiddenFiles
        ? props.files
        : props.files.filter((entry) => !entry.name.startsWith("."));

    const filteredFiles = visibleFiles.filter((entry) =>
        entry.name.toLowerCase().includes(normalizedFilter),
    );

    // Fetched here rather than in the loader, so the listing never waits for the status walk.
    const gitEntries = useQuery({
        ...gitDirectoryEntriesQueryOptions(props.agent, props.directoryPath),
        enabled: props.showGitStatus,
    });

    const gitColumn: GitColumnData | null = props.showGitStatus
        ? gitColumnData(gitEntries.data, gitEntries.isError)
        : null;

    const worktreePendingTransfers = usePendingTransfers(
        props.agent.id,
        props.directoryPath,
    );

    // Uploads land in the working directory, never in a committed revision.
    const pendingTransfers = readOnly ? [] : worktreePendingTransfers;

    // Pending names follow the same hidden-file and filter rules as listed entries.
    const pendingRows = pendingTransfers.flatMap((pending) =>
        (includeHiddenFiles || !pending.name.startsWith(".")) &&
        pending.name.toLowerCase().includes(normalizedFilter)
            ? [
                  {
                      name: pending.name,
                      entry: getPendingTransferSortEntry(pending),
                      pending,
                  },
              ]
            : [],
    );

    const rows: FileListRow[] = [
        ...filteredFiles.map((entry) => ({
            name: entry.name,
            entry,
            pending: null,
        })),
        ...pendingRows,
    ];

    const sort = props.sort;

    const gitRank = gitColumn === null ? null : gitRankByName(gitColumn);

    const displayedRows = sort
        ? [...rows].sort((left, right) => {
              return compareFileEntries(left.entry, right.entry, {
                  sort,
                  gitRank,
              });
          })
        : pendingRows.length > 0
          ? orderRowsWithoutSort(rows)
          : rows;

    useFileListShortcuts({
        filterInputRef,
        filter,
        setFilter,
    });

    React.useEffect(() => {
        if (filterFocusPath !== props.directoryPath) {
            return;
        }

        filterInputRef.current?.focus();
        setFilterFocusPath(null);
    }, [filterFocusPath, props.directoryPath, setFilterFocusPath]);

    const handleFilterKeyDown = async (
        event: React.KeyboardEvent<HTMLInputElement>,
    ) => {
        if (event.key !== "Enter") {
            return;
        }

        const destinationPath = filteredFiles[0]
            ? joinBrowserPath(props.directoryPath, filteredFiles[0].name)
            : undefined;

        if (!destinationPath) {
            return;
        }

        event.preventDefault();
        setFilterFocusPath(destinationPath);
        await navigate(browserRoute(agent, destinationPath));
    };

    return (
        <div className="overflow-hidden bg-surface">
            {props.actions}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-900/35 p-1.5 @xl:gap-2 @xl:p-2">
                <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Filter files</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <InputControl
                        ref={filterInputRef}
                        type="search"
                        aria-label="Filter files"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        onKeyDown={handleFilterKeyDown}
                        placeholder="Filter files (f)"
                        className="w-full bg-slate-900 py-1.5 pl-9 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500 @xl:py-2"
                    />
                </label>
            </div>
            <FileTable
                agent={props.agent}
                directoryPath={props.directoryPath}
                rows={displayedRows}
                sort={sort}
                onSort={props.onSort}
                revision={props.revision}
                gitColumn={gitColumn}
            />
            <FilesystemFooter mountPoint={props.mountPoint} />
        </div>
    );
}

/** Keeps current filesystem capacity visible below local file results. */
function FilesystemFooter(props: { mountPoint: MountPoint | null }) {
    const mountPoint = props.mountPoint;
    const availableBytes = mountPoint?.available_bytes ?? null;
    const totalBytes = mountPoint?.total_bytes ?? null;

    const usedBytes =
        totalBytes !== null && availableBytes !== null
            ? Math.max(0, totalBytes - availableBytes)
            : null;

    const usage =
        usedBytes === null || availableBytes === null
            ? "Unavailable"
            : `${formatSize(usedBytes)} / ${formatSize(availableBytes)}`;

    return (
        <footer
            aria-label="Filesystem information"
            className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 border-t border-slate-800 bg-slate-900/35 px-3 py-2 font-mono text-xs text-slate-400"
        >
            <span>
                Disk usage: <span className="text-slate-200">{usage}</span>
            </span>
            <span>
                Filesystem:{" "}
                <span className="text-slate-200">
                    {mountPoint?.mount_type ?? "Unavailable"}
                </span>
            </span>
        </footer>
    );
}

/** Owns keyboard focus for the currently visible local file entries. */
function FileTable(props: {
    agent: Agent;
    directoryPath: string;
    rows: FileListRow[];
    sort: FileSort | null;
    onSort: (column: FileSortColumn) => void;
    revision: RevisionListing | undefined;
    /** The Git column's data, or null when the column is not shown. */
    gitColumn: GitColumnData | null;
}) {
    const gitColumn = props.gitColumn;
    const tableRef = React.useRef<HTMLTableElement>(null);

    const getEntries = React.useEffectEvent(() =>
        Array.from(
            tableRef.current?.querySelectorAll<HTMLElement>(
                '[data-keyboard-focus-entry="true"]',
            ) ?? [],
        ),
    );

    useArrayKeyboardFocus(getEntries);

    return (
        <div className="overflow-x-auto">
            <table ref={tableRef} className="w-full min-w-[55rem]">
                <thead>
                    <tr className="border-b border-slate-800 bg-surface-raised">
                        <th className="w-px whitespace-nowrap px-1 py-1.5 text-left text-sm font-medium text-slate-400 @xl:px-1.5 @xl:py-2">
                            <span className="sr-only">Select</span>
                        </th>
                        <SortableFileColumnHeader
                            label="Type"
                            column="type"
                            icon={<Files className="h-4 w-4" />}
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        {gitColumn === null ? null : (
                            <SortableFileColumnHeader
                                label="Git status"
                                column="git"
                                icon={<GitBranch className="h-4 w-4" />}
                                note={gitColumnNote(gitColumn)}
                                sort={props.sort}
                                onSort={props.onSort}
                            />
                        )}
                        <SortableFileColumnHeader
                            label="Name"
                            column="name"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        <SortableFileColumnHeader
                            label="Size"
                            column="size"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        <SortableFileColumnHeader
                            label="Modified"
                            column="modified"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        <SortableFileColumnHeader
                            label="Owner"
                            column="owner"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        <SortableFileColumnHeader
                            label="Group"
                            column="group"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
                        <th className="p-1.5 text-right text-sm font-medium text-slate-400 @xl:p-2">
                            Actions
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {props.rows.map((row) =>
                        row.pending ? (
                            <PendingFileEntry
                                key={`pending:${row.pending.transfer.request_id}`}
                                pending={row.pending}
                                showGitStatus={gitColumn !== null}
                            />
                        ) : (
                            <FileEntry
                                key={row.name}
                                agent={props.agent}
                                directoryPath={props.directoryPath}
                                entry={row.entry}
                                revision={props.revision}
                                gitState={
                                    gitColumn === null
                                        ? undefined
                                        : gitEntryState(gitColumn, row.name)
                                }
                            />
                        ),
                    )}
                </tbody>
            </table>
        </div>
    );
}

/** Provides one accessible control that toggles a file-list sort direction. */
function SortableFileColumnHeader(props: {
    label: string;
    column: FileSortColumn;
    sort: FileSort | null;
    onSort: (column: FileSortColumn) => void;
    /**
     * Shows an icon instead of the label, for columns whose cells are a single icon, so the
     * header does not make the column wider than its content. The label stays in the tooltip
     * and the accessible name.
     */
    icon?: React.ReactNode;
    /** Explains a column that is empty for a reason, in place of the sort tooltip. */
    note?: string | null;
}) {
    const direction =
        props.sort?.column === props.column ? props.sort.direction : null;

    const nextDirection =
        direction === "ascending" ? "descending" : "ascending";

    const SortIcon =
        direction === "ascending"
            ? ChevronUp
            : direction === "descending"
              ? ChevronDown
              : ArrowDownUp;

    const button = (
        <Button
            type="button"
            variant="ghost"
            onClick={() => props.onSort(props.column)}
            aria-label={`Sort by ${props.label} ${nextDirection}`}
            className={cn(
                "flex w-full justify-start text-left text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                props.icon === undefined
                    ? "gap-1.5 px-1.5 py-1.5"
                    : "gap-0.5 px-1 py-1.5",
            )}
        >
            {props.icon ?? props.label}
            <SortIcon className="h-3.5 w-3.5" />
        </Button>
    );

    if (props.icon === undefined) {
        return (
            <th
                aria-sort={direction ?? "none"}
                className="p-0.5 text-left text-sm font-medium text-slate-400"
            >
                {button}
            </th>
        );
    }

    const note = props.note ?? null;

    return (
        <th
            aria-sort={direction ?? "none"}
            className="w-px whitespace-nowrap p-0.5 text-left text-sm font-medium text-slate-400"
        >
            <Tooltip content={note ?? `Sort by ${props.label}`}>
                {button}
            </Tooltip>
            {note === null ? null : <span className="sr-only">{note}</span>}
        </th>
    );
}

/** Owns target validation and fresh-terminal startup for one archive extraction. */
function UnarchiveDialog(props: {
    agent: Agent;
    entryName: string;
    directoryPath: string;
    onClose: () => void;
}) {
    const [destination, setDestination] =
        React.useState<UnarchiveDestination>("current");

    const [customDirectory, setCustomDirectory] = React.useState("");
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const terminals = useTerminals();
    const archive = getArchiveInfo(props.entryName);

    /** Validates before opening so invalid shell input remains visible and actionable. */
    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (destination === "custom") {
            const error = getCustomArchiveDirectoryError(customDirectory);

            if (error) {
                setErrorMessage(error);

                return;
            }
        }

        const command = buildUnarchiveCommand(
            props.entryName,
            destination,
            customDirectory,
        );

        if (!command) {
            setErrorMessage("Unable to create a safe extraction command");

            return;
        }

        props.onClose();
        terminals.create({
            agent: props.agent,
            cwd: props.directoryPath,
            startupCommand: command,
            refreshTarget: {
                agentId: props.agent.id,
                path: props.directoryPath,
            },
        });
    };

    /** Clears stale validation whenever a different target policy is selected. */
    const selectDestination = (nextDestination: UnarchiveDestination) => {
        setDestination(nextDestination);
        setErrorMessage(null);
    };

    return (
        <Dialog
            isOpen={true}
            title="Unarchive"
            description={`Choose where to extract ${props.entryName}. A new terminal will run the extraction command.`}
            closeAriaLabel="Close unarchive dialog"
            errorMessage={errorMessage}
            onClose={props.onClose}
        >
            <form noValidate onSubmit={handleSubmit}>
                <RadioCardGroup
                    legend="Extraction destination"
                    legendClassName="mt-4 text-sm font-medium text-slate-200"
                    optionsClassName="mt-2"
                >
                    <RadioCardOption
                        name="unarchive-destination"
                        value="current"
                        label="Current directory"
                        description={props.directoryPath}
                        checked={destination === "current"}
                        layout="descriptive"
                        onChange={() => selectDestination("current")}
                    />
                    <RadioCardOption
                        name="unarchive-destination"
                        value="subdirectory"
                        label={`Subdirectory ${archive?.directoryName ?? ""}`}
                        description="Create a directory named after the archive and extract into it."
                        checked={destination === "subdirectory"}
                        layout="descriptive"
                        onChange={() => selectDestination("subdirectory")}
                    />
                    <RadioCardOption
                        name="unarchive-destination"
                        value="custom"
                        label="Custom directory"
                        description="Create one directory with a name you choose and extract into it."
                        checked={destination === "custom"}
                        layout="descriptive"
                        onChange={() => selectDestination("custom")}
                    />
                </RadioCardGroup>
                {destination === "custom" ? (
                    <TextField
                        label="Target directory name"
                        value={customDirectory}
                        placeholder="extracted files"
                        description="Enter one directory name beneath the archive's containing directory."
                        required
                        autoFocus
                        className="mt-4"
                        disabled={false}
                        onChange={(value) => {
                            setCustomDirectory(value);
                            setErrorMessage(null);
                        }}
                    />
                ) : null}
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                    >
                        Cancel
                    </Button>
                    <Button type="submit">Unarchive</Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/** Keeps mutations and download confirmation behind one compact row menu. */
function FileEntryActions(props: {
    agent: Agent;
    entryName: string;
    fullPath: string;
    directoryPath: string;
    isDirectory: boolean;
    revision: RevisionListing | undefined;
}) {
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);

    const [isDownloadDialogOpen, setIsDownloadDialogOpen] =
        React.useState(false);

    const [isUnarchiveDialogOpen, setIsUnarchiveDialogOpen] =
        React.useState(false);

    const [isCreateArchiveDialogOpen, setIsCreateArchiveDialogOpen] =
        React.useState(false);

    const entryType = props.isDirectory ? "directory" : "file";

    const revision = props.revision;

    const downloadUrl =
        revision === undefined
            ? props.agent.getRawUrl(props.fullPath, { download: true })
            : props.agent.getGitDownloadUrl(props.fullPath, revision.commitId);

    const downloadName = props.isDirectory
        ? getDirectoryArchiveName(props.entryName)
        : props.entryName;

    const archive = props.isDirectory ? null : getArchiveInfo(props.entryName);

    return (
        <>
            <PathActionMenu
                label={`Actions for ${entryType} ${props.entryName}`}
                agent={props.agent}
                path={props.fullPath}
                currentName={props.entryName}
                entryType={entryType}
                navigateAfterRename={false}
                showOpenNatively={true}
                showDownload={true}
                downloadUrl={downloadUrl}
                downloadName={downloadName}
                onDownloadDirectory={() => setIsDownloadDialogOpen(true)}
                showUnarchive={archive !== null}
                onUnarchive={() => setIsUnarchiveDialogOpen(true)}
                onCreateArchive={() => setIsCreateArchiveDialogOpen(true)}
                onDelete={() => setIsDeleteDialogOpen(true)}
                triggerClassName="@max-xl:h-7 @max-xl:w-7"
                revision={
                    revision === undefined
                        ? undefined
                        : {
                              commitId: revision.commitId,
                              transferable: !revision.nonTransferableNames.has(
                                  props.entryName,
                              ),
                          }
                }
            />
            {isUnarchiveDialogOpen ? (
                <UnarchiveDialog
                    agent={props.agent}
                    entryName={props.entryName}
                    directoryPath={props.directoryPath}
                    onClose={() => setIsUnarchiveDialogOpen(false)}
                />
            ) : null}
            {isCreateArchiveDialogOpen ? (
                <CreateArchiveDialog
                    agent={props.agent}
                    directoryPath={props.directoryPath}
                    sources={[
                        { agentId: props.agent.id, path: props.fullPath },
                    ]}
                    onClose={() => setIsCreateArchiveDialogOpen(false)}
                />
            ) : null}
            <Dialog
                isOpen={isDownloadDialogOpen}
                title="Download directory"
                description={`${props.entryName} will be streamed as a .tar.gz archive while it is downloaded.`}
                closeAriaLabel="Close directory download dialog"
                onClose={() => setIsDownloadDialogOpen(false)}
            >
                <p className="mt-4 text-sm leading-relaxed text-slate-400">
                    The archive is created on the device as data is sent, so the
                    complete directory is not buffered in memory first.
                </p>
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setIsDownloadDialogOpen(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        as="a"
                        href={downloadUrl}
                        download={downloadName}
                        onClick={() => setIsDownloadDialogOpen(false)}
                        className="font-semibold"
                    >
                        <Download className="h-4 w-4" />
                        Download .tar.gz
                    </Button>
                </DialogActions>
            </Dialog>
            {isDeleteDialogOpen ? (
                <DeletePathDialog
                    agent={props.agent}
                    path={props.fullPath}
                    name={props.entryName}
                    entryType={entryType}
                    onClose={() => setIsDeleteDialogOpen(false)}
                />
            ) : null}
        </>
    );
}

/** Renders one metadata-rich path row and its selection state. */
function FileEntry(props: {
    agent: Agent;
    directoryPath: string;
    entry: LsEntry;
    /**
     * A committed entry is selected at its commit and has no recorded time; symlinks and
     * submodules cannot be selected at all.
     */
    revision: RevisionListing | undefined;
    /** The entry's Git state; undefined when the column is not shown, null when clean. */
    gitState: GitDirectoryEntryState | null | undefined;
}) {
    const toggleSelectedFile = useSetAtom(toggleSelectedFileAtom);
    const selectedFileKeys = useAtomValue(selectedFileKeysAtom);
    const entry = props.entry;
    const isDirectory = entry.type === "directory";
    const fullPath = joinBrowserPath(props.directoryPath, entry.name);
    const rev = props.revision?.commitId;
    const readOnly = props.revision !== undefined;

    const isSelected = selectedFileKeys.has(
        getSelectedFileKey({ agentId: props.agent.id, path: fullPath, rev }),
    );

    const entryType = isDirectory ? "directory" : "file";

    const selectable =
        props.revision === undefined ||
        !props.revision.nonTransferableNames.has(entry.name);

    return (
        <tr
            className="border-b border-slate-800/60 last:border-b-0 hover:bg-tint @max-xl:text-sm"
            aria-label={`${isDirectory ? "Directory" : "File"} entry ${entry.name}`}
        >
            <td
                className="w-px whitespace-nowrap px-1 py-0.5 @xl:px-1.5 @xl:py-2"
                aria-label=""
            >
                <Checkbox
                    role="checkbox"
                    label={
                        isSelected
                            ? `Unselect ${entryType} ${entry.name}`
                            : `Select ${entryType} ${entry.name}`
                    }
                    checked={isSelected}
                    disabled={!selectable}
                    onCheckedChange={() =>
                        toggleSelectedFile({
                            agentId: props.agent.id,
                            agentName: props.agent.name,
                            path: fullPath,
                            fileName: entry.name,
                            entryType,
                            rev,
                        })
                    }
                />
            </td>
            <td className="w-px whitespace-nowrap px-1 py-0.5 @xl:px-1.5 @xl:py-2">
                {isDirectory ? (
                    <Folder className="h-4 w-4 text-blue-400 @xl:h-5 @xl:w-5" />
                ) : (
                    <File className="h-4 w-4 text-slate-500 @xl:h-5 @xl:w-5" />
                )}
            </td>
            {props.gitState === undefined ? null : (
                <GitStatusCell
                    name={entry.name}
                    state={props.gitState}
                    directoryPath={props.directoryPath}
                />
            )}
            <td className="px-1.5 py-0.5 @xl:p-2">
                <Link
                    {...browserRoute(props.agent, fullPath)}
                    data-keyboard-focus-entry="true"
                    className="block min-w-0 truncate font-medium text-blue-400 hover:underline"
                >
                    {entry.name}
                </Link>
            </td>
            <td
                className={
                    isDirectory
                        ? "px-1.5 py-0.5 text-slate-600 @xl:p-2"
                        : "px-1.5 py-0.5 text-slate-400 @xl:p-2"
                }
                aria-label={`Size for ${entry.name}`}
            >
                {isDirectory ? "-" : formatSize(entry.size)}
            </td>
            <td
                className="px-1.5 py-0.5 text-slate-400 @xl:p-2"
                aria-label={`Modified ${entry.name}`}
            >
                {readOnly ? (
                    "-"
                ) : (
                    <Tooltip
                        content={formatModifiedAge(
                            entry.modified_at,
                            Date.now(),
                        )}
                    >
                        <time
                            className="whitespace-nowrap"
                            dateTime={new Date(
                                entry.modified_at * 1000,
                            ).toISOString()}
                        >
                            {new Date(
                                entry.modified_at * 1000,
                            ).toLocaleString()}
                        </time>
                    </Tooltip>
                )}
            </td>
            <td className="px-1.5 py-0.5 text-slate-400 @xl:p-2">
                {entry.owner || "-"}
            </td>
            <td className="px-1.5 py-0.5 text-slate-400 @xl:p-2">
                {entry.group || "-"}
            </td>
            <td className="px-1.5 py-0.5 text-right @xl:p-2">
                <FileEntryActions
                    agent={props.agent}
                    entryName={entry.name}
                    fullPath={fullPath}
                    directoryPath={props.directoryPath}
                    isDirectory={isDirectory}
                    revision={props.revision}
                />
            </td>
        </tr>
    );
}
