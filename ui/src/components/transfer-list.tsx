import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Copy,
    AlertCircle,
} from "lucide-react";
import { type ApiClient, type TransferProgressEntry } from "../api-client";
import { formatSize, formatSpeed } from "../utils/path";

function getTransferSpeedBytesPerSecond(
    transfer: TransferProgressEntry,
): number | null {
    const endTime =
        transfer.ended_at === null || transfer.ended_at === undefined
            ? Date.now() / 1000
            : transfer.ended_at;

    const elapsedSeconds = endTime - transfer.started_at;

    if (elapsedSeconds <= 0) {
        return null;
    }

    return transfer.transferred_bytes / elapsedSeconds;
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
        <div className="overflow-auto bg-[#11141b]">
            <table className="w-full bg-[#11141b]">
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
                        <th className="text-left p-3 text-sm font-medium text-slate-400">
                            Progress
                        </th>
                        <th className="text-left p-3 text-sm font-medium text-slate-400">
                            Status
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {props.transfers.map((transfer) => {
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
                                <td className="p-3">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-slate-100">
                                            {transfer.direction === "copy"
                                                ? `${sourceAgent?.name ?? transfer.source?.agent} -> ${destAgent?.name ?? transfer.dest?.agent}`
                                                : (agent?.name ??
                                                  transfer.agent_id)}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                            {transfer.direction === "copy"
                                                ? `${transfer.source?.agent} -> ${transfer.dest?.agent}`
                                                : transfer.agent_id}
                                        </span>
                                    </div>
                                </td>
                                <td className="p-3">
                                    <span
                                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                                            transfer.direction === "upload"
                                                ? "bg-blue-500/15 text-blue-300"
                                                : "bg-emerald-500/15 text-emerald-300"
                                        }`}
                                    >
                                        {transfer.direction === "upload" ? (
                                            <ArrowUpFromLine className="h-3.5 w-3.5" />
                                        ) : transfer.direction ===
                                          "download" ? (
                                            <ArrowDownToLine className="h-3.5 w-3.5" />
                                        ) : (
                                            <Copy className="h-3.5 w-3.5" />
                                        )}
                                        {transfer.direction === "upload"
                                            ? "Upload"
                                            : transfer.direction === "download"
                                              ? "Download"
                                              : "Copy"}
                                    </span>
                                </td>
                                <td className="p-3">
                                    {transfer.direction === "copy" ? (
                                        <div className="space-y-1 break-all font-mono text-xs text-slate-300">
                                            <div>
                                                {sourceAgent ? (
                                                    <Link
                                                        to={sourceAgent.getBrowserUrl(
                                                            transfer.source
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-400 hover:underline"
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
                                            <div>
                                                {destAgent ? (
                                                    <Link
                                                        to={destAgent.getBrowserUrl(
                                                            transfer.dest
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-400 hover:underline"
                                                    >
                                                        {transfer.dest?.path}
                                                    </Link>
                                                ) : (
                                                    transfer.dest?.path
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="break-all font-mono text-xs text-slate-300">
                                            {agent ? (
                                                <Link
                                                    to={agent.getBrowserUrl(
                                                        transfer.path,
                                                    )}
                                                    className="text-blue-400 hover:underline"
                                                >
                                                    {transfer.path}
                                                </Link>
                                            ) : (
                                                transfer.path
                                            )}
                                        </div>
                                    )}
                                </td>
                                <td className="p-3">
                                    <div className="flex flex-col gap-1 text-sm text-slate-300">
                                        <span>
                                            {formatSize(
                                                transfer.transferred_bytes,
                                            )}{" "}
                                            / {formatSize(transfer.total_bytes)}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                            {transfer.state === "active"
                                                ? `Current speed: ${formatSpeed(
                                                      getTransferSpeedBytesPerSecond(
                                                          transfer,
                                                      ),
                                                  )}`
                                                : `Final speed: ${formatSpeed(
                                                      getTransferSpeedBytesPerSecond(
                                                          transfer,
                                                      ),
                                                  )}`}
                                        </span>
                                    </div>
                                </td>
                                <td className="p-3">
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
                                            <span className="inline-flex items-start gap-1 text-xs text-red-400">
                                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                <span className="break-words">
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
