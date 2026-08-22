import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Copy,
    AlertCircle,
    MoveRight,
} from "lucide-react";
import { type ApiClient, type TransferProgressEntry } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
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
            </tr>
        </thead>
    );
}

export function TransferList(props: {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transfers: TransferProgressEntry[];
}) {
    if (props.transfers.length === 0) {
        return (
            <div className="p-6 text-center text-sm text-slate-500">
                No transfers
            </div>
        );
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
                                    <span
                                        className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200"
                                    >
                                        {transfer.direction === "upload" ? (
                                            <ArrowUpFromLine className="h-3.5 w-3.5" />
                                        ) : transfer.direction ===
                                          "download" ? (
                                            <ArrowDownToLine className="h-3.5 w-3.5" />
                                        ) : transfer.direction === "move" ? (
                                            <MoveRight className="h-3.5 w-3.5" />
                                        ) : (
                                            <Copy className="h-3.5 w-3.5" />
                                        )}
                                        {transfer.direction === "upload"
                                            ? "Upload"
                                            : transfer.direction === "download"
                                              ? "Download"
                                              : transfer.atomic
                                                ? "atomic move"
                                                : transfer.direction === "move"
                                                  ? "Move"
                                                  : "Copy"}
                                    </span>
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
                                                        className="text-slate-100 underline decoration-slate-500 underline-offset-2 hover:decoration-slate-300"
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
                                                        className="text-slate-100 underline decoration-slate-500 underline-offset-2 hover:decoration-slate-300"
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
                                                    className="text-slate-100 underline decoration-slate-500 underline-offset-2 hover:decoration-slate-300"
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
                                <td className="whitespace-nowrap p-3">
                                    <div className="flex flex-col gap-1">
                                        <span
                                            className={`text-sm font-medium ${
                                                transfer.state === "errored"
                                                    ? "text-red-400"
                                                    : transfer.state ===
                                                        "completed"
                                                      ? "text-emerald-400"
                                                      : "text-slate-100"
                                            }`}
                                        >
                                            {transfer.state}
                                        </span>
                                        {transfer.error ? (
                                            <span className="inline-flex max-w-xs items-start gap-1 text-xs text-red-400">
                                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                <span
                                                    className="truncate"
                                                    title={transfer.error}
                                                >
                                                    {transfer.error}
                                                </span>
                                            </span>
                                        ) : null}
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
