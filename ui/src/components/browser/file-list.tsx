import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
    ArrowDownUp,
    ChevronDown,
    ChevronUp,
    Download,
    File,
    Folder,
    FolderSearch,
    GitBranch,
    Eye,
    EyeOff,
    LoaderCircle,
    Search,
} from "lucide-react";
import type { LsEntry } from "#bindings/LsEntry";
import type { MountPoint } from "#bindings/MountPoint";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { PathActionMenu } from "#ui/components/browser/path-actions";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { InputControl } from "#ui/components/input-control";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Tooltip } from "#ui/components/tooltip";
import { ToggleButton } from "#ui/components/toggle-button";
import type { FileSearchEntry, FileSearchResponse } from "#ui/api-client";
import {
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
    unselectFileAtom,
} from "#ui/selected-files";
import {
    compareFileEntries,
    type FileSortColumn,
    type FileSortDirection,
    formatModifiedAge,
    getErrorMessage,
    joinBrowserPath,
} from "#ui/components/browser/utils";
import { formatSize } from "#ui/utils/path";
import { fileSearchQueryOptions } from "#ui/queries";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";
import { useUserState } from "#ui/user-state";

/** Identifies the destination that should restore filter focus after Enter navigation. */
const filterFocusPathAtom = atom<string | null>(null);

type FileSearchState =
    | { status: "idle" }
    | {
          status: "searching" | "success";
          query: string;
          results: Array<FileSearchEntry>;
          timedOut: boolean;
          durationMs: number;
      }
    | { status: "error"; query: string; message: string };

/** Handles shortcuts that only exist while the file list is mounted. */
function useFileListShortcuts(props: {
    filterInputRef: React.RefObject<HTMLInputElement | null>;
    filter: string;
    setFilter: React.Dispatch<React.SetStateAction<string>>;
    searchRecursively: boolean;
    setSearchRecursively: React.Dispatch<React.SetStateAction<boolean>>;
}) {
    React.useEffect(() => {
        /** Keeps file-browser shortcuts from replacing text entered into form controls. */
        const handleShortcut = (event: KeyboardEvent) => {
            if (shouldIgnoreKeyboardShortcut(event, { shift: true })) {
                return;
            }

            if (event.key === "Escape") {
                if (props.searchRecursively) {
                    props.setSearchRecursively(false);
                } else if (props.filter !== "") {
                    props.setFilter("");
                }
                return;
            }

            if (event.key === "f") {
                event.preventDefault();
                props.filterInputRef.current?.focus();
                return;
            }
            if (event.key === "s") {
                event.preventDefault();
                props.setSearchRecursively(true);
                props.filterInputRef.current?.focus();
                return;
            }
        };

        window.addEventListener("keydown", handleShortcut);
        return () => window.removeEventListener("keydown", handleShortcut);
    }, [
        props.filterInputRef,
        props.filter,
        props.setFilter,
        props.searchRecursively,
        props.setSearchRecursively,
    ]);
}

/** Maps Query's transport state into the existing recursive-search presentation. */
function getFileSearchState(props: {
    filter: string;
    query: string;
    search: ReturnType<typeof useQuery<FileSearchResponse>>;
}): FileSearchState {
    if (props.filter.trim() === "") {
        return { status: "idle" };
    }
    if (props.search.isError) {
        return {
            status: "error",
            query: props.query,
            message:
                props.search.error instanceof Error
                    ? props.search.error.message
                    : "File search failed",
        };
    }
    if (props.search.data) {
        return {
            status: props.search.isFetching ? "searching" : "success",
            query: props.query,
            results: props.search.data.results,
            timedOut: props.search.data.timed_out,
            durationMs: props.search.data.duration_ms,
        };
    }
    return {
        status: "searching",
        query: props.query,
        results: [],
        timedOut: false,
        durationMs: 0,
    };
}

/** Switches between immediate directory filtering and remote recursive search. */
export function FileList(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    directoryPath: string;
    actions: React.ReactNode;
    files: LsEntry[];
    mountPoint: MountPoint | null;
}) {
    const navigate = useNavigate();
    const agent = props.agent;
    const [filterFocusPath, setFilterFocusPath] = useAtom(filterFocusPathAtom);
    const filterInputRef = React.useRef<HTMLInputElement>(null);
    const [filter, setFilter] = React.useState("");
    const [searchRecursively, setSearchRecursively] = React.useState(false);
    const [userState, setUserState] = useUserState();
    const searchTimeoutSeconds = userState.recursiveSearchTimeoutSeconds;
    const includeHiddenDirectories = userState.recursiveSearchIncludeHidden;
    const respectGitignore = userState.recursiveSearchRespectGitignore;
    const [debouncedFilter, setDebouncedFilter] = React.useState("");
    const [sort, setSort] = React.useState<{
        column: FileSortColumn;
        direction: FileSortDirection;
    } | null>(null);
    const normalizedFilter = filter.toLowerCase();
    const filteredFiles = props.files.filter((entry) =>
        entry.name.toLowerCase().includes(normalizedFilter),
    );
    const displayedFiles = sort
        ? [...filteredFiles].sort((left, right) => {
              return compareFileEntries(left, right, sort);
          })
        : filteredFiles;
    const recursiveSearch = useQuery(
        fileSearchQueryOptions(agent, props.directoryPath, {
            query: searchRecursively ? debouncedFilter : "",
            timeoutSeconds: searchTimeoutSeconds,
            includeHidden: includeHiddenDirectories,
            respectGitignore,
        }),
    );
    const searchState = getFileSearchState({
        filter,
        query: debouncedFilter,
        search: recursiveSearch,
    });
    useFileListShortcuts({
        filterInputRef,
        filter,
        setFilter,
        searchRecursively,
        setSearchRecursively,
    });

    const changeSort = (column: FileSortColumn) => {
        setSort((current) => ({
            column,
            direction:
                current?.column === column && current.direction === "ascending"
                    ? "descending"
                    : "ascending",
        }));
    };

    React.useEffect(() => {
        if (filterFocusPath !== props.directoryPath) {
            return;
        }

        filterInputRef.current?.focus();
        setFilterFocusPath(null);
    }, [filterFocusPath, props.directoryPath, setFilterFocusPath]);

    React.useEffect(() => {
        if (!searchRecursively) {
            setDebouncedFilter("");
            return;
        }
        const timer = window.setTimeout(() => setDebouncedFilter(filter), 200);
        return () => window.clearTimeout(timer);
    }, [filter, searchRecursively]);

    const handleFilterKeyDown = async (
        event: React.KeyboardEvent<HTMLInputElement>,
    ) => {
        if (event.key !== "Enter") {
            return;
        }

        const destinationPath = searchRecursively
            ? searchState.status === "success"
                ? searchState.results[0]?.path
                : undefined
            : filteredFiles[0]
              ? joinBrowserPath(props.directoryPath, filteredFiles[0].name)
              : undefined;
        if (!destinationPath) {
            return;
        }

        event.preventDefault();
        setFilterFocusPath(destinationPath);
        await navigate({
            to: agent.getBrowserUrl(destinationPath),
        });
    };

    return (
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]">
            {props.actions}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-900/35 p-1.5 sm:gap-2 sm:p-2">
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
                        placeholder="Filter files (f, s for recursive)"
                        className="w-full bg-slate-900 py-1.5 pl-9 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500 sm:py-2"
                    />
                </label>
                <RecursiveSearchControls
                    active={searchRecursively}
                    timeoutSeconds={searchTimeoutSeconds}
                    includeHiddenDirectories={includeHiddenDirectories}
                    respectGitignore={respectGitignore}
                    onActiveChange={setSearchRecursively}
                    onTimeoutChange={(recursiveSearchTimeoutSeconds) =>
                        setUserState((current) => ({
                            ...current,
                            recursiveSearchTimeoutSeconds,
                        }))
                    }
                    onIncludeHiddenChange={(recursiveSearchIncludeHidden) =>
                        setUserState((current) => ({
                            ...current,
                            recursiveSearchIncludeHidden,
                        }))
                    }
                    onRespectGitignoreChange={(
                        recursiveSearchRespectGitignore,
                    ) =>
                        setUserState((current) => ({
                            ...current,
                            recursiveSearchRespectGitignore,
                        }))
                    }
                />
            </div>
            {searchRecursively ? (
                <FileSearchResults agent={agent} state={searchState} />
            ) : (
                <FileTable
                    agent={props.agent}
                    agentId={props.agentId}
                    agentName={props.agentName}
                    directoryPath={props.directoryPath}
                    files={displayedFiles}
                    sort={sort}
                    onSort={changeSort}
                />
            )}
            <FilesystemFooter mountPoint={props.mountPoint} />
        </div>
    );
}

/** Keeps current filesystem capacity visible below local and recursive file results. */
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

/** Keeps optional recursive-search controls compact and absent from local filtering mode. */
function RecursiveSearchControls(props: {
    active: boolean;
    timeoutSeconds: number;
    includeHiddenDirectories: boolean;
    respectGitignore: boolean;
    onActiveChange: React.Dispatch<React.SetStateAction<boolean>>;
    onTimeoutChange: (timeoutSeconds: number) => void;
    onIncludeHiddenChange: (includeHiddenDirectories: boolean) => void;
    onRespectGitignoreChange: (respectGitignore: boolean) => void;
}) {
    return (
        <>
            {props.active && (
                <>
                    <Tooltip content="Maximum recursive search duration in seconds (1-60)">
                        <label>
                            <span className="sr-only">
                                Search timeout in seconds
                            </span>
                            <InputControl
                                type="number"
                                aria-label="Search timeout in seconds"
                                min={1}
                                max={60}
                                value={props.timeoutSeconds}
                                onChange={(event) => {
                                    const value = event.target.valueAsNumber;
                                    if (Number.isInteger(value)) {
                                        props.onTimeoutChange(
                                            Math.min(60, Math.max(1, value)),
                                        );
                                    }
                                }}
                                className="w-16 bg-slate-900 px-2 text-sm focus:ring-1 focus:ring-blue-500"
                            />
                        </label>
                    </Tooltip>
                    <ToggleButton
                        label="Search hidden directories"
                        pressed={props.includeHiddenDirectories}
                        tooltip={
                            props.includeHiddenDirectories
                                ? "Click to exclude hidden directories from search"
                                : "Click to search from hidden directories"
                        }
                        onClick={() =>
                            props.onIncludeHiddenChange(
                                !props.includeHiddenDirectories,
                            )
                        }
                    >
                        {props.includeHiddenDirectories ? (
                            <Eye className="h-4 w-4" />
                        ) : (
                            <EyeOff className="h-4 w-4" />
                        )}
                    </ToggleButton>
                    <ToggleButton
                        label="Respect .gitignore files"
                        pressed={props.respectGitignore}
                        tooltip={
                            props.respectGitignore
                                ? "Click to search files ignored by .gitignore"
                                : "Click to exclude files ignored by .gitignore from search"
                        }
                        onClick={() =>
                            props.onRespectGitignoreChange(
                                !props.respectGitignore,
                            )
                        }
                    >
                        <GitBranch className="h-4 w-4" />
                    </ToggleButton>
                </>
            )}
            <ToggleButton
                label="Search recursively"
                pressed={props.active}
                tooltip={
                    props.active
                        ? "Click to search only this directory"
                        : "Click to search recursively (s)"
                }
                onClick={() => props.onActiveChange((current) => !current)}
            >
                <FolderSearch className="h-4 w-4" />
            </ToggleButton>
        </>
    );
}

/** Owns keyboard focus for the currently visible local file entries. */
function FileTable(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    directoryPath: string;
    files: LsEntry[];
    sort: { column: FileSortColumn; direction: FileSortDirection } | null;
    onSort: (column: FileSortColumn) => void;
}) {
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
                    <tr className="border-b border-slate-800 bg-[#1a1f2a]">
                        <th className="p-1.5 text-left text-sm font-medium text-slate-400 sm:p-2">
                            Select
                        </th>
                        <SortableFileColumnHeader
                            label="Type"
                            column="type"
                            sort={props.sort}
                            onSort={props.onSort}
                        />
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
                        <th className="p-1.5 text-right text-sm font-medium text-slate-400 sm:p-2">
                            Actions
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {props.files.map((entry) => (
                        <FileEntry
                            key={entry.name}
                            agent={props.agent}
                            agentId={props.agentId}
                            agentName={props.agentName}
                            directoryPath={props.directoryPath}
                            entry={entry}
                            isParent={false}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Provides one accessible control that toggles a file-list sort direction. */
function SortableFileColumnHeader(props: {
    label: string;
    column: FileSortColumn;
    sort: { column: FileSortColumn; direction: FileSortDirection } | null;
    onSort: (column: FileSortColumn) => void;
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

    return (
        <th
            aria-sort={direction ?? "none"}
            className="p-0.5 text-left text-sm font-medium text-slate-400"
        >
            <button
                type="button"
                onClick={() => props.onSort(props.column)}
                aria-label={`Sort by ${props.label} ${nextDirection}`}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left transition-colors hover:bg-white/5 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
                {props.label}
                <SortIcon className="h-3.5 w-3.5" />
            </button>
        </th>
    );
}

/** Renders recursive matches independently from metadata-rich directory entries. */
function FileSearchResults(props: { agent: Agent; state: FileSearchState }) {
    const resultsRef = React.useRef<HTMLUListElement>(null);
    const getEntries = React.useEffectEvent(() =>
        Array.from(
            resultsRef.current?.querySelectorAll<HTMLElement>(
                '[data-keyboard-focus-entry="true"]',
            ) ?? [],
        ),
    );
    useArrayKeyboardFocus(getEntries);

    if (props.state.status === "idle") {
        return (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
                Type a file or directory name to search below this directory.
            </div>
        );
    }
    if (props.state.status === "error") {
        return (
            <div
                role="alert"
                className="bg-red-950/30 px-4 py-3 text-sm text-red-300"
            >
                {props.state.message}
            </div>
        );
    }

    return (
        <div>
            <p
                role={props.state.status === "searching" ? "status" : undefined}
                className="flex h-9 items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-4 text-xs text-slate-400"
            >
                {props.state.status === "searching" ? (
                    <>
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-blue-400" />
                        Updating results...
                    </>
                ) : (
                    <span>
                        Found{" "}
                        <Tooltip content="100 is the maximum number of results a search can return.">
                            <span>{props.state.results.length}</span>
                        </Tooltip>{" "}
                        {props.state.results.length === 1
                            ? "result"
                            : "results"}{" "}
                        in{" "}
                        <Tooltip content="Search duration was measured on the agent.">
                            <span>{props.state.durationMs}ms</span>
                        </Tooltip>
                    </span>
                )}
            </p>
            {props.state.timedOut && (
                <p className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
                    Search deadlined. Increase the search duration to see more.
                </p>
            )}
            {props.state.status === "searching" &&
            props.state.results.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">
                    Searching recursively...
                </p>
            ) : props.state.results.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">
                    No recursive matches found for &quot;{props.state.query}
                    &quot;.
                </p>
            ) : (
                <ul ref={resultsRef} className="divide-y divide-slate-800/70">
                    {props.state.results.map((entry) => {
                        const isDirectory = entry.type === "directory";
                        return (
                            <li key={entry.path}>
                                <Link
                                    to={props.agent.getBrowserUrl(entry.path)}
                                    data-keyboard-focus-entry="true"
                                    className="group flex items-start gap-2 px-2 py-1.5 transition-colors hover:bg-white/5 sm:gap-3 sm:px-3 sm:py-2"
                                >
                                    {isDirectory ? (
                                        <Folder className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
                                    ) : (
                                        <File className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
                                    )}
                                    <span className="min-w-0">
                                        <span className="block font-medium text-blue-400 group-hover:underline">
                                            {entry.name}
                                        </span>
                                        <span className="block truncate font-mono text-xs text-slate-500">
                                            {entry.path}
                                        </span>
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

/** Keeps mutations and download confirmation behind one compact row menu. */
function FileEntryActions(props: {
    agent: Agent;
    agentId: string;
    entryName: string;
    fullPath: string;
    isDirectory: boolean;
}) {
    const router = useRouter();
    const unselectFile = useSetAtom(unselectFileAtom);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
    const [isDownloadDialogOpen, setIsDownloadDialogOpen] =
        React.useState(false);
    const entryType = props.isDirectory ? "directory" : "file";
    const downloadUrl = props.agent.getRawUrl(props.fullPath, {
        download: true,
    });
    const downloadName = props.isDirectory
        ? `${props.entryName}.tar.gz`
        : props.entryName;
    const deleteMutation = useMutation({
        mutationFn: () => props.agent.deleteFile(props.fullPath),
        onSuccess: async () => {
            unselectFile({ agentId: props.agentId, path: props.fullPath });
            setIsDeleteDialogOpen(false);
            await router.invalidate();
        },
    });

    const closeDeleteDialog = () => {
        if (!deleteMutation.isPending) {
            setIsDeleteDialogOpen(false);
            deleteMutation.reset();
        }
    };

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
                onDelete={() => {
                    deleteMutation.reset();
                    setIsDeleteDialogOpen(true);
                }}
            />
            <Dialog
                isOpen={isDownloadDialogOpen}
                title="Download directory"
                description={`${props.entryName} will be streamed as a .tar.gz archive while it is downloaded.`}
                closeAriaLabel="Close directory download dialog"
                onClose={() => setIsDownloadDialogOpen(false)}
            >
                <p className="mt-4 text-sm leading-relaxed text-slate-400">
                    The archive is created on the agent as data is sent, so the
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
                    <a
                        href={downloadUrl}
                        download={downloadName}
                        onClick={() => setIsDownloadDialogOpen(false)}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500"
                    >
                        <Download className="h-4 w-4" />
                        Download .tar.gz
                    </a>
                </DialogActions>
            </Dialog>
            <ConfirmationDialog
                isOpen={isDeleteDialogOpen}
                title={`Delete this ${entryType}?`}
                description={`This permanently deletes ${props.entryName} from the agent filesystem.`}
                confirmLabel={`Delete ${entryType}`}
                busyLabel="Deleting..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? getErrorMessage(deleteMutation.error, "Delete failed")
                        : null
                }
                onClose={closeDeleteDialog}
                onConfirm={() => deleteMutation.mutate()}
            >
                <p className="overflow-x-auto whitespace-nowrap rounded-md border border-slate-800 bg-[#0b0d12] px-3 py-2.5 font-mono text-sm text-slate-300">
                    {props.fullPath}
                </p>
            </ConfirmationDialog>
        </>
    );
}

/** Renders one metadata-rich path row and its selection state. */
function FileEntry(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    directoryPath: string;
    entry: LsEntry;
    isParent: boolean;
}) {
    const toggleSelectedFile = useSetAtom(toggleSelectedFileAtom);
    const selectedFileKeys = useAtomValue(selectedFileKeysAtom);
    const { agentId, agentName, directoryPath, entry, isParent } = props;
    const isDirectory = entry.type === "directory" || isParent;
    const fullPath = joinBrowserPath(directoryPath, entry.name);
    const agent = props.agent;
    const isSelected = selectedFileKeys.has(`${agentId}:${fullPath}`);

    return (
        <tr
            className="border-b border-slate-800/60 last:border-b-0 hover:bg-white/5"
            aria-label={`${isDirectory ? "Directory" : "File"} entry ${entry.name}`}
        >
            <td className="p-1.5 sm:p-2" aria-label="">
                <Checkbox
                    role="checkbox"
                    label={
                        isSelected
                            ? `Unselect ${isDirectory ? "directory" : "file"} ${entry.name}`
                            : `Select ${isDirectory ? "directory" : "file"} ${entry.name}`
                    }
                    checked={isSelected}
                    onCheckedChange={() =>
                        toggleSelectedFile({
                            agentId,
                            agentName,
                            path: fullPath,
                            fileName: entry.name,
                            entryType: isDirectory ? "directory" : "file",
                        })
                    }
                />
            </td>
            <td className="p-1.5 sm:p-2">
                {isDirectory ? (
                    <Folder className="h-5 w-5 text-blue-400" />
                ) : (
                    <File className="h-5 w-5 text-slate-500" />
                )}
            </td>
            <td className="p-1.5 sm:p-2">
                <Link
                    to={agent.getBrowserUrl(fullPath)}
                    data-keyboard-focus-entry="true"
                    className="block min-w-0 truncate font-medium text-blue-400 hover:underline"
                >
                    {entry.name}
                </Link>
            </td>
            <td
                className={
                    isDirectory
                        ? "p-1.5 text-slate-600 sm:p-2"
                        : "p-1.5 text-slate-400 sm:p-2"
                }
                aria-label={`Size for ${entry.name}`}
            >
                {isDirectory ? "-" : formatSize(entry.size)}
            </td>
            <td
                className="p-1.5 text-slate-400 sm:p-2"
                aria-label={`Modified ${entry.name}`}
            >
                <Tooltip
                    content={formatModifiedAge(entry.modified_at, Date.now())}
                >
                    <time
                        className="whitespace-nowrap"
                        dateTime={new Date(
                            entry.modified_at * 1000,
                        ).toISOString()}
                    >
                        {new Date(entry.modified_at * 1000).toLocaleString()}
                    </time>
                </Tooltip>
            </td>
            <td className="p-1.5 text-slate-400 sm:p-2">
                {entry.owner || "-"}
            </td>
            <td className="p-1.5 text-slate-400 sm:p-2">
                {entry.group || "-"}
            </td>
            <td className="p-1.5 text-right sm:p-2">
                <FileEntryActions
                    agent={agent}
                    agentId={agentId}
                    entryName={entry.name}
                    fullPath={fullPath}
                    isDirectory={isDirectory}
                />
            </td>
        </tr>
    );
}
