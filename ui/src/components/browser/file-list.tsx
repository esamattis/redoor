import React from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
    ArrowDownUp,
    ChevronDown,
    ChevronUp,
    Download,
    File,
    Folder,
    Search,
} from "lucide-react";
import type { LsEntry } from "#bindings/LsEntry";
import type { MountPoint } from "#bindings/MountPoint";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { PathActionMenu } from "#ui/components/browser/path-actions";
import { DeletePathsDialog } from "#ui/components/browser/delete-paths-dialog";
import { InputControl } from "#ui/components/input-control";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { TextField } from "#ui/components/text-field";
import { Tooltip } from "#ui/components/tooltip";
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
    joinBrowserPath,
} from "#ui/components/browser/utils";
import { formatSize } from "#ui/utils/path";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";
import { useArrayKeyboardFocus } from "#ui/utils/use-array-keyboard-focus";
import {
    buildUnarchiveCommand,
    getArchiveInfo,
    getCustomArchiveDirectoryError,
    type UnarchiveDestination,
} from "#ui/utils/archive";
import { requestTerminalCreationAtom } from "#ui/bottom-drawer-state";

/** Identifies the destination that should restore filter focus after Enter navigation. */
const filterFocusPathAtom = atom<string | null>(null);

/** Handles shortcuts that only exist while the file list is mounted. */
function useFileListShortcuts(props: {
    filterInputRef: React.RefObject<HTMLInputElement | null>;
    filter: string;
    setFilter: React.Dispatch<React.SetStateAction<string>>;
}) {
    React.useEffect(() => {
        /** Keeps file-browser shortcuts from replacing text entered into form controls. */
        const handleShortcut = (event: KeyboardEvent) => {
            if (shouldIgnoreKeyboardShortcut(event, { shift: true })) {
                return;
            }

            if (event.key === "Escape") {
                if (props.filter !== "") {
                    props.setFilter("");
                }
                return;
            }

            if (event.key === "f") {
                event.preventDefault();
                props.filterInputRef.current?.focus();
                return;
            }
        };

        window.addEventListener("keydown", handleShortcut);
        return () => window.removeEventListener("keydown", handleShortcut);
    }, [props.filterInputRef, props.filter, props.setFilter]);
}

/** Filters only the loaded directory entries so recursive search remains in the shared dialog. */
export function FileList(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    directoryPath: string;
    actions: React.ReactNode;
    files: LsEntry[];
    showHiddenFiles: boolean;
    mountPoint: MountPoint | null;
}) {
    const navigate = useNavigate();
    const agent = props.agent;
    const [filterFocusPath, setFilterFocusPath] = useAtom(filterFocusPathAtom);
    const filterInputRef = React.useRef<HTMLInputElement>(null);
    const [filter, setFilter] = React.useState("");
    const [sort, setSort] = React.useState<{
        column: FileSortColumn;
        direction: FileSortDirection;
    } | null>(null);
    const normalizedFilter = filter.toLowerCase();
    // A leading dot is a hidden-name query, so include those entries without flipping the toggle.
    const includeHiddenFiles = props.showHiddenFiles || filter.startsWith(".");
    const visibleFiles = includeHiddenFiles
        ? props.files
        : props.files.filter((entry) => !entry.name.startsWith("."));
    const filteredFiles = visibleFiles.filter((entry) =>
        entry.name.toLowerCase().includes(normalizedFilter),
    );
    const displayedFiles = sort
        ? [...filteredFiles].sort((left, right) => {
              return compareFileEntries(left, right, sort);
          })
        : filteredFiles;
    useFileListShortcuts({
        filterInputRef,
        filter,
        setFilter,
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
                        placeholder="Filter files (f)"
                        className="w-full bg-slate-900 py-1.5 pl-9 text-sm placeholder:text-slate-500 focus:ring-1 focus:ring-blue-500 sm:py-2"
                    />
                </label>
            </div>
            <FileTable
                agent={props.agent}
                agentId={props.agentId}
                agentName={props.agentName}
                directoryPath={props.directoryPath}
                files={displayedFiles}
                sort={sort}
                onSort={changeSort}
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
    const requestTerminalCreation = useSetAtom(requestTerminalCreationAtom);
    const archive = getArchiveInfo(props.entryName);

    /** Validates before queuing so invalid shell input remains visible and actionable. */
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
        requestTerminalCreation({
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
    agentId: string;
    entryName: string;
    fullPath: string;
    directoryPath: string;
    isDirectory: boolean;
}) {
    const router = useRouter();
    const unselectFile = useSetAtom(unselectFileAtom);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
    const [isDownloadDialogOpen, setIsDownloadDialogOpen] =
        React.useState(false);
    const [isUnarchiveDialogOpen, setIsUnarchiveDialogOpen] =
        React.useState(false);
    const entryType = props.isDirectory ? "directory" : "file";
    const downloadUrl = props.agent.getRawUrl(props.fullPath, {
        download: true,
    });
    const downloadName = props.isDirectory
        ? `${props.entryName}.tar.gz`
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
                onDelete={() => setIsDeleteDialogOpen(true)}
            />
            {isUnarchiveDialogOpen ? (
                <UnarchiveDialog
                    agent={props.agent}
                    entryName={props.entryName}
                    directoryPath={props.directoryPath}
                    onClose={() => setIsUnarchiveDialogOpen(false)}
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
            <DeletePathsDialog
                isOpen={isDeleteDialogOpen}
                title={`Delete this ${entryType}?`}
                description={
                    props.agent.supportsTrash
                        ? `Move ${props.entryName} to the agent trash. You can restore it later from the Trash tab.`
                        : `Move ${props.entryName} to the native agent Trash.`
                }
                targets={[{ agent: props.agent, path: props.fullPath }]}
                trashConfirmLabel="Move to trash"
                permanentConfirmLabel={`Delete ${entryType}`}
                onClose={() => setIsDeleteDialogOpen(false)}
                onDeleted={async () => {
                    unselectFile({
                        agentId: props.agentId,
                        path: props.fullPath,
                    });
                    await router.invalidate();
                }}
            >
                <p className="overflow-x-auto whitespace-nowrap rounded-md border border-slate-800 bg-[#0b0d12] px-3 py-2.5 font-mono text-sm text-slate-300">
                    {props.fullPath}
                </p>
            </DeletePathsDialog>
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
                    directoryPath={directoryPath}
                    isDirectory={isDirectory}
                />
            </td>
        </tr>
    );
}
