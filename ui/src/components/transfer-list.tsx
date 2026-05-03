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
            <div className="p-6 text-center text-sm text-gray-500">
                No transfers
            </div>
        );
    }

    return (
        <div className="overflow-auto bg-white">
            <table className="w-full bg-white">
                <thead className="sticky top-0 bg-gray-50">
                    <tr className="border-b">
                        <th className="text-left p-3 text-sm font-medium text-gray-600">
                            Agent
                        </th>
                        <th className="text-left p-3 text-sm font-medium text-gray-600">
                            Direction
                        </th>
                        <th className="text-left p-3 text-sm font-medium text-gray-600">
                            Path
                        </th>
                        <th className="text-left p-3 text-sm font-medium text-gray-600">
                            Progress
                        </th>
                        <th className="text-left p-3 text-sm font-medium text-gray-600">
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
                                className="border-b last:border-b-0 hover:bg-gray-50 align-top"
                            >
                                <td className="p-3">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-gray-900">
                                            {transfer.direction === "copy"
                                                ? `${sourceAgent?.name ?? transfer.source?.agent} -> ${destAgent?.name ?? transfer.dest?.agent}`
                                                : (agent?.name ??
                                                  transfer.agent_id)}
                                        </span>
                                        <span className="text-xs text-gray-500">
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
                                                ? "bg-blue-50 text-blue-700"
                                                : "bg-emerald-50 text-emerald-700"
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
                                        <div className="space-y-1 font-mono text-xs text-gray-700 break-all">
                                            <div>
                                                {sourceAgent ? (
                                                    <Link
                                                        to={sourceAgent.getBrowserUrl(
                                                            transfer.source
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-600 hover:underline"
                                                    >
                                                        {transfer.source?.path}
                                                    </Link>
                                                ) : (
                                                    transfer.source?.path
                                                )}
                                            </div>
                                            <div className="text-gray-400">
                                                -&gt;
                                            </div>
                                            <div>
                                                {destAgent ? (
                                                    <Link
                                                        to={destAgent.getBrowserUrl(
                                                            transfer.dest
                                                                ?.path ?? "",
                                                        )}
                                                        className="text-blue-600 hover:underline"
                                                    >
                                                        {transfer.dest?.path}
                                                    </Link>
                                                ) : (
                                                    transfer.dest?.path
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="font-mono text-xs text-gray-700 break-all">
                                            {agent ? (
                                                <Link
                                                    to={agent.getBrowserUrl(
                                                        transfer.path,
                                                    )}
                                                    className="text-blue-600 hover:underline"
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
                                    <div className="flex flex-col gap-1 text-sm text-gray-700">
                                        <span>
                                            {formatSize(
                                                transfer.transferred_bytes,
                                            )}{" "}
                                            / {formatSize(transfer.total_bytes)}
                                        </span>
                                        <span className="text-xs text-gray-500">
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
                                                    ? "text-red-600"
                                                    : transfer.state ===
                                                        "completed"
                                                      ? "text-emerald-700"
                                                      : "text-gray-900"
                                            }`}
                                        >
                                            {transfer.state}
                                        </span>
                                        {transfer.error ? (
                                            <span className="inline-flex items-start gap-1 text-xs text-red-600">
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
