import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Info, LoaderCircle, RefreshCw } from "lucide-react";
import type { ApiClient, Agent, CopyExistingMode } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { InputControl } from "#ui/components/input-control";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage } from "#ui/components/browser/utils";
import { transfersQueryOptions } from "#ui/queries";
import { formatSize } from "#ui/utils/path";

/** Reuses the agent and absolute-path controls for cross-agent file operations. */
export function AgentPathFields(props: {
    agents: Array<Agent>;
    agentId: string;
    path: string;
    operation: "Diff" | "Sync";
    disabled: boolean;
    onAgentChange: (agentId: string) => void;
    onPathChange: (path: string) => void;
}) {
    return (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <label className="grid gap-2 text-sm font-medium text-slate-200">
                Agent
                <select
                    aria-label={`${props.operation} agent`}
                    value={props.agentId}
                    onChange={(event) =>
                        props.onAgentChange(event.target.value)
                    }
                    disabled={props.disabled}
                    className="h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {props.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                            {agent.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-200">
                Path
                <InputControl
                    type="text"
                    aria-label={`${props.operation} path`}
                    value={props.path}
                    onChange={(event) => props.onPathChange(event.target.value)}
                    disabled={props.disabled}
                    required
                    className="h-11 rounded-lg bg-slate-950 font-mono text-sm focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                />
            </label>
        </div>
    );
}

const existingModeOptions: Array<{
    value: CopyExistingMode;
    label: string;
    description: string;
}> = [
    {
        value: "error",
        label: "Error",
        description:
            "Stop without changing the destination if the target path already exists.",
    },
    {
        value: "override",
        label: "Override",
        description:
            "Replace the entire target path. Destination-only files and directories are removed.",
    },
    {
        value: "merge",
        label: "Merge",
        description:
            "Add and replace source entries while preserving entries that exist only at the destination.",
    },
];

/** Explains and selects the destination conflict policy appropriate to the source type. */
function SyncExistingControls(props: {
    entryType: "file" | "directory";
    existingMode: CopyExistingMode;
    overrideExistingFile: boolean;
    disabled: boolean;
    onExistingModeChange: (mode: CopyExistingMode) => void;
    onOverrideExistingFileChange: (override: boolean) => void;
}) {
    if (props.entryType === "file") {
        return (
            <Tooltip content="Replace the target file if it already exists. When unchecked, sync stops without changing it.">
                <Checkbox
                    checked={props.overrideExistingFile}
                    role="checkbox"
                    disabled={props.disabled}
                    onCheckedChange={props.onOverrideExistingFileChange}
                    className="w-fit gap-3 rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 font-medium text-slate-200 hover:border-slate-600 hover:bg-slate-950/50"
                >
                    Override existing
                    <Info
                        aria-hidden="true"
                        className="h-4 w-4 text-slate-400"
                    />
                </Checkbox>
            </Tooltip>
        );
    }

    return (
        <RadioCardGroup
            legend="If the target exists"
            disabled={props.disabled}
            legendClassName="mb-1 text-sm font-medium text-slate-200"
            optionsClassName="md:grid-cols-3"
        >
            {existingModeOptions.map((option) => (
                <RadioCardOption
                    key={option.value}
                    name="on-existing"
                    value={option.value}
                    label={option.label}
                    description={option.description}
                    checked={props.existingMode === option.value}
                    layout="compact"
                    helpAriaLabel={`${option.label} behavior`}
                    onChange={() => props.onExistingModeChange(option.value)}
                />
            ))}
        </RadioCardGroup>
    );
}

/** Copies one path and follows its asynchronous transfer through final placement. */
export function SyncView(props: {
    api: ApiClient;
    sourceAgent: Agent;
    agents: Array<Agent>;
    sourcePath: string;
    entryType: "file" | "directory";
}) {
    const availableAgents = props.agents.filter(
        (agent) => agent.status === "connected",
    );
    const defaultAgent =
        availableAgents.find((agent) => agent.id !== props.sourceAgent.id) ??
        availableAgents[0];
    const [selectedAgentId, setSelectedAgentId] = React.useState(
        defaultAgent?.id ?? "",
    );
    const [selectedPath, setSelectedPath] = React.useState(props.sourcePath);
    const [existingMode, setExistingMode] =
        React.useState<CopyExistingMode>("error");
    const [overrideExistingFile, setOverrideExistingFile] =
        React.useState(false);
    const syncMutation = useMutation({
        mutationFn: () =>
            props.sourceAgent.copyTo(
                { agent: selectedAgentId, path: selectedPath },
                props.sourcePath,
                {
                    on_existing:
                        props.entryType === "file"
                            ? overrideExistingFile
                                ? "override"
                                : "error"
                            : existingMode,
                },
            ),
    });
    const activeRequestId = syncMutation.data?.copy_request_id ?? null;
    const transferQuery = useQuery({
        ...transfersQueryOptions(props.api),
        enabled: activeRequestId !== null,
        retry: false,
        select: (response) =>
            response.transfers.find(
                (entry) => entry.request_id === activeRequestId,
            ),
        refetchInterval: (query) => {
            const transfer = query.state.data?.transfers.find(
                (entry) => entry.request_id === activeRequestId,
            );
            return transfer?.state === "completed" ||
                transfer?.state === "errored"
                ? false
                : 500;
        },
    });
    const transfer = transferQuery.data;
    const isActive =
        syncMutation.isSuccess &&
        transfer?.state !== "completed" &&
        transfer?.state !== "errored" &&
        !transferQuery.isError;
    const isBusy = syncMutation.isPending || isActive;
    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selectedAgentId) return;

        syncMutation.mutate();
    };

    const entryLabel = props.entryType === "file" ? "file" : "directory";
    return (
        <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            <header className="border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                    Sync {entryLabel}
                </p>
                <h1 className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl">
                    {props.sourcePath.split("/").filter(Boolean).pop() ?? "/"}
                </h1>
                <p className="mt-3 max-w-3xl text-sm text-slate-400">
                    Copy this {entryLabel} to an absolute path on a connected
                    agent.
                </p>
            </header>

            <form className="grid gap-6 p-6 md:p-8" onSubmit={handleSubmit}>
                <AgentPathFields
                    agents={availableAgents}
                    agentId={selectedAgentId}
                    path={selectedPath}
                    operation="Sync"
                    disabled={isBusy}
                    onAgentChange={setSelectedAgentId}
                    onPathChange={setSelectedPath}
                />

                <SyncExistingControls
                    entryType={props.entryType}
                    existingMode={existingMode}
                    overrideExistingFile={overrideExistingFile}
                    disabled={isBusy}
                    onExistingModeChange={setExistingMode}
                    onOverrideExistingFileChange={setOverrideExistingFile}
                />

                <div className="flex flex-wrap items-center gap-4">
                    <Button
                        type="submit"
                        size="lg"
                        disabled={isBusy || !selectedAgentId}
                        isLoading={isBusy}
                        className="rounded-md text-sm font-semibold shadow-sm shadow-blue-950/30"
                    >
                        {isBusy ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                            <RefreshCw className="h-4 w-4" />
                        )}
                        {syncMutation.isPending
                            ? "Starting sync..."
                            : isActive
                              ? "Syncing..."
                              : "Sync"}
                    </Button>
                    {isActive ? (
                        <span role="status" className="text-sm text-slate-400">
                            {formatSize(transfer?.transferred_bytes ?? 0)}{" "}
                            transferred
                            {(transfer?.total_bytes ?? 0) > 0
                                ? ` of ${formatSize(transfer?.total_bytes ?? 0)}`
                                : ""}
                        </span>
                    ) : null}
                </div>
            </form>

            {transfer?.state === "completed" ? (
                <p
                    role="status"
                    className="border-t border-slate-800 p-6 text-sm text-emerald-300 md:p-8"
                >
                    Sync completed successfully.{" "}
                    {formatSize(transfer.transferred_bytes)} transferred to{" "}
                    {selectedPath}.
                </p>
            ) : syncMutation.isError ||
              transferQuery.isError ||
              transfer?.state === "errored" ? (
                <p
                    role="alert"
                    className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
                >
                    Sync failed:{" "}
                    {transfer?.state === "errored"
                        ? (transfer.error ?? "Sync failed")
                        : getErrorMessage(
                              syncMutation.error ?? transferQuery.error,
                              transferQuery.isError
                                  ? "Failed to read sync progress"
                                  : "Failed to start sync",
                          )}
                </p>
            ) : null}
        </article>
    );
}
