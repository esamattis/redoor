import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    Copy,
    FolderInput,
    GitCompareArrows,
    LoaderCircle,
    RefreshCw,
} from "lucide-react";
import type { ApiClient, Agent } from "#ui/api-client";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import { browserRoute } from "#ui/browser-route";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { InputControl } from "#ui/components/input-control";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { Select } from "#ui/components/select";
import { Tooltip } from "#ui/components/tooltip";
import { ViewCardHeader } from "#ui/components/view-card-header";
import { DestinationConflictDialog } from "#ui/components/browser/destination-conflict";
import { UnifiedDiff } from "#ui/components/browser/unified-diff";
import {
    GitDiffList,
    type GitDiffListFile,
} from "#ui/components/browser/git-diff-list";
import { getPathLoadError } from "#ui/components/browser/utils";
import {
    WATCHED_TRANSFER_POLL_MS,
    watchedTransfersQueryOptions,
} from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import { isLsDirectoryResponse } from "#ui/ls-response";
import {
    expandHomePath,
    formatSize,
    getBaseName,
    replaceBaseName,
} from "#ui/utils/path";

/** Names the destination a "view" link opens, so the router builds a real, typed link. */
type ViewTarget = { agent: Agent; path: string };

/** Reuses the agent and path controls for cross-agent file operations. */
function AgentPathFields(props: {
    agents: Array<Agent>;
    agentId: string;
    path: string;
    disabled: boolean;
    viewTarget: ViewTarget | null;
    onAgentChange: (agentId: string) => void;
    onPathChange: (path: string) => void;
}) {
    return (
        <div className="grid items-end gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
            <label className="grid gap-2 text-sm font-medium text-slate-200">
                Device
                <Select
                    aria-label="Sync device"
                    value={props.agentId}
                    onChange={(event) =>
                        props.onAgentChange(event.target.value)
                    }
                    disabled={props.disabled}
                    containerClassName="block"
                    className="h-11 rounded-lg bg-slate-950 focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {props.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                            {agent.name}
                        </option>
                    ))}
                </Select>
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
            <Tooltip content="Open the selected device and path">
                {props.viewTarget === null ? (
                    <span
                        aria-disabled="true"
                        className="pb-3 text-sm font-medium text-slate-600"
                    >
                        view
                    </span>
                ) : (
                    <Link
                        {...browserRoute(
                            props.viewTarget.agent,
                            props.viewTarget.path,
                        )}
                        search={{}}
                        className="pb-3 text-sm font-medium text-blue-400 underline decoration-blue-400/50 underline-offset-4 transition-colors hover:text-blue-300 hover:decoration-blue-300 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                        view
                    </Link>
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

/**
 * 404 means Copy/Move can start immediately; any other failure must stay visible. The type
 * of an existing destination decides whether merging into it is offered.
 */
async function getDestinationEntryType(
    agent: Agent,
    path: string,
): Promise<"file" | "directory" | null> {
    try {
        return isLsDirectoryResponse(await agent.ls(path))
            ? "directory"
            : "file";
    } catch (error) {
        const pathError = getPathLoadError(error);

        if (pathError?.type === "missing") {
            return null;
        }

        throw error;
    }
}

/** An existing destination waiting for the user's conflict choice; its type decides Merge. */
type SyncConflict = {
    operation: TransferOperation;
    destinationEntryType: "file" | "directory";
};

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
              path: expandHomePath(selectedAgent.cwd, selectedPath),
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

/** What a Copy or Move button shows: nothing running, the request being sent, or bytes moving. */
type OperationStatus = "idle" | "starting" | "running";

/** Reports how a finished or failed transfer ended, ready to render as a status line. */
type TransferOutcome =
    | { kind: "completed"; label: string; transferredBytes: number }
    | { kind: "failed"; label: string; message: string };

/**
 * Follows the transfer this view started through the shared transfers query, which server
 * events refresh immediately and a short poll keeps current. Polling stops once the server
 * reports a terminal state.
 */
function useWatchedTransfer(api: ApiClient, requestId: number | null) {
    return useQuery({
        ...watchedTransfersQueryOptions(api),
        enabled: requestId !== null,
        select: (response) =>
            response.transfers.find((entry) => entry.request_id === requestId),
        refetchInterval: (query) => {
            const transfer = query.state.data?.transfers.find(
                (entry) => entry.request_id === requestId,
            );

            return transfer?.state === "completed" ||
                transfer?.state === "errored"
                ? false
                : WATCHED_TRANSFER_POLL_MS;
        },
    });
}

/** Generates the text comparison between the two endpoints, which only files support. */
function useSyncDiff(
    api: ApiClient,
    sourceEndpoint: SyncEndpoint | null,
    destinationEndpoint: SyncEndpoint | null,
) {
    const diffMutation = useMutation({
        mutationFn: () => {
            if (sourceEndpoint === null || destinationEndpoint === null) {
                throw new Error("Selected device is unavailable");
            }

            return api.diffFiles(
                { agent: sourceEndpoint.agent.id, path: sourceEndpoint.path },
                {
                    agent: destinationEndpoint.agent.id,
                    path: destinationEndpoint.path,
                },
            );
        },
    });

    return {
        isPending: diffMutation.isPending,
        errorMessage: diffMutation.isError
            ? getErrorMessage(diffMutation.error, "Failed to generate diff")
            : null,
        unifiedDiff: diffMutation.isSuccess
            ? diffMutation.data.unified_diff
            : null,
        fullContext: diffMutation.isSuccess
            ? diffMutation.data.full_context
            : false,
        run: () => diffMutation.mutate(),
        reset: () => diffMutation.reset(),
    };
}

/** The pieces a transfer can fail in, from checking the destination to reading progress. */
type TransferFailureSources = {
    label: string;
    transfer: TransferProgressEntry | undefined;
    prepareError: Error | null;
    startError: Error | null;
    readError: Error | null;
};

/** Words how the transfer ended, preferring the server's own report over request errors. */
function describeTransferOutcome(
    sources: TransferFailureSources,
): TransferOutcome | null {
    const label = sources.label;

    if (sources.transfer?.state === "completed") {
        return {
            kind: "completed",
            label,
            transferredBytes: sources.transfer.transferred_bytes,
        };
    }

    if (sources.transfer?.state === "errored") {
        return {
            kind: "failed",
            label,
            message: sources.transfer.error ?? `${label} failed`,
        };
    }

    const requestError =
        sources.prepareError ?? sources.startError ?? sources.readError;

    if (requestError === null) {
        return null;
    }

    const fallback =
        sources.readError !== null
            ? `Failed to read ${label.toLowerCase()} progress`
            : sources.prepareError !== null
              ? "Failed to check the destination"
              : `Failed to start ${label.toLowerCase()}`;

    return {
        kind: "failed",
        label,
        message: getErrorMessage(requestError, fallback),
    };
}

/** Keeps destination lookup, transfer progress, and diff out of the page render. */
function useSyncWorkspace(props: {
    api: ApiClient;
    sourceAgent: Agent;
    agents: Array<Agent>;
    sourcePath: string;
    entryType: "file" | "directory";
}) {
    const endpoints = useSyncEndpointSelection(props);
    const { sourceEndpoint, destinationEndpoint, selectedEndpoint } = endpoints;

    // Asking before the request keeps a transfer from starting on a stray click.
    const [confirmationOperation, setConfirmationOperation] =
        React.useState<TransferOperation | null>(null);

    // The destination exists, so the user must choose a conflict policy first.
    const [conflict, setConflict] = React.useState<SyncConflict | null>(null);

    const conflictOperation = conflict?.operation ?? null;

    const transferMutation = useMutation({
        mutationFn: async (request: {
            operation: TransferOperation;
            mode: CopyExistingMode;
            /** Set when the user renamed a conflicting destination within its directory. */
            newName: string | null;
        }) => {
            if (sourceEndpoint === null || destinationEndpoint === null) {
                throw new Error("Selected device is unavailable");
            }

            const destination = {
                agent: destinationEndpoint.agent.id,
                path:
                    request.newName === null
                        ? destinationEndpoint.path
                        : replaceBaseName(
                              destinationEndpoint.path,
                              request.newName,
                          ),
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
        // The operation is only carried as the mutation's variables for `onSuccess`.
        mutationFn: async (_operation: TransferOperation) => {
            if (destinationEndpoint === null) {
                throw new Error("Selected device is unavailable");
            }

            return getDestinationEntryType(
                destinationEndpoint.agent,
                destinationEndpoint.path,
            );
        },
        onSuccess: (destinationEntryType, operation) => {
            if (destinationEntryType === null) {
                transferMutation.mutate({
                    operation,
                    mode: "error",
                    newName: null,
                });

                return;
            }

            setConflict({ operation, destinationEntryType });
        },
    });

    const diff = useSyncDiff(props.api, sourceEndpoint, destinationEndpoint);

    const transferQuery = useWatchedTransfer(
        props.api,
        transferMutation.data?.requestId ?? null,
    );

    const transfer = transferQuery.data;

    // The operation the status line talks about, from the latest stage that knows it.
    const lastOperation =
        transferMutation.data?.operation ??
        transferMutation.variables?.operation ??
        prepareTransferMutation.variables ??
        conflictOperation;

    const label = lastOperation === "move" ? "Move" : "Copy";

    const isRunning =
        transferMutation.isSuccess &&
        transfer?.state !== "completed" &&
        transfer?.state !== "errored" &&
        !transferQuery.isError;

    const preparingOperation = prepareTransferMutation.isPending
        ? prepareTransferMutation.variables
        : null;

    /** Derives one button's state from whichever stage is working for its operation. */
    const operationStatus = (operation: TransferOperation): OperationStatus => {
        if (
            preparingOperation === operation ||
            (transferMutation.isPending &&
                transferMutation.variables?.operation === operation)
        ) {
            return "starting";
        }

        return isRunning && lastOperation === operation ? "running" : "idle";
    };

    /** Probes the destination so conflict policy is asked only when a path already exists. */
    const startTransfer = (operation: TransferOperation) => {
        if (sourceEndpoint === null || destinationEndpoint === null) {
            return;
        }

        prepareTransferMutation.reset();
        transferMutation.reset();
        prepareTransferMutation.mutate(operation);
    };

    /** Endpoint edits make previous comparisons and terminal transfer reports misleading. */
    const resetFeedback = () => {
        setConfirmationOperation(null);
        setConflict(null);
        prepareTransferMutation.reset();
        transferMutation.reset();
        diff.reset();
    };

    /** Keeps agent selection and its dependent results in sync. */
    const changeSelectedAgent = (agentId: string) => {
        resetFeedback();
        endpoints.setSelectedAgentId(agentId);
    };

    /** Keeps path selection and its dependent results in sync. */
    const changeSelectedPath = (path: string) => {
        resetFeedback();
        endpoints.setSelectedPath(path);
    };

    /** Reorders both transfer and comparison endpoints from one explicit choice. */
    const changeDirection = (nextDirection: SyncDirection) => {
        resetFeedback();
        endpoints.setDirection(nextDirection);
    };

    const isBusy =
        prepareTransferMutation.isPending ||
        transferMutation.isPending ||
        isRunning;

    return {
        availableAgents: endpoints.availableAgents,
        selectedAgentId: endpoints.selectedAgentId,
        selectedPath: endpoints.selectedPath,
        selectedAgent: endpoints.selectedAgent,
        selectedEndpoint,
        direction: endpoints.direction,
        sourceEndpoint,
        destinationEndpoint,
        /** Only a file has a text comparison. */
        canDiff: props.entryType === "file",
        /** The "view" link target, which only exists for an absolute path. */
        viewTarget: selectedEndpoint?.path.startsWith("/")
            ? {
                  agent: selectedEndpoint.agent,
                  path: selectedEndpoint.path,
              }
            : null,
        isBusy,
        operationStatus,
        /** Bytes moved so far, while a transfer is running. */
        progress: isRunning
            ? {
                  transferredBytes: transfer?.transferred_bytes ?? 0,
                  totalBytes: transfer?.total_bytes ?? 0,
              }
            : null,
        transferOutcome: describeTransferOutcome({
            label,
            transfer,
            prepareError: prepareTransferMutation.error,
            startError: transferMutation.error,
            readError: transferQuery.error,
        }),
        diff,
        confirmationOperation,
        requestConfirmation: setConfirmationOperation,
        cancelConfirmation: () => setConfirmationOperation(null),
        /** Starts the transfer the user just confirmed. */
        confirmTransfer: () => {
            if (confirmationOperation === null) {
                return;
            }

            setConfirmationOperation(null);
            startTransfer(confirmationOperation);
        },
        conflictOperation,
        conflictDestinationType: conflict?.destinationEntryType ?? null,
        cancelConflict: () => setConflict(null),
        /** Starts the transfer that found an existing destination, with the chosen policy. */
        resolveConflict: (mode: CopyExistingMode, newName: string | null) => {
            if (conflictOperation === null) {
                return;
            }

            setConflict(null);
            transferMutation.mutate({
                operation: conflictOperation,
                mode,
                newName,
            });
        },
        changeSelectedAgent,
        changeSelectedPath,
        changeDirection,
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
        agentName: workspace.selectedAgent?.name ?? "Unavailable device",
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
            optionsClassName="@2xl:grid-cols-2"
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

/**
 * One Copy or Move button, so both operations show the same states: idle, sending the
 * request, and moving bytes. Only the verb, icon and emphasis differ.
 */
function TransferButton(props: {
    operation: TransferOperation;
    status: OperationStatus;
    disabled: boolean;
    tooltip: React.ReactNode;
    onClick: () => void;
}) {
    const isCopy = props.operation === "copy";
    const verb = isCopy ? "Copy" : "Move";
    const progressVerb = isCopy ? "Copying" : "Moving";

    const label =
        props.status === "starting"
            ? `Starting ${verb.toLowerCase()}...`
            : props.status === "running"
              ? `${progressVerb}...`
              : verb;

    return (
        <Button
            tooltip={props.tooltip}
            type="button"
            variant={isCopy ? "primary" : "secondary"}
            size="lg"
            disabled={props.disabled}
            isLoading={props.status !== "idle"}
            onClick={props.onClick}
            className={
                isCopy
                    ? "rounded-md text-sm font-semibold shadow-sm shadow-blue-950/30"
                    : "rounded-md text-sm font-semibold"
            }
        >
            {props.status !== "idle" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : isCopy ? (
                <Copy className="h-4 w-4" />
            ) : (
                <FolderInput className="h-4 w-4" />
            )}
            {label}
        </Button>
    );
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

    const isDisabled = workspace.isBusy || !workspace.selectedAgentId;

    return (
        <div className="flex flex-wrap items-center gap-3">
            <TransferButton
                operation="copy"
                status={workspace.operationStatus("copy")}
                disabled={isDisabled}
                tooltip={
                    <>
                        Copy {sourcePath} to {destinationPath}
                    </>
                }
                onClick={() => workspace.requestConfirmation("copy")}
            />
            <TransferButton
                operation="move"
                status={workspace.operationStatus("move")}
                disabled={isDisabled}
                tooltip={
                    <>
                        Move {sourcePath} to {destinationPath}
                    </>
                }
                onClick={() => workspace.requestConfirmation("move")}
            />
            {workspace.canDiff ? (
                <Button
                    tooltip={
                        <>
                            Compare {sourcePath} with {destinationPath}
                        </>
                    }
                    type="button"
                    variant="secondary"
                    size="lg"
                    disabled={isDisabled || workspace.diff.isPending}
                    isLoading={workspace.diff.isPending}
                    onClick={workspace.diff.run}
                    className="rounded-md text-sm font-semibold"
                >
                    <GitCompareArrows className="h-4 w-4" />
                    {workspace.diff.isPending ? "Generating diff..." : "Diff"}
                </Button>
            ) : null}
            {workspace.progress ? (
                <span role="status" className="text-sm text-slate-400">
                    {formatSize(workspace.progress.transferredBytes)}{" "}
                    transferred
                    {workspace.progress.totalBytes > 0
                        ? ` of ${formatSize(workspace.progress.totalBytes)}`
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
    const outcome = workspace.transferOutcome;

    if (outcome === null) {
        return null;
    }

    if (outcome.kind === "completed") {
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
                className="border-t border-slate-800 p-4 text-sm text-emerald-300 @xl:p-5"
            >
                {outcome.label} completed successfully.{" "}
                {formatSize(outcome.transferredBytes)} transferred from{" "}
                {sourcePath} to {destinationPath}.
            </p>
        );
    }

    return (
        <p
            role="alert"
            className="border-t border-slate-800 p-4 text-sm text-red-300 @xl:p-5"
        >
            {outcome.label} failed: {outcome.message}
        </p>
    );
}

/** Names an endpoint with its device, since the compared files can be on two devices. */
function endpointName(endpoint: SyncEndpoint | null, fallback: string) {
    return endpoint === null
        ? fallback
        : `${endpoint.agent.name}:${endpoint.path}`;
}

/**
 * Keeps the rendered hunks under the form so Copy/Move chrome stays interactive. The compare
 * is a diff card like every other diff, so it has the same switches in the same place.
 */
function SyncDiffSection(props: { workspace: SyncWorkspace }) {
    const workspace = props.workspace;
    const diff = workspace.diff;
    const unifiedDiff = diff.unifiedDiff;

    if (diff.errorMessage !== null) {
        return (
            <p
                role="alert"
                className="border-t border-slate-800 p-4 text-sm text-red-300 @xl:p-5"
            >
                {diff.errorMessage}
            </p>
        );
    }

    if (unifiedDiff === null) {
        return null;
    }

    const source = endpointName(workspace.sourceEndpoint, "source");

    const destination = endpointName(
        workspace.destinationEndpoint,
        "destination",
    );

    // The two files are on two devices, so the card neither links nor copies a path, and the
    // source is named like the origin of a rename.
    const file: GitDiffListFile = {
        path: destination,
        relativePath: destination,
        originalPath: source,
        change: null,
        link: null,
        regionLabel: "File diff",
        renderBody: (view) => (
            <UnifiedDiff
                unifiedDiff={unifiedDiff}
                fullContext={diff.fullContext}
                mergeModifiedLines={view.mergeModifiedLines}
                wrapLines={view.wrapLines}
                wholeFile={view.wholeFile}
            />
        ),
    };

    return (
        <div className="grid grid-cols-[minmax(0,1fr)] border-t border-slate-800 p-4 @xl:p-5">
            <GitDiffList
                files={[file]}
                scope={`sync:${source}:${destination}`}
            />
        </div>
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
    const conflictLabels = conflictDialogLabels(workspace.conflictOperation);

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
        <BrowserViewCard>
            <ViewCardHeader
                icon={<RefreshCw className="h-5 w-5" aria-hidden="true" />}
                eyebrow={`Sync ${entryLabel}`}
                title={getBaseName(props.sourcePath)}
            >
                <p className="mt-3 max-w-3xl text-sm text-slate-400">
                    {props.entryType === "file"
                        ? "Choose an absolute path or use ~ for the home directory on a connected device, then copy, move, or compare in either direction."
                        : "Choose an absolute path or use ~ for the home directory on a connected device, then copy or move in either direction."}
                </p>
            </ViewCardHeader>

            <div className="grid gap-4 p-4 @xl:p-5">
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
                    viewTarget={workspace.viewTarget}
                    onAgentChange={workspace.changeSelectedAgent}
                    onPathChange={workspace.changeSelectedPath}
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
                onClose={workspace.cancelConfirmation}
                onConfirm={workspace.confirmTransfer}
            />

            {workspace.conflictOperation !== null ? (
                <DestinationConflictDialog
                    title="Destination items already exist"
                    description="The destination path already exists. Choose how to handle the existing destination."
                    closeAriaLabel={conflictLabels.closeAriaLabel}
                    confirmLabel={conflictLabels.confirmLabel}
                    radioGroupName={conflictLabels.radioGroupName}
                    existingName={getBaseName(
                        workspace.destinationEndpoint?.path ?? "",
                    )}
                    entryType={props.entryType}
                    // Merge needs a directory on both sides; this page's entry stands in for
                    // the peer, whose type is not looked up.
                    canMerge={
                        workspace.conflictDestinationType === "directory" &&
                        props.entryType === "directory"
                    }
                    onClose={workspace.cancelConflict}
                    onConfirm={workspace.resolveConflict}
                />
            ) : null}
        </BrowserViewCard>
    );
}
