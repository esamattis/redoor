import React from "react";
import { Info, LoaderCircle, RefreshCw } from "lucide-react";
import type { ApiClient, Agent, CopyExistingMode } from "#ui/api-client";
import { FilePageHeader } from "#ui/components/browser/file-page-header";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage } from "#ui/components/browser/utils";
import { formatSize } from "#ui/utils/path";

type SyncState =
    | { type: "idle" }
    | { type: "starting" }
    | {
          type: "active";
          requestId: number;
          transferredBytes: number;
          totalBytes: number;
      }
    | { type: "success"; transferredBytes: number }
    | { type: "error"; message: string };

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
                <input
                    type="text"
                    aria-label={`${props.operation} path`}
                    value={props.path}
                    onChange={(event) => props.onPathChange(event.target.value)}
                    disabled={props.disabled}
                    required
                    className="h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
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

/** Gives file sync the same stable page header as every other file representation. */
export function FileSyncPage(props: {
    api: ApiClient;
    agent: Agent;
    agents: Array<Agent>;
    agentId: string;
    path: string;
    fileName: string;
    filePath: string;
    downloadUrl: string;
}) {
    return (
        <div className="p-6">
            <div className="mx-auto max-w-6xl">
                <FilePageHeader
                    agent={props.agent}
                    agentId={props.agentId}
                    path={props.path}
                    fileName={props.fileName}
                    downloadUrl={props.downloadUrl}
                    activeView="sync"
                />
                <SyncView
                    api={props.api}
                    sourceAgent={props.agent}
                    agents={props.agents}
                    sourcePath={props.filePath}
                    entryType="file"
                />
            </div>
        </div>
    );
}

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
            <label className="flex w-fit cursor-pointer items-center gap-3 rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm font-medium text-slate-200">
                <input
                    type="checkbox"
                    checked={props.overrideExistingFile}
                    onChange={(event) =>
                        props.onOverrideExistingFileChange(event.target.checked)
                    }
                    disabled={props.disabled}
                    className="h-4 w-4 accent-blue-500"
                />
                Override existing
                <Tooltip content="Replace the target file if it already exists. When unchecked, sync stops without changing it.">
                    <Info
                        aria-label="Override existing behavior"
                        className="h-4 w-4 text-slate-400"
                    />
                </Tooltip>
            </label>
        );
    }

    return (
        <fieldset disabled={props.disabled} className="grid gap-3">
            <legend className="mb-1 text-sm font-medium text-slate-200">
                If the target exists
            </legend>
            <div className="grid gap-3 md:grid-cols-3">
                {existingModeOptions.map((option) => (
                    <label
                        key={option.value}
                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-4 py-3 transition ${
                            props.existingMode === option.value
                                ? "border-blue-500/60 bg-blue-500/10 text-blue-100"
                                : "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-600"
                        }`}
                    >
                        <span className="flex items-center gap-3 text-sm font-medium">
                            <input
                                type="radio"
                                name="on-existing"
                                value={option.value}
                                checked={props.existingMode === option.value}
                                onChange={() =>
                                    props.onExistingModeChange(option.value)
                                }
                                className="h-4 w-4 accent-blue-500"
                            />
                            {option.label}
                        </span>
                        <Tooltip content={option.description}>
                            <Info
                                aria-label={`${option.label} behavior`}
                                className="h-4 w-4 text-slate-400"
                            />
                        </Tooltip>
                    </label>
                ))}
            </div>
        </fieldset>
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
    const [state, setState] = React.useState<SyncState>({ type: "idle" });
    const activeRequestId = state.type === "active" ? state.requestId : null;

    React.useEffect(() => {
        if (activeRequestId === null) return;

        let cancelled = false;
        let polling = false;
        const pollProgress = async () => {
            if (polling) return;
            polling = true;
            try {
                const response = await props.api.getTransferProgress();
                if (cancelled) return;
                const transfer = response.transfers.find(
                    (entry) => entry.request_id === activeRequestId,
                );
                if (!transfer) return;
                if (transfer.state === "completed") {
                    setState({
                        type: "success",
                        transferredBytes: transfer.transferred_bytes,
                    });
                } else if (transfer.state === "errored") {
                    setState({
                        type: "error",
                        message: transfer.error ?? "Sync failed",
                    });
                } else {
                    setState({
                        type: "active",
                        requestId: activeRequestId,
                        transferredBytes: transfer.transferred_bytes,
                        totalBytes: transfer.total_bytes,
                    });
                }
            } catch (error) {
                if (!cancelled) {
                    setState({
                        type: "error",
                        message: getErrorMessage(
                            error,
                            "Failed to read sync progress",
                        ),
                    });
                }
            } finally {
                polling = false;
            }
        };

        void pollProgress();
        const timer = window.setInterval(() => void pollProgress(), 500);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [activeRequestId, props.api]);

    const isBusy = state.type === "starting" || state.type === "active";
    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selectedAgentId) return;

        setState({ type: "starting" });
        try {
            const response = await props.sourceAgent.copyTo(
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
            );
            setState({
                type: "active",
                requestId: response.copy_request_id,
                transferredBytes: 0,
                totalBytes: 0,
            });
        } catch (error) {
            setState({
                type: "error",
                message: getErrorMessage(error, "Failed to start sync"),
            });
        }
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
                    <button
                        type="submit"
                        disabled={isBusy || !selectedAgentId}
                        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isBusy ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                            <RefreshCw className="h-4 w-4" />
                        )}
                        {state.type === "starting"
                            ? "Starting sync..."
                            : state.type === "active"
                              ? "Syncing..."
                              : "Sync"}
                    </button>
                    {state.type === "active" ? (
                        <span role="status" className="text-sm text-slate-400">
                            {formatSize(state.transferredBytes)} transferred
                            {state.totalBytes > 0
                                ? ` of ${formatSize(state.totalBytes)}`
                                : ""}
                        </span>
                    ) : null}
                </div>
            </form>

            {state.type === "success" ? (
                <p
                    role="status"
                    className="border-t border-slate-800 p-6 text-sm text-emerald-300 md:p-8"
                >
                    Sync completed successfully.{" "}
                    {formatSize(state.transferredBytes)} transferred to{" "}
                    {selectedPath}.
                </p>
            ) : state.type === "error" ? (
                <p
                    role="alert"
                    className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
                >
                    Sync failed: {state.message}
                </p>
            ) : null}
        </article>
    );
}
