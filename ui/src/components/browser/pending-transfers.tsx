import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { FileClock } from "lucide-react";
import type { LsEntry } from "#bindings/LsEntry";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import { Tooltip } from "#ui/components/tooltip";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { queryKeys, transfersQueryOptions } from "#ui/queries";
import { formatSize, getBaseName } from "#ui/utils/path";
import { getAnimatedTransferProgress } from "#ui/utils/transfer-progress";
import { useTransferClock } from "#ui/utils/use-transfer-clock";

const rootRouteApi = getRouteApi("__root__");

/**
 * Delay before relisting a directory that just became a transfer destination. The transfer is
 * announced as soon as the server accepts it, but the agent creates the hidden staging entry
 * only a moment later, so an immediate relist would miss it.
 */
const PENDING_TRANSFER_LISTING_REFRESH_MS = 1000;

/** A transfer still writing into the viewed directory, rendered as a placeholder row. */
export type PendingTransfer = {
    name: string;
    transfer: TransferProgressEntry;
};

/**
 * Only directions whose `path` names a new destination entry produce a pending row. Downloads
 * point at their source and edits rewrite a file that is already listed.
 */
function writesNewDestinationEntry(transfer: TransferProgressEntry): boolean {
    return (
        transfer.direction === "upload" ||
        transfer.direction === "copy" ||
        transfer.direction === "move"
    );
}

/** Canceling transfers still hold staging output, so they stay visible until they settle. */
function isTransferPending(transfer: TransferProgressEntry): boolean {
    return transfer.state === "active" || transfer.state === "canceling";
}

/**
 * Picks the transfers writing directly into one directory from the shared transfer cache, so
 * the listing shows incoming entries before they are published under their final names.
 */
function getPendingTransfers(
    transfers: TransferProgressEntry[],
    agentId: string,
    directoryPath: string,
): PendingTransfer[] {
    // Matches the trailing-slash-free form `getImmediateParentPath` returns.
    const normalizedDirectory = directoryPath.replace(/\/+$/, "") || "/";

    return transfers.flatMap((transfer) =>
        transfer.agent_id === agentId &&
        writesNewDestinationEntry(transfer) &&
        isTransferPending(transfer) &&
        getImmediateParentPath(transfer.path) === normalizedDirectory
            ? [{ name: getBaseName(transfer.path), transfer }]
            : [],
    );
}

/**
 * Relists the directory shortly after a transfer into it is first seen, so the hidden staging
 * entry the agent creates for it shows up without a manual refresh. One timer covers a burst of
 * new transfers, and it is not restarted by later progress snapshots.
 */
function useRefreshListingForNewTransfers(
    agentId: string,
    directoryPath: string,
    pendingTransfers: PendingTransfer[],
) {
    const queryClient = useQueryClient();
    const seenTransferIdsRef = React.useRef(new Set<number>());
    const refreshTimerRef = React.useRef<number | null>(null);

    // Progress snapshots replace the array on every poll; only the set of ids matters here.
    const transferIdsKey = pendingTransfers
        .map((pending) => pending.transfer.request_id)
        .join(",");

    React.useEffect(() => {
        return () => {
            if (refreshTimerRef.current !== null) {
                window.clearTimeout(refreshTimerRef.current);
            }
        };
    }, []);

    React.useEffect(() => {
        const transferIds =
            transferIdsKey === "" ? [] : transferIdsKey.split(",").map(Number);

        const newTransferIds = transferIds.filter(
            (id) => !seenTransferIdsRef.current.has(id),
        );

        for (const id of newTransferIds) {
            seenTransferIdsRef.current.add(id);
        }

        if (newTransferIds.length === 0 || refreshTimerRef.current !== null) {
            return;
        }

        refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null;
            void queryClient.invalidateQueries({
                queryKey: queryKeys.browserListing(agentId, directoryPath),
                exact: true,
            });
        }, PENDING_TRANSFER_LISTING_REFRESH_MS);
    }, [agentId, directoryPath, queryClient, transferIdsKey]);
}

/**
 * Follows the transfers writing into the viewed directory and keeps its listing fresh enough to
 * show their staging entries.
 */
export function usePendingTransfers(
    agentId: string,
    directoryPath: string,
): PendingTransfer[] {
    const { api } = rootRouteApi.useRouteContext();
    const { data } = useQuery(transfersQueryOptions(api));

    const pendingTransfers = getPendingTransfers(
        data?.transfers ?? [],
        agentId,
        directoryPath,
    );

    useRefreshListingForNewTransfers(agentId, directoryPath, pendingTransfers);

    return pendingTransfers;
}

/**
 * Lets pending rows share filtering and sorting with real entries. The size is the confirmed
 * byte count and the modification time is the transfer start, the closest real values known.
 */
export function getPendingTransferSortEntry(pending: PendingTransfer): LsEntry {
    return {
        name: pending.name,
        type: "file",
        size: pending.transfer.transferred_bytes,
        owner: null,
        group: null,
        uid: 0,
        gid: 0,
        modified_at: pending.transfer.started_at,
    };
}

/** Keeps the size projection moving only while the server reports the transfer as running. */
function isPendingTransferActive(transfer: TransferProgressEntry): boolean {
    return transfer.state === "active";
}

/**
 * Grows the incoming size between progress snapshots with the same projection as the transfers
 * view. Kept as its own leaf because the clock rerenders it on every animation frame.
 */
function PendingTransferSize(props: { transfer: TransferProgressEntry }) {
    const animationFrame = useTransferClock(
        props.transfer,
        isPendingTransferActive,
    );

    const progress = getAnimatedTransferProgress(
        props.transfer,
        animationFrame.elapsedSeconds,
        animationFrame.refreshedAtMilliseconds,
    );

    const displayedBytes = formatSize(Math.floor(progress.transferredBytes));

    return props.transfer.total_bytes > 0 ? (
        <span className="whitespace-nowrap tabular-nums">
            {displayedBytes}
            <span className="text-slate-600">
                {" "}
                / {formatSize(props.transfer.total_bytes)}
            </span>
        </span>
    ) : (
        <span className="whitespace-nowrap tabular-nums">{displayedBytes}</span>
    );
}

/**
 * Shows an incoming transfer among the directory entries. It has no selection or actions,
 * because nothing exists under its final name until the transfer publishes it.
 */
export function PendingFileEntry(props: {
    pending: PendingTransfer;
    /** Adds the Git column's empty cell, since an incoming file has no Git state yet. */
    showGitStatus: boolean;
}) {
    const name = props.pending.name;
    const canceling = props.pending.transfer.state === "canceling";

    return (
        <tr
            className="border-b border-slate-800/60 text-slate-500 last:border-b-0"
            aria-label={`Pending file entry ${name}`}
        >
            <td className="p-1.5 @xl:p-2" />
            <td className="p-1.5 @xl:p-2">
                <Tooltip
                    content={
                        canceling
                            ? "Transfer is being canceled"
                            : "Transfer in progress"
                    }
                >
                    <FileClock
                        className="h-5 w-5 text-amber-400/80"
                        role="img"
                        aria-label="Pending file"
                    />
                </Tooltip>
            </td>
            {props.showGitStatus ? <td className="p-1.5 @xl:p-2" /> : null}
            <td className="p-1.5 @xl:p-2">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium italic text-slate-400">
                        {name}
                    </span>
                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300">
                        {canceling ? "canceling" : "pending"}
                    </span>
                </span>
            </td>
            <td
                className="p-1.5 text-slate-400 @xl:p-2"
                aria-label={`Size for ${name}`}
            >
                <PendingTransferSize transfer={props.pending.transfer} />
            </td>
            <td className="p-1.5 @xl:p-2">-</td>
            <td className="p-1.5 @xl:p-2">-</td>
            <td className="p-1.5 @xl:p-2">-</td>
            <td className="p-1.5 @xl:p-2" />
        </tr>
    );
}
