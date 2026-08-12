import React from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    ArrowDownUp,
    ChevronDown,
    ChevronUp,
    Download,
    File,
    Folder,
    LoaderCircle,
    Pencil,
    Search,
} from "lucide-react";
import type { LsEntry } from "#bindings/LsEntry";
import type { Agent } from "#ui/api-client";
import { Checkbox } from "#ui/components/checkbox";
import { RenamePathAction } from "#ui/components/browser/path-actions";
import { Tooltip } from "#ui/components/tooltip";
import {
    FILE_SEARCH_RESULT_EVENT,
    FileSearcher,
    type FileSearchState,
} from "#ui/file-searcher";
import {
    selectedFileKeysAtom,
    toggleSelectedFileAtom,
} from "#ui/selected-files";
import {
    compareFileEntries,
    type FileSortColumn,
    type FileSortDirection,
    formatModifiedAge,
    joinBrowserPath,
} from "#ui/components/browser/utils";
import { formatSize } from "#ui/utils/path";

/** Identifies the destination that should restore filter focus after Enter navigation. */
const filterFocusPathAtom = atom<string | null>(null);

/** Switches between immediate directory filtering and remote recursive search. */
export function FileList(props: {
    agent: Agent;
    agentId: string;
    agentName: string;
    directoryPath: string;
    actions: React.ReactNode;
    files: LsEntry[];
}) {
    const navigate = useNavigate();
    const agent = props.agent;
    const [filterFocusPath, setFilterFocusPath] = useAtom(filterFocusPathAtom);
    const filterInputRef = React.useRef<HTMLInputElement>(null);
    const [filter, setFilter] = React.useState("");
    const [searchRecursively, setSearchRecursively] = React.useState(false);
    const [searchState, setSearchState] = React.useState<FileSearchState>({
        status: "idle",
    });
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
              const comparison = compareFileEntries(left, right, sort.column);
              return sort.direction === "ascending" ? comparison : -comparison;
          })
        : filteredFiles;

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
        const inputElement = filterInputRef.current;
        if (!searchRecursively || !inputElement) {
            return;
        }

        const searcher = new FileSearcher(agent, props.directoryPath);
        const handleResult = (event: Event) => {
            if (event instanceof CustomEvent) {
                setSearchState(event.detail);
            }
        };
        searcher.addEventListener(FILE_SEARCH_RESULT_EVENT, handleResult, {
            passive: true,
        });
        searcher.listenTo(inputElement);

        return () => {
            searcher.removeEventListener(
                FILE_SEARCH_RESULT_EVENT,
                handleResult,
            );
            searcher.dispose();
        };
    }, [agent, props.directoryPath, searchRecursively]);

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
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/35 p-2">
                <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Filter files</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                        ref={filterInputRef}
                        type="search"
                        aria-label="Filter files"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        onKeyDown={handleFilterKeyDown}
                        placeholder="Filter files"
                        className="w-full rounded-md border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                </label>
                <div className="shrink-0">
                    <Checkbox
                        role="checkbox"
                        checked={searchRecursively}
                        onCheckedChange={(checked) => {
                            setSearchRecursively(checked);
                            if (!checked) {
                                setSearchState({ status: "idle" });
                            }
                        }}
                    >
                        Search recursively
                    </Checkbox>
                </div>
            </div>
            {searchRecursively ? (
                <FileSearchResults agent={agent} state={searchState} />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[55rem]">
                        <thead>
                            <tr className="border-b border-slate-800 bg-[#1a1f2a]">
                                <th className="text-left p-3 text-sm font-medium text-slate-400">
                                    Select
                                </th>
                                <SortableFileColumnHeader
                                    label="Type"
                                    column="type"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <SortableFileColumnHeader
                                    label="Name"
                                    column="name"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <SortableFileColumnHeader
                                    label="Size"
                                    column="size"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <SortableFileColumnHeader
                                    label="Modified"
                                    column="modified"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <SortableFileColumnHeader
                                    label="Owner"
                                    column="owner"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <SortableFileColumnHeader
                                    label="Group"
                                    column="group"
                                    sort={sort}
                                    onSort={changeSort}
                                />
                                <th className="text-right p-3 text-sm font-medium text-slate-400">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayedFiles.map((entry) => (
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
            )}
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
            className="p-1 text-left text-sm font-medium text-slate-400"
        >
            <button
                type="button"
                onClick={() => props.onSort(props.column)}
                aria-label={`Sort by ${props.label} ${nextDirection}`}
                className="flex w-full items-center gap-1.5 rounded px-2 py-2 text-left transition-colors hover:bg-white/5 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
                {props.label}
                <SortIcon className="h-3.5 w-3.5" />
            </button>
        </th>
    );
}

/** Renders recursive matches independently from metadata-rich directory entries. */
function FileSearchResults(props: { agent: Agent; state: FileSearchState }) {
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
                    `${props.state.results.length} ${props.state.results.length === 1 ? "result" : "results"}`
                )}
            </p>
            {props.state.timedOut && (
                <p className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
                    Search timed out. Showing the matches found so far.
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
                <ul className="divide-y divide-slate-800/70">
                    {props.state.results.map((entry) => {
                        const isDirectory = entry.type === "directory";
                        return (
                            <li key={entry.path}>
                                <Link
                                    to={props.agent.getBrowserUrl(entry.path)}
                                    className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/5"
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
            <td className="p-3" aria-label="">
                <Checkbox
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
                        })
                    }
                />
            </td>
            <td className="p-3">
                {isDirectory ? (
                    <Folder className="h-5 w-5 text-blue-400" />
                ) : (
                    <File className="h-5 w-5 text-slate-500" />
                )}
            </td>
            <td className="p-3">
                <div className="flex min-w-0 items-center gap-2">
                    <Link
                        to={agent.getBrowserUrl(fullPath)}
                        className="min-w-0 truncate font-medium text-blue-400 hover:underline"
                    >
                        {entry.name}
                    </Link>
                    <RenamePathAction
                        agent={agent}
                        path={fullPath}
                        currentName={entry.name}
                        entryType={isDirectory ? "directory" : "file"}
                        navigateAfterRename={false}
                    >
                        {(renameAction) => (
                            <>
                                <Tooltip
                                    content={`Rename ${isDirectory ? "directory" : "file"}`}
                                >
                                    <button
                                        type="button"
                                        onClick={renameAction.open}
                                        aria-label={`Rename ${isDirectory ? "directory" : "file"} ${entry.name}`}
                                        className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                </Tooltip>
                                {renameAction.dialog}
                            </>
                        )}
                    </RenamePathAction>
                </div>
            </td>
            <td
                className={
                    isDirectory ? "p-3 text-slate-600" : "p-3 text-slate-400"
                }
                aria-label={`Size for ${entry.name}`}
            >
                {isDirectory ? "-" : formatSize(entry.size)}
            </td>
            <td
                className="p-3 text-slate-400"
                aria-label={`Modified ${entry.name}`}
            >
                <Tooltip
                    content={formatModifiedAge(entry.modified_at, Date.now())}
                >
                    <time
                        dateTime={new Date(
                            entry.modified_at * 1000,
                        ).toISOString()}
                    >
                        {new Date(entry.modified_at * 1000).toLocaleString()}
                    </time>
                </Tooltip>
            </td>
            <td className="p-3 text-slate-400">{entry.owner || "-"}</td>
            <td className="p-3 text-slate-400">{entry.group || "-"}</td>
            <td className="p-3 text-right">
                <Tooltip
                    content={
                        isDirectory
                            ? "Download as .tar.gz archive"
                            : "Download file"
                    }
                >
                    <a
                        href={agent.getRawUrl(fullPath, {
                            download: true,
                        })}
                        download={
                            isDirectory ? `${entry.name}.tar.gz` : entry.name
                        }
                        aria-label={
                            isDirectory
                                ? `Download directory ${entry.name} as .tar.gz`
                                : `Download file ${entry.name}`
                        }
                        className="inline-flex shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                    >
                        <Download className="h-3.5 w-3.5" />
                    </a>
                </Tooltip>
            </td>
        </tr>
    );
}
