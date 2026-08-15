import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    Check,
    Copy,
    Download,
    File,
    Folder,
    MoreHorizontal,
    Pencil,
    Trash2,
} from "lucide-react";
import type {
    Agent,
    LsDirectoryResponse,
    LsFileResponse,
} from "#ui/api-client";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { RenamePathAction } from "#ui/components/browser/path-actions";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import {
    getErrorMessage,
    getImmediateParentPath,
} from "#ui/components/browser/utils";
import { formatSize } from "#ui/utils/path";

/** Converts permission bits to the compact notation people expect from Unix tools. */
function formatSymbolicPermissions(permissions: number): string {
    const permissionBits = [
        { bit: 0o400, symbol: "r" },
        { bit: 0o200, symbol: "w" },
        { bit: 0o100, symbol: "x" },
        { bit: 0o040, symbol: "r" },
        { bit: 0o020, symbol: "w" },
        { bit: 0o010, symbol: "x" },
        { bit: 0o004, symbol: "r" },
        { bit: 0o002, symbol: "w" },
        { bit: 0o001, symbol: "x" },
    ];

    return permissionBits
        .map((permission) =>
            permissions & permission.bit ? permission.symbol : "-",
        )
        .join("");
}

/** Keeps repeated metadata cells visually and semantically consistent. */
function MetadataItem(props: {
    label: string;
    value: React.ReactNode;
    valueLabel?: string;
    mono?: boolean;
}) {
    return (
        <div className="rounded-xl border border-slate-800/80 bg-slate-950/35 px-4 py-3.5">
            <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                {props.label}
            </dt>
            <dd
                aria-label={props.valueLabel}
                className={`mt-1.5 truncate text-sm font-semibold text-slate-100 ${props.mono ? "font-mono" : ""}`}
            >
                {props.value}
            </dd>
        </div>
    );
}

/** Makes raw permission bits understandable without requiring users to decode octal values. */
function PermissionsGrid(props: { permissions: number }) {
    const rows = [
        { label: "Owner", bits: [0o400, 0o200, 0o100] },
        { label: "Group", bits: [0o040, 0o020, 0o010] },
        { label: "Others", bits: [0o004, 0o002, 0o001] },
    ];
    const columns = ["Read", "Write", "Execute"];

    return (
        <div className="overflow-hidden rounded-xl border border-slate-800/80">
            <table className="w-full table-fixed text-sm">
                <thead className="bg-slate-950/60 text-xs font-medium uppercase tracking-wider text-slate-500">
                    <tr>
                        <th scope="col" className="px-3 py-3 text-left">
                            Scope
                        </th>
                        {columns.map((column) => (
                            <th
                                key={column}
                                scope="col"
                                className="px-2 py-3 text-center"
                            >
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                    {rows.map((row) => (
                        <tr key={row.label} className="bg-slate-950/25">
                            <th
                                scope="row"
                                className="px-3 py-3 text-left font-medium text-slate-300"
                            >
                                {row.label}
                            </th>
                            {row.bits.map((bit, index) => {
                                const column = columns[index];
                                if (!column) return null;

                                const isAllowed = Boolean(
                                    props.permissions & bit,
                                );
                                return (
                                    <td
                                        key={bit}
                                        aria-label={`${row.label} ${column}: ${isAllowed ? "allowed" : "not allowed"}`}
                                        className="px-2 py-2 text-center"
                                    >
                                        <span
                                            className={`inline-flex h-7 w-7 items-center justify-center rounded-md font-mono text-xs font-bold ${isAllowed ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-800/50 text-slate-600"}`}
                                        >
                                            {isAllowed
                                                ? column.charAt(0).toLowerCase()
                                                : "–"}
                                        </span>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Describes the ownership and access fields shared by files and directories. */
type FilesystemMetadata = {
    owner: string | null;
    group: string | null;
    uid: number;
    gid: number;
    permissions: number;
};

/** Presents shared filesystem identity and Unix access metadata consistently. */
function FilesystemMetadataSections(props: {
    metadata: FilesystemMetadata;
    size?: number;
    entryCount?: number;
    headingPrefix: string;
}) {
    const symbolicPermissions = formatSymbolicPermissions(
        props.metadata.permissions,
    );
    const octalPermissions = `0${props.metadata.permissions
        .toString(8)
        .padStart(3, "0")}`;
    const headingIdPrefix = props.headingPrefix.toLowerCase();

    return (
        <div className="grid gap-8 p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(21rem,0.72fr)]">
            <section aria-labelledby={`${headingIdPrefix}-metadata-heading`}>
                <div className="mb-4">
                    <h2
                        id={`${headingIdPrefix}-metadata-heading`}
                        className="text-base font-semibold text-slate-100"
                    >
                        Metadata
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Filesystem identity and storage information.
                    </p>
                </div>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {props.size === undefined ? null : (
                        <MetadataItem
                            label="Size"
                            value={formatSize(props.size)}
                            valueLabel="File size value"
                        />
                    )}
                    {props.entryCount === undefined ? null : (
                        <MetadataItem
                            label="Entries"
                            value={props.entryCount}
                            valueLabel="Directory entry count"
                        />
                    )}
                    <MetadataItem
                        label="Owner"
                        value={props.metadata.owner || "Unknown"}
                    />
                    <MetadataItem
                        label="Group"
                        value={props.metadata.group || "Unknown"}
                    />
                    <MetadataItem label="UID" value={props.metadata.uid} mono />
                    <MetadataItem label="GID" value={props.metadata.gid} mono />
                    <MetadataItem
                        label="Permissions"
                        value={`${symbolicPermissions} · ${octalPermissions}`}
                        mono
                    />
                </dl>
            </section>

            <section aria-labelledby={`${headingIdPrefix}-permissions-heading`}>
                <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                        <h2
                            id={`${headingIdPrefix}-permissions-heading`}
                            className="text-base font-semibold text-slate-100"
                        >
                            Permissions
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Access granted by the Unix mode.
                        </p>
                    </div>
                    <div className="text-right font-mono">
                        <p className="text-sm font-semibold text-slate-200">
                            {symbolicPermissions}
                        </p>
                        <p className="text-xs text-slate-500">
                            {octalPermissions}
                        </p>
                    </div>
                </div>
                <PermissionsGrid permissions={props.metadata.permissions} />
            </section>
        </div>
    );
}

/** Presents file and directory identity consistently while allowing file-only path copying. */
function PathDetailHeader(props: {
    entryType: "file" | "directory";
    name: string;
    path: string;
    pathCopied?: boolean;
    onCopyPath?: () => void;
    nameActions?: React.ReactNode;
    cornerActions?: React.ReactNode;
}) {
    const isDirectory = props.entryType === "directory";
    const typeLabel = isDirectory ? "Directory" : "File";

    return (
        <header className="relative overflow-hidden border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
            <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/5 blur-3xl" />
            {props.cornerActions ? (
                <div className="absolute right-3 top-3 z-10">
                    {props.cornerActions}
                </div>
            ) : null}
            <div className="relative flex min-w-0 items-start gap-4 pr-10">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 shadow-inner shadow-blue-400/10">
                    {isDirectory ? (
                        <Folder className="h-7 w-7 text-blue-400" />
                    ) : (
                        <File className="h-7 w-7 text-blue-400" />
                    )}
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        {typeLabel} details
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <h1
                            aria-label={`${typeLabel} name`}
                            className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                        >
                            {props.name}
                        </h1>
                        {props.nameActions ? (
                            <div className="flex w-full shrink-0 justify-start md:ml-auto md:w-auto md:justify-end">
                                {props.nameActions}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="relative mt-6">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                        Full Path
                    </p>
                    {props.onCopyPath ? (
                        <button
                            type="button"
                            onClick={props.onCopyPath}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-200"
                            aria-label="Copy full path"
                        >
                            {props.pathCopied ? (
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                            {props.pathCopied ? "Copied" : "Copy"}
                        </button>
                    ) : null}
                </div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 font-mono text-sm text-slate-300">
                    {props.path}
                </code>
            </div>
        </header>
    );
}

/** Keeps destructive file-detail actions compact while preserving confirmation and navigation. */
function FileDetailMenu(props: {
    agent: Agent;
    path: string;
    fileName: string;
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.path);
    const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);
    const deleteMutation = useMutation({
        mutationFn: () => props.agent.deleteFile(props.path),
        onSuccess: async () => {
            if (parentPath === null) {
                return;
            }
            setIsDeleteOpen(false);
            await navigate({ to: props.agent.getBrowserUrl(parentPath) });
        },
    });

    /** Closes deletion only when no request is still using the dialog state. */
    const closeDeleteDialog = () => {
        if (deleteMutation.isPending) {
            return;
        }
        setIsDeleteOpen(false);
        deleteMutation.reset();
    };

    return (
        <RenamePathAction
            agent={props.agent}
            path={props.path}
            currentName={props.fileName}
            entryType="file"
        >
            {(renameAction) => (
                <>
                    <ActionMenu
                        label="File actions"
                        icon={<MoreHorizontal className="h-4 w-4" />}
                        hideLabel={true}
                    >
                        {(close) => (
                            <>
                                <ActionMenuButton
                                    disabled={renameAction.disabled}
                                    onClick={() => {
                                        close();
                                        renameAction.open();
                                    }}
                                >
                                    <Pencil className="h-4 w-4 text-slate-400" />
                                    Rename
                                </ActionMenuButton>
                                <ActionMenuButton
                                    tone="danger"
                                    disabled={parentPath === null}
                                    onClick={() => {
                                        close();
                                        deleteMutation.reset();
                                        setIsDeleteOpen(true);
                                    }}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Delete file
                                </ActionMenuButton>
                            </>
                        )}
                    </ActionMenu>
                    {renameAction.dialog}
                    <ConfirmationDialog
                        isOpen={isDeleteOpen}
                        title="Delete this file?"
                        description={
                            <>
                                This permanently deletes
                                <span className="mx-1 font-medium text-slate-100">
                                    {props.fileName}
                                </span>
                                from the agent filesystem.
                            </>
                        }
                        confirmLabel="Delete file"
                        busyLabel="Deleting..."
                        isBusy={deleteMutation.isPending}
                        errorMessage={
                            deleteMutation.isError
                                ? getErrorMessage(
                                      deleteMutation.error,
                                      "Delete failed",
                                  )
                                : null
                        }
                        onClose={closeDeleteDialog}
                        onConfirm={() => deleteMutation.mutate()}
                    >
                        <p className="overflow-x-auto whitespace-nowrap rounded-md border border-slate-800 bg-[#0b0d12] px-3 py-2.5 font-mono text-sm text-slate-300">
                            {props.path}
                        </p>
                    </ConfirmationDialog>
                </>
            )}
        </RenamePathAction>
    );
}

/** Presents directory metadata while the query-selected details view replaces the file list. */
export function DirectoryDetailView(props: {
    path: string;
    directoryName: string;
    lsResult: LsDirectoryResponse;
}) {
    return (
        <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            <PathDetailHeader
                entryType="directory"
                name={props.directoryName}
                path={props.path}
            />

            <FilesystemMetadataSections
                metadata={props.lsResult}
                entryCount={props.lsResult.files.length}
                headingPrefix="directory"
            />
        </article>
    );
}

/** Presents file metadata and destructive actions with clear visual separation. */
export function FileDetailView(props: {
    agent: Agent;
    path: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
    initialOneTimeTokens: Array<string>;
}) {
    const [copiedCommand, setCopiedCommand] = React.useState<string | null>(
        null,
    );
    const [oneTimeTokens, setOneTimeTokens] = React.useState(
        props.initialOneTimeTokens,
    );
    const createShareableLinkMutation = useMutation({
        mutationFn: () => props.agent.createOneTimeToken(props.lsResult.path),
        onSuccess: (response) => {
            setOneTimeTokens((tokens) => [...tokens, response.one_time_token]);
        },
    });

    React.useEffect(() => {
        setOneTimeTokens(props.initialOneTimeTokens);
        createShareableLinkMutation.reset();
    }, [props.path, props.initialOneTimeTokens]);

    const copyToClipboard = async (text: string, commandType: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedCommand(commandType);
            setTimeout(() => setCopiedCommand(null), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    return (
        <div>
            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <PathDetailHeader
                    entryType="file"
                    name={props.fileName}
                    path={props.lsResult.path}
                    pathCopied={copiedCommand === "path"}
                    nameActions={
                        <a
                            href={props.downloadUrl}
                            download={props.fileName}
                            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition-colors hover:bg-blue-500"
                        >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            Download
                        </a>
                    }
                    cornerActions={
                        <FileDetailMenu
                            agent={props.agent}
                            path={props.path}
                            fileName={props.fileName}
                        />
                    }
                    onCopyPath={() =>
                        copyToClipboard(props.lsResult.path, "path")
                    }
                />

                <FilesystemMetadataSections
                    metadata={props.lsResult}
                    size={props.lsResult.size}
                    headingPrefix="file"
                />

                <ShareableLinksSection
                    downloadUrl={props.downloadUrl}
                    oneTimeTokens={oneTimeTokens}
                    isCreating={createShareableLinkMutation.isPending}
                    errorMessage={
                        createShareableLinkMutation.isError
                            ? getErrorMessage(
                                  createShareableLinkMutation.error,
                                  "Could not create a shareable link",
                              )
                            : null
                    }
                    copiedCommand={copiedCommand}
                    onCreate={() => createShareableLinkMutation.mutate()}
                    onCopy={copyToClipboard}
                />
            </article>
        </div>
    );
}

/** Displays one-time download links and preserves their associated copy affordances. */
function ShareableLinksSection(props: {
    downloadUrl: string;
    oneTimeTokens: Array<string>;
    isCreating: boolean;
    errorMessage: string | null;
    copiedCommand: string | null;
    onCreate: () => void;
    onCopy: (text: string, commandType: string) => void;
}) {
    return (
        <section
            aria-labelledby="shareable-links-heading"
            className="border-t border-slate-800 bg-slate-950/15 p-6 md:p-8"
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2
                        id="shareable-links-heading"
                        className="text-base font-semibold text-slate-100"
                    >
                        Shareable links
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Create an anonymous link for a single download.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={props.onCreate}
                    disabled={props.isCreating}
                    className="inline-flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-300 transition hover:border-blue-500/50 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <Download className="h-4 w-4" />
                    {props.isCreating
                        ? "Creating link..."
                        : "Create shareable link"}
                </button>
            </div>

            {props.errorMessage ? (
                <p
                    role="alert"
                    className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
                >
                    {props.errorMessage}
                </p>
            ) : null}

            {props.oneTimeTokens.length > 0 ? (
                <div className="mt-5 grid gap-4">
                    {props.oneTimeTokens.map((token, index) => (
                        <ShareableLinkCard
                            key={token}
                            token={token}
                            linkNumber={index + 1}
                            downloadUrl={props.downloadUrl}
                            copiedCommand={props.copiedCommand}
                            onCopy={props.onCopy}
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

/** Keeps link-specific commands and feedback together for each generated token. */
function ShareableLinkCard(props: {
    token: string;
    linkNumber: number;
    downloadUrl: string;
    copiedCommand: string | null;
    onCopy: (text: string, commandType: string) => void;
}) {
    const shareableUrl = `${props.downloadUrl}?one_time_token=${encodeURIComponent(props.token)}`;
    const wgetCommand = `wget --content-disposition "${shareableUrl}"`;
    const curlCommand = `curl -JO "${shareableUrl}"`;
    const copyKeyPrefix = `one-time-${props.token}`;

    return (
        <article
            aria-label={`One-time shareable link ${props.linkNumber}`}
            className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/30 p-4"
        >
            <p className="text-sm font-semibold text-slate-200">
                One-time shareable link {props.linkNumber}
            </p>
            <p className="mt-1 text-sm text-amber-300/90">
                This link works only once. The first download consumes it, and
                later requests will be rejected.
            </p>
            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <a
                    href={shareableUrl}
                    className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-blue-300 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-200"
                >
                    {shareableUrl}
                </a>
                <button
                    type="button"
                    onClick={() =>
                        props.onCopy(shareableUrl, `${copyKeyPrefix}-link`)
                    }
                    aria-label={`Copy shareable link ${props.linkNumber}`}
                    className="shrink-0 rounded-md p-2 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                >
                    {props.copiedCommand === `${copyKeyPrefix}-link` ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                </button>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
                <CopyableCodeRow
                    label="wget"
                    value={wgetCommand}
                    copyAriaLabel={`Copy wget command for shareable link ${props.linkNumber}`}
                />
                <CopyableCodeRow
                    label="curl"
                    value={curlCommand}
                    copyAriaLabel={`Copy curl command for shareable link ${props.linkNumber}`}
                />
            </div>
        </article>
    );
}
