import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { html as renderDiffHtml } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import {
    ChevronDown,
    Copy,
    FolderInput,
    GitCompareArrows,
    LoaderCircle,
} from "lucide-react";
import type { ApiClient, Agent, CopyExistingMode } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { DetailCard } from "#ui/components/detail-card";
import { InputControl } from "#ui/components/input-control";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { Tooltip } from "#ui/components/tooltip";
import { DestinationConflictDialog } from "#ui/components/browser/selected-files-transfer-dialog";
import {
    getErrorMessage,
    getPathLoadError,
} from "#ui/components/browser/utils";
import { transfersQueryOptions } from "#ui/queries";
import { formatSize } from "#ui/utils/path";
import "diff2html/bundles/css/diff2html.min.css";

/** Reuses the agent and path controls for cross-agent file operations. */
export function AgentPathFields(props: {
    agents: Array<Agent>;
    agentId: string;
    path: string;
    disabled: boolean;
    viewHref: string | null;
    onAgentChange: (agentId: string) => void;
    onPathChange: (path: string) => void;
    onView: () => void;
}) {
    return (
        <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
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
            <Tooltip content="Open the selected agent and path">
                {props.viewHref === null ? (
                    <span
                        aria-disabled="true"
                        className="pb-3 text-sm font-medium text-slate-600"
                    >
                        view
                    </span>
                ) : (
                    <a
                        href={props.viewHref}
                        className="pb-3 text-sm font-medium text-slate-200 underline decoration-slate-500 underline-offset-4 transition-colors hover:text-slate-100 hover:decoration-slate-300 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
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
                            props.onView();
                        }}
                    >
                        view
                    </a>
                )}
            </Tooltip>
        </div>
    );
}

type TransferOperation = "copy" | "move";
type SyncDirection = "current-to-selected" | "selected-to-current";

type SyncEndpoint = {
    agent: Agent;
    path: string;
};

/** Expands the selected agent's home shorthand before paths reach APIs or routes. */
function resolveSyncPath(agent: Agent, path: string): string {
    if (agent.cwd === null || (path !== "~" && !path.startsWith("~/"))) {
        return path;
    }
    if (path === "~") {
        return agent.cwd;
    }
    return agent.cwd === "/"
        ? `/${path.slice(2)}`
        : `${agent.cwd.replace(/\/+$/, "")}/${path.slice(2)}`;
}

/** Keeps the editable path home-relative so another agent can resolve it against its own home. */
function shortenSyncPath(agent: Agent, path: string): string {
    if (agent.cwd === null || path === "~" || path.startsWith("~/")) {
        return path;
    }
    const home = agent.cwd.replace(/\/+$/, "");
    // A root home would make every absolute path look portable and copy under a peer's real home.
    if (home === "" || home === "/") {
        return path;
    }
    if (path === home || path === `${home}/`) {
        return "~";
    }
    if (path.startsWith(`${home}/`)) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}

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

/** Owns the stable current endpoint and editable peer endpoint before direction reorders them. */
function useSyncEndpointSelection(props: {
    sourceAgent: Agent;
    agents: Array<Agent>;
    sourcePath: string;
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
    const [selectedPath, setSelectedPath] = React.useState(() =>
        shortenSyncPath(props.sourceAgent, props.sourcePath),
    );
    const [direction, setDirection] = React.useState<SyncDirection>(
        "current-to-selected",
    );
    const selectedAgent = availableAgents.find(
        (agent) => agent.id === selectedAgentId,
    );
    const currentEndpoint: SyncEndpoint = {
        agent: props.sourceAgent,
        path: props.sourcePath,
    };
    const selectedEndpoint: SyncEndpoint | null = selectedAgent
        ? {
              agent: selectedAgent,
              path: resolveSyncPath(selectedAgent, selectedPath),
          }
        : null;
    const sourceEndpoint =
        direction === "current-to-selected"
            ? currentEndpoint
            : selectedEndpoint;
    const destinationEndpoint =
        direction === "current-to-selected"
            ? selectedEndpoint
            : currentEndpoint;

    return {
        availableAgents,
        selectedAgentId,
        setSelectedAgentId,
        selectedPath,
        setSelectedPath,
        direction,
        setDirection,
        selectedAgent,
        selectedEndpoint,
        sourceEndpoint,
        destinationEndpoint,
    };
}

/** Polls only the active transfer and stops once the server reports a terminal state. */
function useSyncTransferProgress(api: ApiClient, requestId: number | null) {
    return useQuery({
        ...transfersQueryOptions(api),
        enabled: requestId !== null,
        retry: false,
        select: (response) =>
            response.transfers.find((entry) => entry.request_id === requestId),
        refetchInterval: (query) => {
            const transfer = query.state.data?.transfers.find(
                (entry) => entry.request_id === requestId,
            );
            return transfer?.state === "completed" ||
                transfer?.state === "errored"
                ? false
                : 500;
        },
    });
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
    const endpoints = useSyncEndpointSelection(props);
    const {
        availableAgents,
        selectedAgentId,
        setSelectedAgentId,
        selectedPath,
        setSelectedPath,
        direction,
        setDirection,
        selectedAgent,
        selectedEndpoint,
        sourceEndpoint,
        destinationEndpoint,
    } = endpoints;
    const [pendingOperation, setPendingOperation] =
        React.useState<TransferOperation | null>(null);
    const [confirmationOperation, setConfirmationOperation] =
        React.useState<TransferOperation | null>(null);

    const transferMutation = useMutation({
        mutationFn: async (request: {
            operation: TransferOperation;
            mode: CopyExistingMode;
        }) => {
            if (sourceEndpoint === null || destinationEndpoint === null) {
                throw new Error("Selected agent is unavailable");
            }
            const destination = {
                agent: destinationEndpoint.agent.id,
                path: destinationEndpoint.path,
            };
            if (request.operation === "copy") {
                const response = await sourceEndpoint.agent.copyTo(
                    destination,
                    sourceEndpoint.path,
                    { on_existing: request.mode },
                );
                return {
                    requestId: response.copy_request_id,
                    operation: request.operation,
                };
            }
            const response = await sourceEndpoint.agent.moveTo(
                destination,
                sourceEndpoint.path,
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
            if (destinationEndpoint === null) {
                throw new Error("Selected agent is unavailable");
            }
            const exists = await destinationExists(
                destinationEndpoint.agent,
                destinationEndpoint.path,
            );
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
        mutationFn: () => {
            if (sourceEndpoint === null || destinationEndpoint === null) {
                throw new Error("Selected agent is unavailable");
            }
            return props.api.diffFiles(
                { agent: sourceEndpoint.agent.id, path: sourceEndpoint.path },
                {
                    agent: destinationEndpoint.agent.id,
                    path: destinationEndpoint.path,
                },
            );
        },
    });

    const activeRequestId = transferMutation.data?.requestId ?? null;
    const transferQuery = useSyncTransferProgress(props.api, activeRequestId);
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
        if (sourceEndpoint === null || destinationEndpoint === null) {
            return;
        }
        prepareTransferMutation.reset();
        transferMutation.reset();
        prepareTransferMutation.mutate(operation);
    };

    /** Real href so middle-click / open-in-new-tab works; left-click stays in-app. */
    const selectedHref = selectedEndpoint?.path.startsWith("/")
        ? selectedEndpoint.agent.getBrowserUrl(selectedEndpoint.path)
        : null;

    /** Opens the selected endpoint regardless of which transfer direction is active. */
    const gotoSelected = () => {
        if (selectedHref === null) {
            return;
        }
        void navigate({
            to: selectedHref,
            search: {},
        });
    };

    /** Endpoint edits make previous comparisons and terminal transfer reports misleading. */
    const resetFeedback = () => {
        setConfirmationOperation(null);
        setPendingOperation(null);
        prepareTransferMutation.reset();
        transferMutation.reset();
        diffMutation.reset();
    };

    /** Keeps agent selection and its dependent results in sync. */
    const changeSelectedAgent = (agentId: string) => {
        resetFeedback();
        setSelectedAgentId(agentId);
    };

    /** Keeps path selection and its dependent results in sync. */
    const changeSelectedPath = (path: string) => {
        resetFeedback();
        setSelectedPath(path);
    };

    /** Reorders both transfer and comparison endpoints from one explicit choice. */
    const changeDirection = (nextDirection: SyncDirection) => {
        resetFeedback();
        setDirection(nextDirection);
    };

    return {
        availableAgents,
        selectedAgentId,
        selectedPath,
        selectedAgent,
        selectedEndpoint,
        direction,
        changeSelectedAgent,
        changeSelectedPath,
        changeDirection,
        pendingOperation,
        setPendingOperation,
        confirmationOperation,
        setConfirmationOperation,
        selectedHref,
        canDiff: props.entryType === "file",
        transferMutation,
        prepareTransferMutation,
        diffMutation,
        transfer,
        transferQuery,
        transferOperation,
        transferLabel: transferOperation === "move" ? "Move" : "Copy",
        sourceEndpoint,
        destinationEndpoint,
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
        gotoSelected,
    };
}

type SyncWorkspace = ReturnType<typeof useSyncWorkspace>;

/** Keeps the agent name visually distinct from the filesystem path it owns. */
function AgentPath(props: { agentName: string; path: string }) {
    return (
        <span className="break-all">
            <b>{props.agentName}:</b>
            {props.path}
        </span>
    );
}

/** Renders a resolved endpoint, or fallback copy when the peer agent is gone. */
function EndpointPath(props: {
    endpoint: SyncEndpoint | null;
    fallback: string;
}) {
    if (props.endpoint === null) {
        return props.fallback;
    }
    return (
        <AgentPath
            agentName={props.endpoint.agent.name}
            path={props.endpoint.path}
        />
    );
}

/** Stacks long absolute endpoints so the arrow does not hide the target path. */
function SyncDirectionPath(props: {
    from: { agentName: string; path: string };
    to: { agentName: string; path: string };
}) {
    return (
        <span className="grid gap-0.5">
            <AgentPath
                agentName={props.from.agentName}
                path={props.from.path}
            />
            <span className="break-all">
                →{" "}
                <AgentPath
                    agentName={props.to.agentName}
                    path={props.to.path}
                />
            </span>
        </span>
    );
}

/** Makes endpoint order explicit without turning the selected endpoint into the destination. */
function SyncDirectionFields(props: {
    workspace: SyncWorkspace;
    currentAgent: Agent;
    currentPath: string;
}) {
    const workspace = props.workspace;
    const currentPath = {
        agentName: props.currentAgent.name,
        path: props.currentPath,
    };
    const selectedPath = {
        agentName: workspace.selectedAgent?.name ?? "Unavailable agent",
        path: workspace.selectedEndpoint?.path ?? workspace.selectedPath,
    };
    return (
        <RadioCardGroup
            legend="Sync direction"
            description={
                <p className="text-xs text-slate-500">
                    Copy, Move, and Diff follow the selected endpoint order.
                </p>
            }
            disabled={workspace.isBusy}
            legendClassName="text-sm font-medium text-slate-200"
            optionsClassName="md:grid-cols-2"
        >
            <RadioCardOption
                name="sync-direction"
                value="current-to-selected"
                label="Send"
                description={
                    <SyncDirectionPath from={currentPath} to={selectedPath} />
                }
                checked={workspace.direction === "current-to-selected"}
                layout="descriptive"
                onChange={() =>
                    workspace.changeDirection("current-to-selected")
                }
            />
            <RadioCardOption
                name="sync-direction"
                value="selected-to-current"
                label="Receive"
                description={
                    <SyncDirectionPath from={selectedPath} to={currentPath} />
                }
                checked={workspace.direction === "selected-to-current"}
                layout="descriptive"
                onChange={() =>
                    workspace.changeDirection("selected-to-current")
                }
            />
        </RadioCardGroup>
    );
}

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

/** Keeps transfer and comparison actions in one toolbar without bloating the page. */
function SyncActionBar(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    const sourcePath = (
        <EndpointPath
            endpoint={workspace.sourceEndpoint}
            fallback="the unavailable selected endpoint"
        />
    );
    const destinationPath = (
        <EndpointPath
            endpoint={workspace.destinationEndpoint}
            fallback="the unavailable selected endpoint"
        />
    );
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Tooltip
                content={
                    <>
                        Copy {sourcePath} to {destinationPath}
                    </>
                }
            >
                <Button
                    type="button"
                    size="lg"
                    disabled={workspace.isBusy || !workspace.selectedAgentId}
                    isLoading={workspace.copyInFlight}
                    onClick={() => workspace.setConfirmationOperation("copy")}
                    className="rounded-md text-sm font-medium"
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
            <Tooltip
                content={
                    <>
                        Move {sourcePath} to {destinationPath}
                    </>
                }
            >
                <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    disabled={workspace.isBusy || !workspace.selectedAgentId}
                    isLoading={workspace.moveInFlight}
                    onClick={() => workspace.setConfirmationOperation("move")}
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
                <Tooltip
                    content={
                        <>
                            Compare {sourcePath} with {destinationPath}
                        </>
                    }
                >
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
            {workspace.isActive ? (
                <span role="status" className="text-sm text-slate-400">
                    {formatSize(workspace.transfer?.transferred_bytes ?? 0)}{" "}
                    transferred
                    {(workspace.transfer?.total_bytes ?? 0) > 0
                        ? ` of ${formatSize(workspace.transfer?.total_bytes ?? 0)}`
                        : ""}{" "}
                    from {sourcePath} to {destinationPath}
                </span>
            ) : null}
        </div>
    );
}

/** Reports transfer completion separately so a later Diff result can stay on screen. */
function SyncTransferStatus(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    if (workspace.transfer?.state === "completed") {
        const sourcePath = (
            <EndpointPath
                endpoint={workspace.sourceEndpoint}
                fallback="unknown source"
            />
        );
        const destinationPath = (
            <EndpointPath
                endpoint={workspace.destinationEndpoint}
                fallback="unknown destination"
            />
        );
        return (
            <p
                role="status"
                className="border-t border-slate-800 p-6 text-sm text-emerald-300 md:p-8"
            >
                {workspace.transferLabel} completed successfully.{" "}
                {formatSize(workspace.transfer.transferred_bytes)} transferred
                from {sourcePath} to {destinationPath}.
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
    const confirmationLabel =
        workspace.confirmationOperation === "move" ? "Move" : "Copy";
    const sourcePath = (
        <EndpointPath
            endpoint={workspace.sourceEndpoint}
            fallback="the unavailable selected endpoint"
        />
    );
    const destinationPath = (
        <EndpointPath
            endpoint={workspace.destinationEndpoint}
            fallback="the unavailable selected endpoint"
        />
    );

    return (
        <DetailCard>
            <header className="border-b border-slate-800 p-6 md:p-8">
                <p className="mb-1 text-xs font-medium text-slate-500">
                    Sync {entryLabel}
                </p>
                <h1 className="break-all text-2xl font-semibold tracking-tight text-slate-50 md:text-3xl">
                    {props.sourcePath.split("/").filter(Boolean).pop() ?? "/"}
                </h1>
                <p className="mt-3 max-w-3xl text-sm text-slate-400">
                    {props.entryType === "file"
                        ? "Choose an absolute path or use ~ for the home directory on a connected agent, then copy, move, or compare in either direction."
                        : "Choose an absolute path or use ~ for the home directory on a connected agent, then copy or move in either direction."}
                </p>
            </header>

            <div className="grid gap-6 p-6 md:p-8">
                <SyncDirectionFields
                    workspace={workspace}
                    currentAgent={props.sourceAgent}
                    currentPath={props.sourcePath}
                />
                <AgentPathFields
                    agents={workspace.availableAgents}
                    agentId={workspace.selectedAgentId}
                    path={workspace.selectedPath}
                    disabled={workspace.isBusy}
                    viewHref={workspace.selectedHref}
                    onAgentChange={workspace.changeSelectedAgent}
                    onPathChange={workspace.changeSelectedPath}
                    onView={workspace.gotoSelected}
                />
                <SyncActionBar workspace={workspace} />
            </div>

            <SyncTransferStatus workspace={workspace} />
            <SyncDiffSection workspace={workspace} />

            <ConfirmationDialog
                isOpen={workspace.confirmationOperation !== null}
                title={`${confirmationLabel} ${entryLabel}?`}
                description={
                    <>
                        {confirmationLabel} from {sourcePath} to{" "}
                        {destinationPath}?
                    </>
                }
                confirmLabel={`Confirm ${confirmationLabel.toLowerCase()}`}
                onClose={() => workspace.setConfirmationOperation(null)}
                onConfirm={() => {
                    if (workspace.confirmationOperation === null) {
                        return;
                    }
                    const operation = workspace.confirmationOperation;
                    workspace.setConfirmationOperation(null);
                    workspace.startTransfer(operation);
                }}
            />

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
        </DetailCard>
    );
}
