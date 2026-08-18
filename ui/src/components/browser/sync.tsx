import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { html as renderDiffHtml } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import {
    ChevronDown,
    Copy,
    FileSearch,
    FolderInput,
    GitCompareArrows,
    LoaderCircle,
} from "lucide-react";
import type { ApiClient, Agent, CopyExistingMode } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { InputControl } from "#ui/components/input-control";
import { Tooltip } from "#ui/components/tooltip";
import { DestinationConflictDialog } from "#ui/components/browser/selected-files-transfer-dialog";
import {
    getErrorMessage,
    getPathLoadError,
} from "#ui/components/browser/utils";
import { transfersQueryOptions } from "#ui/queries";
import { formatSize } from "#ui/utils/path";
import "diff2html/bundles/css/diff2html.min.css";

/** Reuses the agent and absolute-path controls for cross-agent file operations. */
export function AgentPathFields(props: {
    agents: Array<Agent>;
    agentId: string;
    path: string;
    disabled: boolean;
    onAgentChange: (agentId: string) => void;
    onPathChange: (path: string) => void;
}) {
    return (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <label className="grid gap-2 text-sm font-medium text-slate-200">
                Agent
                <span className="relative block">
                    <select
                        aria-label="Sync agent"
                        value={props.agentId}
                        onChange={(event) =>
                            props.onAgentChange(event.target.value)
                        }
                        disabled={props.disabled}
                        className="h-11 w-full appearance-none rounded-lg border border-slate-700 bg-slate-950 py-2 pl-3 pr-10 text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {props.agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                                {agent.name}
                            </option>
                        ))}
                    </select>
                    <ChevronDown
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-slate-400"
                    />
                </span>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-200">
                Path
                <InputControl
                    type="text"
                    aria-label="Sync path"
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

type TransferOperation = "copy" | "move";

/** 404 means Copy/Move can start immediately; any other failure must stay visible. */
async function destinationExists(agent: Agent, path: string): Promise<boolean> {
    try {
        await agent.ls(path);
        return true;
    } catch (error) {
        const pathError = getPathLoadError(error);
        if (pathError?.type === "missing") {
            return false;
        }
        throw error;
    }
}

/** Turns the unified-diff payload into a table that can grow wider than the viewport. */
function FileDiffResult(props: { unifiedDiff: string }) {
    const rendered = React.useMemo(
        () =>
            renderDiffHtml(props.unifiedDiff, {
                drawFileList: false,
                matching: "lines",
                outputFormat: "line-by-line",
                colorScheme: ColorSchemeType.AUTO,
            }),
        [props.unifiedDiff],
    );

    if (props.unifiedDiff === "") {
        return (
            <p className="text-sm text-slate-400">The files are identical.</p>
        );
    }

    return (
        <div
            className="file-diff-html min-w-max"
            dangerouslySetInnerHTML={{ __html: rendered }}
        />
    );
}

/** Keeps destination lookup, transfer polling, and diff out of the page render. */
function useSyncWorkspace(props: {
    api: ApiClient;
    sourceAgent: Agent;
    agents: Array<Agent>;
    sourcePath: string;
    entryType: "file" | "directory";
}) {
    const navigate = useNavigate();
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
    const [pendingOperation, setPendingOperation] =
        React.useState<TransferOperation | null>(null);
    const selectedAgent = availableAgents.find(
        (agent) => agent.id === selectedAgentId,
    );

    const transferMutation = useMutation({
        mutationFn: async (request: {
            operation: TransferOperation;
            mode: CopyExistingMode;
        }) => {
            const destination = {
                agent: selectedAgentId,
                path: selectedPath,
            };
            if (request.operation === "copy") {
                const response = await props.sourceAgent.copyTo(
                    destination,
                    props.sourcePath,
                    { on_existing: request.mode },
                );
                return {
                    requestId: response.copy_request_id,
                    operation: request.operation,
                };
            }
            const response = await props.sourceAgent.moveTo(
                destination,
                props.sourcePath,
                { on_existing: request.mode },
            );
            return {
                requestId: response.move_request_id,
                operation: request.operation,
            };
        },
    });
    const prepareTransferMutation = useMutation({
        mutationFn: async (operation: TransferOperation) => {
            if (!selectedAgent) {
                throw new Error("Selected agent is unavailable");
            }
            const exists = await destinationExists(selectedAgent, selectedPath);
            return { operation, exists };
        },
        onSuccess: (result) => {
            if (!result.exists) {
                transferMutation.mutate({
                    operation: result.operation,
                    mode: "error",
                });
                return;
            }
            setPendingOperation(result.operation);
        },
    });
    const diffMutation = useMutation({
        mutationFn: () =>
            props.api.diffFiles(
                { agent: props.sourceAgent.id, path: props.sourcePath },
                { agent: selectedAgentId, path: selectedPath },
            ),
    });

    const activeRequestId = transferMutation.data?.requestId ?? null;
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
    const transferOperation =
        transferMutation.data?.operation ??
        transferMutation.variables?.operation ??
        prepareTransferMutation.variables ??
        pendingOperation;
    const isActive =
        transferMutation.isSuccess &&
        transfer?.state !== "completed" &&
        transfer?.state !== "errored" &&
        !transferQuery.isError;
    const preparingOperation = prepareTransferMutation.isPending
        ? prepareTransferMutation.variables
        : null;

    /** Probes the destination so conflict policy is asked only when a path already exists. */
    const startTransfer = (operation: TransferOperation) => {
        if (!selectedAgentId) {
            return;
        }
        prepareTransferMutation.reset();
        transferMutation.reset();
        prepareTransferMutation.mutate(operation);
    };

    /** Real href so middle-click / open-in-new-tab works; left-click stays in-app. */
    const destinationHref =
        selectedAgent && selectedPath.startsWith("/")
            ? selectedAgent.getBrowserUrl(selectedPath)
            : null;

    /** Opens the destination without carrying the source Sync query string along. */
    const gotoDestination = () => {
        if (destinationHref === null) {
            return;
        }
        void navigate({
            to: destinationHref,
            search: {},
        });
    };

    return {
        availableAgents,
        selectedAgentId,
        selectedPath,
        setSelectedAgentId,
        setSelectedPath,
        pendingOperation,
        setPendingOperation,
        destinationHref,
        canDiff: props.entryType === "file",
        transferMutation,
        prepareTransferMutation,
        diffMutation,
        transfer,
        transferQuery,
        transferOperation,
        transferLabel: transferOperation === "move" ? "Move" : "Copy",
        isActive,
        isBusy:
            prepareTransferMutation.isPending ||
            transferMutation.isPending ||
            isActive,
        preparingOperation,
        copyInFlight:
            preparingOperation === "copy" ||
            (transferMutation.isPending &&
                transferMutation.variables?.operation === "copy") ||
            (isActive && transferOperation === "copy"),
        moveInFlight:
            preparingOperation === "move" ||
            (transferMutation.isPending &&
                transferMutation.variables?.operation === "move") ||
            (isActive && transferOperation === "move"),
        startTransfer,
        gotoDestination,
    };
}

type SyncWorkspace = ReturnType<typeof useSyncWorkspace>;

/** Labels stay operation-specific so Sync reuses the listing dialog names. */
function conflictDialogLabels(operation: TransferOperation | null) {
    if (operation === "move") {
        return {
            closeAriaLabel: "Close move conflict dialog",
            confirmLabel: "Continue moving",
            radioGroupName: "move-on-existing",
        };
    }
    return {
        closeAriaLabel: "Close copy conflict dialog",
        confirmLabel: "Continue copying",
        radioGroupName: "copy-on-existing",
    };
}

/** Keeps the four primary actions in one toolbar without bloating the page. */
function SyncActionBar(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Tooltip content="Copy this path to the destination">
                <Button
                    type="button"
                    size="lg"
                    disabled={workspace.isBusy || !workspace.selectedAgentId}
                    isLoading={workspace.copyInFlight}
                    onClick={() => workspace.startTransfer("copy")}
                    className="rounded-md text-sm font-semibold shadow-sm shadow-blue-950/30"
                >
                    {workspace.copyInFlight ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                    {workspace.preparingOperation === "copy" ||
                    (workspace.transferMutation.isPending &&
                        workspace.transferMutation.variables?.operation ===
                            "copy")
                        ? "Starting copy..."
                        : workspace.isActive &&
                            workspace.transferOperation === "copy"
                          ? "Copying..."
                          : "Copy"}
                </Button>
            </Tooltip>
            <Tooltip content="Move this path to the destination">
                <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    disabled={workspace.isBusy || !workspace.selectedAgentId}
                    isLoading={workspace.moveInFlight}
                    onClick={() => workspace.startTransfer("move")}
                    className="rounded-md text-sm font-semibold"
                >
                    {workspace.moveInFlight ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                        <FolderInput className="h-4 w-4" />
                    )}
                    {workspace.preparingOperation === "move" ||
                    (workspace.transferMutation.isPending &&
                        workspace.transferMutation.variables?.operation ===
                            "move")
                        ? "Starting move..."
                        : workspace.isActive &&
                            workspace.transferOperation === "move"
                          ? "Moving..."
                          : "Move"}
                </Button>
            </Tooltip>
            {workspace.canDiff ? (
                <Tooltip content="Compare this file with the destination">
                    <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        disabled={
                            workspace.isBusy ||
                            !workspace.selectedAgentId ||
                            workspace.diffMutation.isPending
                        }
                        isLoading={workspace.diffMutation.isPending}
                        onClick={() => {
                            if (!workspace.selectedAgentId) {
                                return;
                            }
                            workspace.diffMutation.mutate();
                        }}
                        className="rounded-md text-sm font-semibold"
                    >
                        <GitCompareArrows className="h-4 w-4" />
                        {workspace.diffMutation.isPending
                            ? "Generating diff..."
                            : "Diff"}
                    </Button>
                </Tooltip>
            ) : null}
            <Tooltip content="Open the selected destination path">
                {workspace.destinationHref === null ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        disabled
                        className="rounded-md text-sm font-semibold"
                    >
                        <FileSearch className="h-4 w-4" />
                        Goto
                    </Button>
                ) : (
                    <Button
                        as="a"
                        href={workspace.destinationHref}
                        variant="secondary"
                        size="lg"
                        className="rounded-md text-sm font-semibold"
                        onClick={(event) => {
                            // Keep unmodified left-click in-app; middle/modified clicks use the href.
                            if (
                                event.defaultPrevented ||
                                event.button !== 0 ||
                                event.metaKey ||
                                event.altKey ||
                                event.ctrlKey ||
                                event.shiftKey
                            ) {
                                return;
                            }
                            event.preventDefault();
                            workspace.gotoDestination();
                        }}
                    >
                        <FileSearch className="h-4 w-4" />
                        Goto
                    </Button>
                )}
            </Tooltip>
            {workspace.isActive ? (
                <span role="status" className="text-sm text-slate-400">
                    {formatSize(workspace.transfer?.transferred_bytes ?? 0)}{" "}
                    transferred
                    {(workspace.transfer?.total_bytes ?? 0) > 0
                        ? ` of ${formatSize(workspace.transfer?.total_bytes ?? 0)}`
                        : ""}
                </span>
            ) : null}
        </div>
    );
}

/** Reports transfer completion separately so a later Diff result can stay on screen. */
function SyncTransferStatus(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    if (workspace.transfer?.state === "completed") {
        return (
            <p
                role="status"
                className="border-t border-slate-800 p-6 text-sm text-emerald-300 md:p-8"
            >
                {workspace.transferLabel} completed successfully.{" "}
                {formatSize(workspace.transfer.transferred_bytes)} transferred
                to {workspace.selectedPath}.
            </p>
        );
    }
    if (
        workspace.prepareTransferMutation.isError ||
        workspace.transferMutation.isError ||
        workspace.transferQuery.isError ||
        workspace.transfer?.state === "errored"
    ) {
        return (
            <p
                role="alert"
                className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
            >
                {workspace.transferLabel} failed:{" "}
                {workspace.transfer?.state === "errored"
                    ? (workspace.transfer.error ??
                      `${workspace.transferLabel} failed`)
                    : getErrorMessage(
                          workspace.prepareTransferMutation.error ??
                              workspace.transferMutation.error ??
                              workspace.transferQuery.error,
                          workspace.transferQuery.isError
                              ? `Failed to read ${workspace.transferLabel.toLowerCase()} progress`
                              : workspace.prepareTransferMutation.isError
                                ? "Failed to check the destination"
                                : `Failed to start ${workspace.transferLabel.toLowerCase()}`,
                      )}
            </p>
        );
    }
    return null;
}

/** Keeps the rendered hunks under the form so Copy/Move chrome stays interactive. */
function SyncDiffSection(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    if (workspace.diffMutation.isError) {
        return (
            <p
                role="alert"
                className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
            >
                {getErrorMessage(
                    workspace.diffMutation.error,
                    "Failed to generate diff",
                )}
            </p>
        );
    }
    if (!workspace.diffMutation.isSuccess) {
        return null;
    }
    return (
        <section
            aria-label="File diff"
            className="file-diff-host w-full min-w-0 overflow-x-auto border-t border-slate-800 p-4 md:p-6"
        >
            <FileDiffResult
                unifiedDiff={workspace.diffMutation.data.unified_diff}
            />
        </section>
    );
}

/** Hosts copy, move, compare, and destination navigation in one workspace. */
export function SyncView(props: {
    api: ApiClient;
    sourceAgent: Agent;
    agents: Array<Agent>;
    sourcePath: string;
    entryType: "file" | "directory";
}) {
    const workspace = useSyncWorkspace(props);
    const entryLabel = props.entryType === "file" ? "file" : "directory";
    const conflictLabels = conflictDialogLabels(workspace.pendingOperation);

    return (
        <article className="rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            <header className="border-b border-slate-800 bg-linear-to-br from-blue-500/10 via-transparent to-transparent p-6 md:p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                    Sync {entryLabel}
                </p>
                <h1 className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl">
                    {props.sourcePath.split("/").filter(Boolean).pop() ?? "/"}
                </h1>
                <p className="mt-3 max-w-3xl text-sm text-slate-400">
                    {props.entryType === "file"
                        ? "Copy, move, or compare this file against an absolute path on a connected agent."
                        : "Copy or move this directory to an absolute path on a connected agent."}
                </p>
            </header>

            <div className="grid gap-6 p-6 md:p-8">
                <AgentPathFields
                    agents={workspace.availableAgents}
                    agentId={workspace.selectedAgentId}
                    path={workspace.selectedPath}
                    disabled={workspace.isBusy}
                    onAgentChange={workspace.setSelectedAgentId}
                    onPathChange={workspace.setSelectedPath}
                />
                <SyncActionBar workspace={workspace} />
            </div>

            <SyncTransferStatus workspace={workspace} />
            <SyncDiffSection workspace={workspace} />

            <DestinationConflictDialog
                isOpen={workspace.pendingOperation !== null}
                title="Destination items already exist"
                description="The destination path already exists. Choose how to handle the existing destination."
                closeAriaLabel={conflictLabels.closeAriaLabel}
                confirmLabel={conflictLabels.confirmLabel}
                radioGroupName={conflictLabels.radioGroupName}
                onClose={() => workspace.setPendingOperation(null)}
                onConfirm={(mode) => {
                    if (workspace.pendingOperation === null) {
                        return;
                    }
                    const operation = workspace.pendingOperation;
                    workspace.setPendingOperation(null);
                    workspace.transferMutation.mutate({ operation, mode });
                }}
            />
        </article>
    );
}
