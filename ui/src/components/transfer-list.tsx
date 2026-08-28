import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Copy,
    AlertCircle,
    MoveRight,
    CircleX,
    FilePenLine,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type TransferProgressEntry } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
import { IconButton } from "#ui/components/icon-button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Toast } from "#ui/components/toast";
import { queryKeys } from "#ui/queries";
import { formatSize, formatSpeed } from "#ui/utils/path";
import {
    formatRemainingTime,
    getAnimatedTransferProgress,
    getLastEstimatedTransferProgress,
    getTransferSpeedBytesPerSecond,
} from "#ui/utils/transfer-progress";

type TransferAnimationFrame = {
    transfer: TransferProgressEntry;
    refreshedAtMilliseconds: number;
    elapsedSeconds: number;
};

/** Restarts projection from each API snapshot and advances it at animation-frame cadence. */
function useTransferAnimation(
    transfer: TransferProgressEntry,
): TransferAnimationFrame {
    const [animationFrame, setAnimationFrame] = React.useState(() => ({
        transfer,
        refreshedAtMilliseconds: Date.now(),
        elapsedSeconds: 0,
    }));

    React.useEffect(() => {
        const refreshedAtMilliseconds = Date.now();
        let frameRequest: number;

        const updateAnimation = () => {
            setAnimationFrame({
                transfer,
                refreshedAtMilliseconds,
                elapsedSeconds: (Date.now() - refreshedAtMilliseconds) / 1000,
            });

            if (transfer.state === "active") {
                frameRequest = window.requestAnimationFrame(updateAnimation);
            }
        };

        frameRequest = window.requestAnimationFrame(updateAnimation);
        return () => window.cancelAnimationFrame(frameRequest);
    }, [transfer]);

    if (animationFrame.transfer !== transfer) {
        return {
            transfer,
            refreshedAtMilliseconds: Date.now(),
            elapsedSeconds: 0,
        };
    }

    return animationFrame;
}

/** Animates the header from the transfer whose ETA determines when all transfers finish. */
export function useLastEstimatedTransferPercentage(
    transfers: TransferProgressEntry[],
): number | null {
    const [animationFrame, setAnimationFrame] = React.useState(() => ({
        transfers,
        refreshedAtMilliseconds: Date.now(),
        elapsedSeconds: 0,
    }));

    React.useEffect(() => {
        const refreshedAtMilliseconds = Date.now();
        if (
            getLastEstimatedTransferProgress(
                transfers,
                0,
                refreshedAtMilliseconds,
            ) === null
        ) {
            return;
        }
        let frameRequest: number;

        const updateAnimation = () => {
            setAnimationFrame({
                transfers,
                refreshedAtMilliseconds,
                elapsedSeconds: (Date.now() - refreshedAtMilliseconds) / 1000,
            });
            frameRequest = window.requestAnimationFrame(updateAnimation);
        };

        frameRequest = window.requestAnimationFrame(updateAnimation);
        return () => window.cancelAnimationFrame(frameRequest);
    }, [transfers]);

    const currentFrame =
        animationFrame.transfers === transfers
            ? animationFrame
            : {
                  transfers,
                  refreshedAtMilliseconds: Date.now(),
                  elapsedSeconds: 0,
              };
    const progress = getLastEstimatedTransferProgress(
        transfers,
        currentFrame.elapsedSeconds,
        currentFrame.refreshedAtMilliseconds,
    );
    return progress === null ? null : Math.round(progress.percentage);
}

/** Shows projected bytes and a pie whose full state only comes from the API. */
function TransferProgressCell(props: { transfer: TransferProgressEntry }) {
    const animationFrame = useTransferAnimation(props.transfer);
    const progress = getAnimatedTransferProgress(
        props.transfer,
        animationFrame.elapsedSeconds,
        animationFrame.refreshedAtMilliseconds,
    );
    const speed = getTransferSpeedBytesPerSecond(
        props.transfer,
        animationFrame.refreshedAtMilliseconds,
    );
    const displayedBytes = Math.floor(progress.transferredBytes);
    const sizeUnknown = props.transfer.total_bytes <= 0;
    const measuringArchive =
        sizeUnknown && props.transfer.direction === "download";
    const pieDegrees = sizeUnknown ? 0 : progress.percentage * 3.6;
    const remainingTime = formatRemainingTime(progress.remainingSeconds);
    const percentageLabel = `${Math.round(progress.percentage)}%`;
    const speedLabel = props.transfer.atomic ? null : formatSpeed(speed);
    const remainingLabel =
        remainingTime === null ? null : `${remainingTime} remaining`;
    const progressLabel = [
        sizeUnknown ? null : percentageLabel,
        speedLabel,
        sizeUnknown ? null : remainingLabel,
    ]
        .filter((part) => part !== null)
        .join(" ");

    return (
        <div className="flex w-80 items-center gap-3">
            <span
                className="h-9 w-9 shrink-0 rounded-full border border-slate-600/70"
                style={{
                    background: `conic-gradient(${props.transfer.state === "completed" ? "#34d399" : "#60a5fa"} 0deg ${pieDegrees}deg, #334155 ${pieDegrees}deg 360deg)`,
                }}
                role="img"
                aria-label={`Transfer progress ${progressLabel}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-sm tabular-nums text-slate-300">
                <span className="inline-flex items-center gap-1">
                    {sizeUnknown ? (
                        <>
                            {formatSize(displayedBytes)}
                            {measuringArchive ? (
                                <Tooltip content="The archive size is being measured while the download already runs.">
                                    <span
                                        role="img"
                                        aria-label="Archive size is still being calculated"
                                    >
                                        (!)
                                    </span>
                                </Tooltip>
                            ) : null}
                        </>
                    ) : (
                        <>
                            {formatSize(displayedBytes)} /{" "}
                            {formatSize(props.transfer.total_bytes)}
                        </>
                    )}
                </span>
                <span className="text-xs text-slate-500">{progressLabel}</span>
            </div>
        </div>
    );
}

function TransferTableHeader() {
    return (
        <thead className="sticky top-0 bg-[#1a1f2a]">
            <tr className="border-b border-slate-800">
                <th className="text-left p-3 text-sm font-medium text-slate-400">
                    Agent
                </th>
                <th className="text-left p-3 text-sm font-medium text-slate-400">
                    Direction
                </th>
                <th className="text-left p-3 text-sm font-medium text-slate-400">
                    Path
                </th>
                <th className="w-80 text-left p-3 text-sm font-medium text-slate-400">
                    Progress
                </th>
                <th className="text-left p-3 text-sm font-medium text-slate-400">
                    Status
                </th>
                <th className="w-14 p-3 text-right text-sm font-medium text-slate-400">
                    Actions
                </th>
            </tr>
        </thead>
    );
}

/** Keeps terminal state and diagnostics consistent across transfer directions. */
function TransferStatusCell(props: { transfer: TransferProgressEntry }) {
    return (
        <td className="whitespace-nowrap p-3">
            <div className="flex flex-col gap-1">
                <span
                    className={`text-sm font-medium ${
                        props.transfer.state === "errored"
                            ? "text-red-400"
                            : props.transfer.state === "completed"
                              ? "text-emerald-400"
                              : "text-slate-100"
                    }`}
                >
                    {props.transfer.state}
                </span>
                {props.transfer.error ? (
                    <span className="inline-flex max-w-xs items-start gap-1 text-xs text-red-400">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="truncate" title={props.transfer.error}>
                            {props.transfer.error}
                        </span>
                    </span>
                ) : null}
            </div>
        </td>
    );
}

/** Exposes cancellation only while the server advertises a safe boundary. */
function TransferActionsCell(props: {
    transfer: TransferProgressEntry;
    disabled: boolean;
    onCancel: () => void;
}) {
    return (
        <td className="p-3 text-right">
            {props.transfer.cancelable && props.transfer.state === "active" ? (
                <IconButton
                    type="button"
                    label="Cancel transfer"
                    disabled={props.disabled}
                    onClick={props.onCancel}
                    className="rounded-md p-2 text-slate-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
                >
                    <CircleX className="h-4 w-4" />
                </IconButton>
            ) : null}
        </td>
    );
}

/** Gives both history and drawer contexts the same empty state. */
function EmptyTransferList() {
    return (
        <div className="p-6 text-center text-sm text-slate-500">
            No transfers
        </div>
    );
}

/** Keeps the modal copy independent from transfer-table rendering details. */
function TransferCancellationDialog(props: {
    isOpen: boolean;
    isBusy: boolean;
    errorMessage: string | null;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <ConfirmationDialog
            isOpen={props.isOpen}
            title="Cancel transfer?"
            description="Partial progress will be preserved, but unpublished temporary output will be removed. A transfer that has crossed its commit boundary may still complete."
            confirmLabel="Cancel transfer"
            busyLabel="Canceling transfer..."
            isBusy={props.isBusy}
            confirmDisabled={props.isBusy}
            errorMessage={props.errorMessage}
            onClose={props.onClose}
            onConfirm={props.onConfirm}
        />
    );
}

/** Surfaces accepted cancellation without making the workflow modal. */
function TransferCancellationToast(props: {
    message: string | null;
    onDismiss: () => void;
}) {
    return props.message === null ? null : (
        <Toast tone="success" onDismiss={props.onDismiss}>
            {props.message}
        </Toast>
    );
}

/** Gives every transfer semantic its own stable label and visual treatment. */
function TransferDirectionBadge(props: { transfer: TransferProgressEntry }) {
    const direction = props.transfer.direction;
    const color =
        direction === "upload"
            ? "bg-blue-500/15 text-blue-300"
            : direction === "edit"
              ? "bg-amber-500/15 text-amber-300"
              : "bg-emerald-500/15 text-emerald-300";
    const icon =
        direction === "upload" ? (
            <ArrowUpFromLine className="h-3.5 w-3.5" />
        ) : direction === "edit" ? (
            <FilePenLine className="h-3.5 w-3.5" />
        ) : direction === "download" ? (
            <ArrowDownToLine className="h-3.5 w-3.5" />
        ) : direction === "move" ? (
            <MoveRight className="h-3.5 w-3.5" />
        ) : (
            <Copy className="h-3.5 w-3.5" />
        );
    const label =
        direction === "upload"
            ? "Upload"
            : direction === "edit"
              ? "Edit"
              : direction === "download"
                ? "Download"
                : props.transfer.atomic
                  ? "atomic move"
                  : direction === "move"
                    ? "Move"
                    : "Copy";
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}
        >
            {icon}
            {label}
        </span>
    );
}

export function TransferList(props: {
    api: ApiClient;
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transfers: TransferProgressEntry[];
}) {
    const queryClient = useQueryClient();
    const [selectedTransfer, setSelectedTransfer] =
        React.useState<TransferProgressEntry | null>(null);
    const [toastMessage, setToastMessage] = React.useState<string | null>(null);
    const cancelMutation = useMutation({
        mutationFn: (transferId: number) =>
            props.api.cancelTransfer(transferId),
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: queryKeys.transfers(),
            });
            setSelectedTransfer(null);
            setToastMessage("Transfer cancellation requested");
        },
    });

    if (props.transfers.length === 0) {
        return <EmptyTransferList />;
    }

    return (
        <div className="overflow-x-auto bg-[#11141b]">
            <table className="w-full min-w-[48rem] bg-[#11141b]">
                <TransferTableHeader />
                <tbody>
                    {props.transfers.map((transfer) => {
                        const hasEndpoints =
                            transfer.direction === "copy" ||
                            transfer.direction === "move";
                        const agent = props.agents.find(
                            (entry) => entry.id === transfer.agent_id,
                        );
                        const sourceAgent = transfer.source
                            ? props.agents.find(
                                  (entry) =>
                                      entry.id === transfer.source?.agent,
                              )
                            : undefined;
                        const destAgent = transfer.dest
                            ? props.agents.find(
                                  (entry) => entry.id === transfer.dest?.agent,
                              )
                            : undefined;

                        return (
                            <tr
                                key={transfer.request_id.toString()}
                                className="border-b border-slate-800/60 last:border-b-0 hover:bg-white/5 align-top"
                            >
                                <td className="whitespace-nowrap p-3">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-slate-100">
                                            {hasEndpoints
                                                ? `${sourceAgent?.name ?? transfer.source?.agent} -> ${destAgent?.name ?? transfer.dest?.agent}`
                                                : (agent?.name ??
                                                  transfer.agent_id)}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                            {hasEndpoints
                                                ? `${transfer.source?.agent} -> ${transfer.dest?.agent}`
                                                : transfer.agent_id}
                                        </span>
                                    </div>
                                </td>
                                <td className="whitespace-nowrap p-3">
                                    <TransferDirectionBadge
                                        transfer={transfer}
                                    />
                                </td>
                                <td className="max-w-xs p-3">
                                    {hasEndpoints ? (
                                        <div className="space-y-1 font-mono text-xs text-slate-300">
                                            <div className="truncate">
                                                {sourceAgent ? (
                                                    <Link
                                                        to={sourceAgent.getBrowserUrl(
                                                            transfer.source
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-400 hover:underline"
                                                        title={
                                                            transfer.source
                                                                ?.path
                                                        }
                                                    >
                                                        {transfer.source?.path}
                                                    </Link>
                                                ) : (
                                                    transfer.source?.path
                                                )}
                                            </div>
                                            <div className="text-slate-600">
                                                -&gt;
                                            </div>
                                            <div className="truncate">
                                                {destAgent ? (
                                                    <Link
                                                        to={destAgent.getBrowserUrl(
                                                            transfer.dest
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-400 hover:underline"
                                                        title={
                                                            transfer.dest?.path
                                                        }
                                                    >
                                                        {transfer.dest?.path}
                                                    </Link>
                                                ) : (
                                                    transfer.dest?.path
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="truncate font-mono text-xs text-slate-300">
                                            {agent ? (
                                                <Link
                                                    to={agent.getBrowserUrl(
                                                        transfer.path,
                                                    )}
                                                    className="text-blue-400 hover:underline"
                                                    title={transfer.path}
                                                >
                                                    {transfer.path}
                                                </Link>
                                            ) : (
                                                transfer.path
                                            )}
                                        </div>
                                    )}
                                </td>
                                <td className="w-80 whitespace-nowrap p-3">
                                    <TransferProgressCell transfer={transfer} />
                                </td>
                                <TransferStatusCell transfer={transfer} />
                                <TransferActionsCell
                                    transfer={transfer}
                                    disabled={cancelMutation.isPending}
                                    onCancel={() => {
                                        cancelMutation.reset();
                                        setSelectedTransfer(transfer);
                                    }}
                                />
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <TransferCancellationDialog
                isOpen={selectedTransfer !== null}
                isBusy={cancelMutation.isPending}
                errorMessage={
                    cancelMutation.error instanceof Error
                        ? cancelMutation.error.message
                        : null
                }
                onClose={() => {
                    if (!cancelMutation.isPending) {
                        setSelectedTransfer(null);
                    }
                }}
                onConfirm={() => {
                    if (selectedTransfer !== null) {
                        cancelMutation.mutate(selectedTransfer.request_id);
                    }
                }}
            />
            <TransferCancellationToast
                message={toastMessage}
                onDismiss={() => setToastMessage(null)}
            />
        </div>
    );
}
