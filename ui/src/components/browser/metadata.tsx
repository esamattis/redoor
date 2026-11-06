import React from "react";
import {
    useMutation,
    useQuery,
    useQueryClient,
    useSuspenseQuery,
} from "@tanstack/react-query";
import { Check, Copy, Download, File, Folder } from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { LsDirectoryResponse } from "#bindings/LsDirectoryResponse";
import type { LsFileResponse } from "#bindings/LsFileResponse";
import type { AgentAccountGroup } from "#bindings/AgentAccountGroup";
import type { AgentAccountUser } from "#bindings/AgentAccountUser";
import type { ChownPathRequest } from "#bindings/ChownPathRequest";
import { Button } from "#ui/components/button";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { Checkbox } from "#ui/components/checkbox";
import { IconButton } from "#ui/components/icon-button";
import {
    CopyableCodeRow,
    useCopyFeedback,
} from "#ui/components/copyable-code-row";
import { ViewCardHeader } from "#ui/components/view-card-header";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import { RunInTerminalButton } from "#ui/components/browser/run-in-terminal-button";
import { getErrorMessage } from "#ui/utils/error";
import { getDirectoryArchiveName } from "#ui/utils/archive";
import { formatSize } from "#ui/utils/path";
import { Select } from "#ui/components/select";
import { Tooltip } from "#ui/components/tooltip";
import { Toast } from "#ui/components/toast";
import type { LsResponse } from "#ui/ls-response";
import {
    agentAccountsQueryOptions,
    browserListingQueryOptions,
    invalidateAgentData,
    metadataQueryOptions,
    queryKeys,
} from "#ui/queries";

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
export function MetadataItem(props: {
    label: string;
    value: React.ReactNode;
    valueLabel?: string;
    mono?: boolean;
    truncate?: boolean;
}) {
    return (
        <div className="rounded-xl border border-slate-800/80 bg-slate-950/35 px-4 py-3.5">
            <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                {props.label}
            </dt>
            <dd
                aria-label={props.valueLabel}
                className={`mt-1.5 text-sm font-semibold text-slate-100 ${props.truncate === false ? "" : "truncate"} ${props.mono ? "font-mono" : ""}`}
            >
                {props.value}
            </dd>
        </div>
    );
}

/** Makes raw permission bits understandable without requiring users to decode octal values. */
function PermissionsGrid(props: {
    permissions: number;
    interactive: boolean;
    disabled?: boolean;
    onToggleBit?: (bit: number, enabled: boolean) => void;
}) {
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

                                if (props.interactive) {
                                    const label = `${row.label} ${column}`;

                                    return (
                                        <td
                                            key={bit}
                                            className="px-2 py-2 text-center"
                                        >
                                            <Tooltip
                                                content={
                                                    isAllowed
                                                        ? `Remove ${label.toLowerCase()} on this path only.`
                                                        : `Allow ${label.toLowerCase()} on this path only.`
                                                }
                                            >
                                                <Checkbox
                                                    role="checkbox"
                                                    label={label}
                                                    title={false}
                                                    checked={isAllowed}
                                                    disabled={props.disabled}
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        props.onToggleBit?.(
                                                            bit,
                                                            checked,
                                                        )
                                                    }
                                                    className="justify-center"
                                                />
                                            </Tooltip>
                                        </td>
                                    );
                                }

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

/** Includes the current owner even when NSS omitted a deleted or truncated account. */
function ownerSelectOptions(
    metadata: FilesystemMetadata,
    users: AgentAccountUser[],
): AgentAccountUser[] {
    return withCurrentAccount({
        accounts: users,
        currentName: metadata.owner,
        fallback: {
            name: metadata.owner ?? String(metadata.uid),
            uid: metadata.uid,
        },
    });
}

/** Includes the current group even when NSS omitted a deleted or truncated account. */
function groupSelectOptions(
    metadata: FilesystemMetadata,
    groups: AgentAccountGroup[],
): AgentAccountGroup[] {
    return withCurrentAccount({
        accounts: groups,
        currentName: metadata.group,
        fallback: {
            name: metadata.group ?? String(metadata.gid),
            gid: metadata.gid,
        },
    });
}

/** Keeps a deleted or truncated account selectable so the current owner/group is never missing. */
function withCurrentAccount<T extends { name: string }>(props: {
    accounts: T[];
    currentName: string | null;
    fallback: T;
}): T[] {
    const currentName = props.currentName ?? props.fallback.name;

    if (props.accounts.some((account) => account.name === currentName)) {
        return props.accounts;
    }

    return [props.fallback, ...props.accounts];
}

/** Describes the ownership and access fields shared by files and directories. */
type FilesystemMetadata = {
    owner: string | null;
    group: string | null;
    uid: number;
    gid: number;
    permissions: number;
};

/** Keeps the symbolic, octal, and 3×3 grid views on one shared 9-bit mask. */
export function PermissionsSection(props: {
    headingId: string;
    permissions: number;
    interactive: boolean;
    disabled?: boolean;
    onToggleBit: (bit: number, enabled: boolean) => void;
}) {
    const symbolicPermissions = formatSymbolicPermissions(props.permissions);
    const octalPermissions = `0${props.permissions.toString(8).padStart(3, "0")}`;

    return (
        <section aria-labelledby={props.headingId}>
            <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                    <h2
                        id={props.headingId}
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
                    <p className="text-xs text-slate-500">{octalPermissions}</p>
                </div>
            </div>
            <PermissionsGrid
                permissions={props.permissions}
                interactive={props.interactive}
                disabled={props.disabled}
                onToggleBit={props.onToggleBit}
            />
        </section>
    );
}

/** Renders a root-only owner or group select without implying recursive chown. */
function OwnershipSelect(props: {
    label: "Owner" | "Group";
    value: string;
    options: Array<{ name: string }>;
    disabled?: boolean;
    onChange: (name: string) => void;
}) {
    return (
        <Tooltip
            content={`Changes ${props.label.toLowerCase()} of this path only, not recursively.`}
        >
            <Select
                aria-label={props.label}
                value={props.value}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.value)}
            >
                {props.options.map((account) => (
                    <option key={account.name} value={account.name}>
                        {account.name}
                    </option>
                ))}
            </Select>
        </Tooltip>
    );
}

/** Shows ownership and mode from the cached listing, which the mutations below edit optimistically. */
function useDetailsOwnershipState(props: { agent: Agent; path: string }) {
    const queryClient = useQueryClient();
    const listingKey = queryKeys.browserListing(props.agent.id, props.path);

    const [feedback, setFeedback] = React.useState<{
        tone: "success" | "error";
        message: string;
    } | null>(null);

    // Ownership lives in the same listing the browser shows, so edits made here and
    // refreshes from anywhere else land in one place instead of a component-local copy.
    const { data: displayed } = useSuspenseQuery({
        ...browserListingQueryOptions(props.agent, props.path),
        select: (listing): FilesystemMetadata => ({
            owner: listing.owner,
            group: listing.group,
            uid: listing.uid,
            gid: listing.gid,
            permissions: listing.permissions,
        }),
    });

    const accountsQuery = useQuery({
        ...agentAccountsQueryOptions(props.agent),
        enabled: props.agent.isRoot,
    });

    /** Edits only the metadata fields so a concurrent listing refresh keeps its entries. */
    const patchListing = (patch: Partial<FilesystemMetadata>) => {
        queryClient.setQueryData<LsResponse>(listingKey, (listing) =>
            listing ? { ...listing, ...patch } : listing,
        );
    };

    /** Applies an edit before the server answers and returns what to restore on failure. */
    const applyOptimistically = async (patch: Partial<FilesystemMetadata>) => {
        // A refetch landing mid-request would flash the old value back over the edit.
        await queryClient.cancelQueries({ queryKey: listingKey });

        const previous: FilesystemMetadata = displayed;
        patchListing(patch);

        return { previous };
    };

    const chownMutation = useMutation({
        mutationFn: (request: Partial<ChownPathRequest>) =>
            props.agent.chown(props.path, request),
        onMutate: (request) =>
            applyOptimistically({
                owner: request.owner ?? displayed.owner,
                group: request.group ?? displayed.group,
            }),
        onSuccess: (response) => {
            patchListing({
                owner: response.owner,
                group: response.group,
                uid: response.uid,
                gid: response.gid,
            });
            setFeedback({
                tone: "success",
                message: "Ownership updated",
            });
        },
        onError: (error, _request, context) => {
            if (context) {
                patchListing({
                    owner: context.previous.owner,
                    group: context.previous.group,
                });
            }

            setFeedback({
                tone: "error",
                message: getErrorMessage(error, "Could not change ownership"),
            });
        },
        // Parent listings and metadata elsewhere show the same fields.
        onSettled: () => invalidateAgentData(queryClient, props.agent.id),
    });

    const chmodMutation = useMutation({
        mutationFn: (permissions: number) =>
            props.agent.chmod(props.path, permissions),
        onMutate: (permissions) => applyOptimistically({ permissions }),
        onSuccess: (response) => {
            patchListing({ permissions: response.permissions });
            setFeedback({
                tone: "success",
                message: "Permissions updated",
            });
        },
        onError: (error, _permissions, context) => {
            if (context) {
                patchListing({ permissions: context.previous.permissions });
            }

            setFeedback({
                tone: "error",
                message: getErrorMessage(error, "Could not change permissions"),
            });
        },
        onSettled: () => invalidateAgentData(queryClient, props.agent.id),
    });

    return {
        displayed,
        canChmod: props.agent.isRoot || props.agent.uid === displayed.uid,
        showOwnerSelect: props.agent.isRoot && accountsQuery.data !== undefined,
        ownerOptions: ownerSelectOptions(
            displayed,
            accountsQuery.data?.users ?? [],
        ),
        groupOptions: groupSelectOptions(
            displayed,
            accountsQuery.data?.groups ?? [],
        ),
        chownPending: chownMutation.isPending,
        chmodPending: chmodMutation.isPending,
        feedback,
        dismissFeedback: () => setFeedback(null),
        accountsError: accountsQuery.isError
            ? getErrorMessage(
                  accountsQuery.error,
                  "Could not load users and groups",
              )
            : null,
        retryAccounts: () => {
            void accountsQuery.refetch();
        },
        togglePermissionBit: (bit: number, enabled: boolean) => {
            if (chmodMutation.isPending) {
                return;
            }

            chmodMutation.mutate(
                enabled
                    ? displayed.permissions | bit
                    : displayed.permissions & ~bit,
            );
        },
        changeOwner: (owner: string) => {
            if (chownMutation.isPending) {
                return;
            }

            chownMutation.mutate({ owner });
        },
        changeGroup: (group: string) => {
            if (chownMutation.isPending) {
                return;
            }

            chownMutation.mutate({ group });
        },
    };
}

/** Presents shared filesystem identity and Unix access metadata consistently. */
function FilesystemMetadataSections(props: {
    agent: Agent;
    path: string;
    size?: number;
    sizeLabel?: string;
    sizeAction?: React.ReactNode;
    entryCount?: number;
    headingPrefix: string;
}) {
    const ownership = useDetailsOwnershipState({
        agent: props.agent,
        path: props.path,
    });

    const headingIdPrefix = props.headingPrefix.toLowerCase();

    return (
        <MetadataSectionsLayout
            headingPrefix={props.headingPrefix}
            description="Filesystem identity and storage information."
            items={
                <>
                    <SizeAndEntryItems
                        size={props.size}
                        sizeLabel={props.sizeLabel}
                        sizeAction={props.sizeAction}
                        entryCount={props.entryCount}
                    />
                    <MetadataItem
                        label="Owner"
                        truncate={ownership.showOwnerSelect ? false : undefined}
                        value={
                            ownership.showOwnerSelect ? (
                                <OwnershipSelect
                                    label="Owner"
                                    value={
                                        ownership.displayed.owner ??
                                        String(ownership.displayed.uid)
                                    }
                                    options={ownership.ownerOptions}
                                    disabled={ownership.chownPending}
                                    onChange={ownership.changeOwner}
                                />
                            ) : (
                                ownership.displayed.owner || "Unknown"
                            )
                        }
                    />
                    <MetadataItem
                        label="Group"
                        truncate={ownership.showOwnerSelect ? false : undefined}
                        value={
                            ownership.showOwnerSelect ? (
                                <OwnershipSelect
                                    label="Group"
                                    value={
                                        ownership.displayed.group ??
                                        String(ownership.displayed.gid)
                                    }
                                    options={ownership.groupOptions}
                                    disabled={ownership.chownPending}
                                    onChange={ownership.changeGroup}
                                />
                            ) : (
                                ownership.displayed.group || "Unknown"
                            )
                        }
                    />
                    <MetadataItem
                        label="UID"
                        value={ownership.displayed.uid}
                        mono
                    />
                    <MetadataItem
                        label="GID"
                        value={ownership.displayed.gid}
                        mono
                    />
                </>
            }
            permissions={
                <PermissionsSection
                    headingId={`${headingIdPrefix}-permissions-heading`}
                    permissions={ownership.displayed.permissions}
                    interactive={ownership.canChmod}
                    disabled={ownership.chmodPending}
                    onToggleBit={ownership.togglePermissionBit}
                />
            }
        >
            {ownership.feedback ? (
                <Toast
                    tone={ownership.feedback.tone}
                    onDismiss={ownership.dismissFeedback}
                >
                    {ownership.feedback.message}
                </Toast>
            ) : null}
            {ownership.accountsError ? (
                <Toast tone="error" onDismiss={ownership.retryAccounts}>
                    {ownership.accountsError}
                </Toast>
            ) : null}
        </MetadataSectionsLayout>
    );
}

/**
 * Lays out the metadata grid beside the permissions, so worktree paths and Git revisions
 * present their facts identically while each supplies its own values.
 */
export function MetadataSectionsLayout(props: {
    headingPrefix: string;
    description: string;
    items: React.ReactNode;
    permissions: React.ReactNode;
    /** Feedback that belongs to the sections, such as toasts. */
    children?: React.ReactNode;
}) {
    const headingIdPrefix = props.headingPrefix.toLowerCase();

    return (
        <div className="grid gap-4 p-4 @xl:p-5 @4xl:grid-cols-[minmax(0,1fr)_minmax(21rem,0.72fr)]">
            <section aria-labelledby={`${headingIdPrefix}-metadata-heading`}>
                <div className="mb-4">
                    <h2
                        id={`${headingIdPrefix}-metadata-heading`}
                        className="text-base font-semibold text-slate-100"
                    >
                        Metadata
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        {props.description}
                    </p>
                </div>
                <dl className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                    {props.items}
                </dl>
            </section>
            {props.permissions}
            {props.children}
        </div>
    );
}

/** The size and entry-count cells every details view starts its metadata grid with. */
export function SizeAndEntryItems(props: {
    size?: number;
    sizeLabel?: string;
    sizeAction?: React.ReactNode;
    entryCount?: number;
}) {
    return (
        <>
            {props.size === undefined &&
            props.sizeAction === undefined ? null : (
                <MetadataItem
                    label="Size"
                    value={
                        props.size === undefined
                            ? props.sizeAction
                            : formatSize(props.size)
                    }
                    valueLabel={props.sizeLabel ?? "File size value"}
                />
            )}
            {props.entryCount === undefined ? null : (
                <MetadataItem
                    label="Entries"
                    value={props.entryCount}
                    valueLabel="Directory entry count"
                />
            )}
        </>
    );
}

/** Copies the full path and confirms it, reusing the shared clipboard feedback. */
function CopyFullPathButton(props: { path: string }) {
    const { isCopied, copy } = useCopyFeedback(props.path);

    return (
        <Button
            type="button"
            variant="subtle"
            onClick={() => {
                void copy();
            }}
            className="inline-flex items-center gap-1.5 p-0 text-xs font-medium text-slate-500 transition hover:text-slate-200"
            aria-label="Copy full path"
        >
            {isCopied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
                <Copy className="h-3.5 w-3.5" />
            )}
            {isCopied ? "Copied" : "Copy"}
        </Button>
    );
}

/** Presents file and directory identity consistently while allowing file-only path copying. */
export function PathDetailHeader(props: {
    entryType: "file" | "directory";
    name: string;
    path: string;
    canCopyPath?: boolean;
    nameActions?: React.ReactNode;
}) {
    const isDirectory = props.entryType === "directory";
    const typeLabel = isDirectory ? "Directory" : "File";

    return (
        <ViewCardHeader
            icon={
                isDirectory ? (
                    <Folder className="h-5 w-5" />
                ) : (
                    <File className="h-5 w-5" />
                )
            }
            eyebrow={`${typeLabel} details`}
            title={props.name}
            titleAriaLabel={`${typeLabel} name`}
            actions={props.nameActions}
        >
            <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                        Full Path
                    </p>
                    {props.canCopyPath ? (
                        <CopyFullPathButton path={props.path} />
                    ) : null}
                </div>
                <code className="block overflow-x-auto whitespace-nowrap rounded-md border border-slate-800/80 bg-slate-950/60 px-2 py-1.5 font-mono text-sm text-slate-300">
                    {props.path}
                </code>
            </div>
        </ViewCardHeader>
    );
}

/**
 * Presents directory metadata while the query-selected details view replaces the file list.
 * The route keys it by path, so each directory starts without the previous one's size result.
 */
export function DirectoryDetailView(props: {
    agent: Agent;
    path: string;
    directoryName: string;
    lsResult: LsDirectoryResponse;
}) {
    const [sizeWarningDismissed, setSizeWarningDismissed] =
        React.useState(false);

    const directorySizeMutation = useMutation({
        mutationFn: () =>
            props.agent.calculateDirectorySize(props.lsResult.path),
        onSuccess: () => setSizeWarningDismissed(false),
    });

    const skippedEntryCount = directorySizeMutation.data?.errors.length ?? 0;

    return (
        <BrowserViewCard>
            <PathDetailHeader
                entryType="directory"
                name={props.directoryName}
                path={props.path}
                nameActions={
                    <PersistentPathActions
                        agent={props.agent}
                        path={props.path}
                        currentName={props.directoryName}
                        entryType="directory"
                        view="details"
                        downloadUrl={props.agent.getRawUrl(props.path, {
                            download: true,
                        })}
                        downloadName={getDirectoryArchiveName(
                            props.directoryName,
                        )}
                        downloadTooltip="Downloads this directory as a .tar.gz archive."
                    />
                }
            />

            <FilesystemMetadataSections
                key={props.lsResult.path}
                agent={props.agent}
                path={props.lsResult.path}
                size={directorySizeMutation.data?.size}
                sizeLabel="Directory size value"
                sizeAction={
                    <Button
                        tooltip="Recursively totals the contents of regular files in this directory."
                        type="button"
                        variant="subtle"
                        isLoading={directorySizeMutation.isPending}
                        onClick={() => directorySizeMutation.mutate()}
                    >
                        {directorySizeMutation.isPending
                            ? "Calculating..."
                            : "Calculate size"}
                    </Button>
                }
                entryCount={props.lsResult.files.length}
                headingPrefix="directory"
            />
            {directorySizeMutation.isError ? (
                <Toast
                    tone="error"
                    onDismiss={() => directorySizeMutation.reset()}
                >
                    {getErrorMessage(
                        directorySizeMutation.error,
                        "Could not calculate directory size",
                    )}
                </Toast>
            ) : null}
            {skippedEntryCount > 0 && !sizeWarningDismissed ? (
                <Toast
                    tone="error"
                    onDismiss={() => setSizeWarningDismissed(true)}
                >
                    Could not read the size of {skippedEntryCount}{" "}
                    {skippedEntryCount === 1 ? "entry" : "entries"}.
                </Toast>
            ) : null}
        </BrowserViewCard>
    );
}

/**
 * Presents file metadata and destructive actions with clear visual separation. The route keys
 * it by path, so each file starts without the previous one's link-creation error.
 */
export function FileDetailView(props: {
    agent: Agent;
    path: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
    /**
     * Offers running the file. Files the editor opens get it from the editor toolbar instead,
     * which knows about unsaved edits that running the device copy here would ignore.
     */
    canRun: boolean;
}) {
    const queryClient = useQueryClient();

    const metadataOptions = metadataQueryOptions(
        props.agent,
        props.lsResult.path,
    );

    // The server owns the token list, so refreshes and new links share one cache entry.
    const { data: oneTimeTokens } = useSuspenseQuery({
        ...metadataOptions,
        select: (metadata) => metadata.one_time_tokens,
    });

    const createShareableLinkMutation = useMutation({
        mutationFn: () => props.agent.createOneTimeToken(props.lsResult.path),
        onSuccess: (response) => {
            queryClient.setQueryData(metadataOptions.queryKey, (metadata) =>
                metadata
                    ? {
                          ...metadata,
                          one_time_tokens: [
                              ...metadata.one_time_tokens,
                              response.one_time_token,
                          ],
                      }
                    : metadata,
            );
        },
    });

    return (
        <BrowserViewCard>
            <PathDetailHeader
                entryType="file"
                name={props.fileName}
                path={props.lsResult.path}
                canCopyPath
                nameActions={
                    <PersistentPathActions
                        agent={props.agent}
                        path={props.path}
                        currentName={props.fileName}
                        entryType="file"
                        view="details"
                        downloadUrl={props.downloadUrl}
                        downloadName={props.fileName}
                        afterDownload={
                            props.canRun ? (
                                <RunInTerminalButton
                                    agent={props.agent}
                                    filePath={props.lsResult.path}
                                    className="rounded-md"
                                />
                            ) : null
                        }
                    />
                }
            />

            <FilesystemMetadataSections
                key={props.lsResult.path}
                agent={props.agent}
                path={props.lsResult.path}
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
                onCreate={() => createShareableLinkMutation.mutate()}
            />
        </BrowserViewCard>
    );
}

/** Displays one-time download links and preserves their associated copy affordances. */
export function ShareableLinksSection(props: {
    downloadUrl: string;
    oneTimeTokens: Array<string>;
    isCreating: boolean;
    errorMessage: string | null;
    onCreate: () => void;
    /** Links download the working file, so a Git revision cannot offer them. */
    disabled?: boolean;
}) {
    return (
        <section
            aria-labelledby="shareable-links-heading"
            className="border-t border-slate-800 bg-slate-950/15 p-4 @xl:p-5"
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
                <Button
                    type="button"
                    onClick={props.onCreate}
                    variant="secondary"
                    size="lg"
                    disabled={props.disabled}
                    isLoading={props.isCreating}
                    className="rounded-lg border-blue-500/30 bg-blue-500/10 text-sm font-semibold text-blue-300 hover:border-blue-500/50 hover:bg-blue-500/20 disabled:opacity-60"
                >
                    <Download className="h-4 w-4" />
                    {props.isCreating
                        ? "Creating link..."
                        : "Create shareable link"}
                </Button>
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
}) {
    const shareableUrl = `${props.downloadUrl}?one_time_token=${encodeURIComponent(props.token)}`;
    const wgetCommand = `wget --content-disposition "${shareableUrl}"`;
    const curlCommand = `curl -JO "${shareableUrl}"`;
    const { isCopied, copy } = useCopyFeedback(shareableUrl);

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
                <IconButton
                    type="button"
                    tooltipClassName="shrink-0"
                    onClick={() => {
                        void copy();
                    }}
                    label={`Copy shareable link ${props.linkNumber}`}
                    variant="ghost"
                    size="md"
                    className="shrink-0"
                >
                    {isCopied ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                </IconButton>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 @4xl:grid-cols-2">
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
