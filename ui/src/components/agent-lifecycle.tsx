import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { HardDrive, LoaderCircle, Play, Power } from "lucide-react";

import type { Agent } from "#ui/api-client";
import { agentStartStatesAtom } from "#ui/agent-start-state";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { FoldingSection } from "#ui/components/folding-section";
import { Tooltip } from "#ui/components/tooltip";
import { queryKeys } from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import { retryAgentStart, startAgent } from "#ui/vault/ssh-key-vault";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    formatAgentRecency,
    formatElapsedSecsMs,
    provisioningElapsedFromStartMs,
    provisioningElapsedTooltip,
    provisioningStepElapsedMs,
    useNow,
} from "#ui/utils/agent-time";

const rootRouteApi = getRouteApi("__root__");

/**
 * What a device page presents, which is not always the server status: a start request is
 * shown as connecting before the server reports it, so a fast local registration cannot skip
 * the visible starting step. `idle` covers both stopped and disconnected devices.
 */
export type AgentLifecyclePhase =
    "connected" | "connecting" | "stopping" | "idle";

/**
 * Derives the phase from the live status and the optimistic start state, so the header,
 * the controls and the messages of one page never disagree about where the device is.
 */
export function useAgentLifecyclePhase(agent: Agent): AgentLifecyclePhase {
    const startStates = useAtomValue(agentStartStatesAtom);

    if (agent.status === "connected") return "connected";

    if (
        agent.status === "starting" ||
        startStates[agent.id]?.starting === true
    ) {
        return "connecting";
    }

    if (agent.status === "stopping") return "stopping";

    return "idle";
}

/** Short status words for a phase, so every place names the device state the same way. */
export function agentLifecycleLabel(
    phase: AgentLifecyclePhase,
    agent: Agent,
): string {
    switch (phase) {
        case "connected":
            return "Connected";
        case "connecting":
            return "Connecting…";
        case "stopping":
            return "Stopping…";
        case "idle":
            return agent.status === "stopped" ? "Stopped" : "Disconnected";
    }
}

/**
 * Presents the managed lifecycle for a device that is not connected as a full page, where
 * the device's own pages, such as the file browser, wait for it while keeping the
 * destination they were opened for.
 */
export function AgentLifecycle(props: {
    agent: Agent;
    preserveDestination?: boolean;
}) {
    const phase = useAgentLifecyclePhase(props.agent);
    const now = useNow();

    return (
        // Margin auto centers the section only while it fits; flex centering would push
        // tall content above the scroll origin, cutting off the spinner and the buttons.
        <div className="flex h-full overflow-y-auto p-4 @xl:p-8">
            <section
                aria-live="polite"
                className="m-auto w-full min-w-0 max-w-xl text-center"
            >
                {phase === "connecting" || phase === "stopping" ? (
                    <LoaderCircle className="mx-auto h-12 w-12 animate-spin text-blue-400" />
                ) : (
                    <HardDrive className="mx-auto h-12 w-12 text-slate-500" />
                )}
                <h1 className="mt-4 text-2xl font-semibold text-slate-100">
                    {phase === "connecting"
                        ? `Connecting ${props.agent.name}`
                        : phase === "stopping"
                          ? `Stopping ${props.agent.name}…`
                          : props.agent.name}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                    {formatAgentRecency(props.agent, now)}
                </p>
                <AgentLifecycleMessages agent={props.agent} className="mt-4" />
                <div className="mt-6 flex justify-center gap-3">
                    <AgentPowerControls
                        agent={props.agent}
                        preserveDestination={props.preserveDestination}
                    />
                </div>
            </section>
        </div>
    );
}

/**
 * Explains what the device is doing while it is not connected: the start steps while it
 * connects, otherwise what the operator can do, followed by the supervisor's diagnostic,
 * the last failed start attempt and the last start request failure. Kept apart from the
 * controls so the device home can place it below its header while the file browser keeps
 * its centered layout.
 */
export function AgentLifecycleMessages(props: {
    agent: Agent;
    className?: string;
}) {
    const phase = useAgentLifecyclePhase(props.agent);
    const startStates = useAtomValue(agentStartStatesAtom);
    const startError = startStates[props.agent.id]?.error ?? null;
    const now = useNow(100);
    const steps = props.agent.provisioningStatus;
    const lastStep = steps.at(-1);

    const lastFailedAttempt =
        phase === "connected" ? null : props.agent.lastFailedAttempt;

    return (
        <div className={cn("space-y-4", props.className)}>
            {phase === "connecting" && steps.length > 0 ? null : (
                <p className="text-slate-400">
                    {lifecycleDescription(phase, props.agent)}
                </p>
            )}
            {/* After a Disconnect the interrupted start's steps stay, so a stuck start can
                still be inspected; they no longer tick once nothing runs them. */}
            {phase !== "connected" && lastStep !== undefined ? (
                <ProvisioningStatusList
                    messages={steps}
                    nowMs={phase === "connecting" ? now : lastStep.at}
                />
            ) : null}
            {/* The failed attempt's error is shown with its steps below. */}
            {props.agent.connectionIssue &&
            props.agent.connectionIssue !== lastFailedAttempt?.error ? (
                <p
                    role="alert"
                    className="whitespace-pre-wrap wrap-anywhere rounded border border-amber-800 bg-amber-950/30 p-3 text-left text-sm text-amber-300"
                >
                    {props.agent.connectionIssue}
                </p>
            ) : null}
            {lastFailedAttempt ? (
                <LastFailedAttempt attempt={lastFailedAttempt} />
            ) : null}
            {startError ? (
                <p
                    role="alert"
                    className="wrap-anywhere rounded border border-red-800 bg-red-950/30 p-3 text-left text-sm text-red-300"
                >
                    {startError}
                </p>
            ) : null}
        </div>
    );
}

/**
 * The steps and error of the latest failed start attempt. The server keeps it across retries
 * and a Disconnect, so the failure can be read after the next retry has already started.
 */
function LastFailedAttempt(props: {
    attempt: NonNullable<Agent["lastFailedAttempt"]>;
}) {
    const [isOpen, setIsOpen] = React.useState(true);

    return (
        <FoldingSection
            title="Last failed attempt"
            tooltip="The start steps and error of the latest start attempt that failed"
            open={isOpen}
            onOpenChange={setIsOpen}
            className="text-left"
        >
            {props.attempt.messages.length > 0 ? (
                <ProvisioningStatusList
                    messages={props.attempt.messages}
                    nowMs={props.attempt.at}
                />
            ) : null}
            <p
                role="alert"
                className="whitespace-pre-wrap wrap-anywhere rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300"
            >
                {props.attempt.error}
            </p>
        </FoldingSection>
    );
}

/** Tells the operator what the phase means and, for unmanaged devices, who has to act. */
function lifecycleDescription(
    phase: AgentLifecyclePhase,
    agent: Agent,
): string {
    switch (phase) {
        case "connected":
            return "The Redoor agent is connected.";
        case "connecting":
            return "The server is waiting for the agent connection.";
        case "stopping":
            return "The server is stopping the Redoor agent on this device and retries until the device answers.";
        case "idle":
            return agent.managed
                ? "This device is disconnected. Connect it to start its Redoor agent."
                : "This device is disconnected. Start the Redoor agent on this device to connect it.";
    }
}

/**
 * The start and stop buttons of a managed device: Connect while it is down, Retry Start and
 * Disconnect while a start is under way, and Disconnect while it is connected. Rendered as
 * bare buttons so each page lays them out among its own actions. Unmanaged devices are
 * started on the device itself, so they get nothing.
 *
 * `preserveDestination` keeps the user on the page they opened, such as a file browser
 * path, instead of redirecting to the device home directory once the agent connects.
 */
export function AgentPowerControls(props: {
    agent: Agent;
    preserveDestination?: boolean;
}) {
    const queryClient = useQueryClient();
    const { api, vault } = rootRouteApi.useRouteContext();
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const phase = useAgentLifecyclePhase(props.agent);
    const [isShutdownOpen, setIsShutdownOpen] = React.useState(false);

    /** Shows the lifecycle change a request caused without waiting for the server event. */
    const refreshAgents = () =>
        queryClient.invalidateQueries({
            queryKey: queryKeys.agents(),
            exact: true,
        });

    const startMutation = useMutation({
        // A device whose SSH key is encrypted with the vault asks for the vault first.
        mutationFn: () => startAgent({ agent: props.agent, api, vault }),
        onMutate: () => {
            setStartStates((states) => ({
                ...states,
                [props.agent.id]: {
                    starting: true,
                    error: null,
                    autoRedirect: props.preserveDestination !== true,
                },
            }));
        },
        onSuccess: refreshAgents,
        onError: (error) => {
            setStartStates((states) => ({
                ...states,
                [props.agent.id]: {
                    starting: false,
                    error: vaultErrorMessage(error, "Failed to start agent"),
                    autoRedirect: props.preserveDestination !== true,
                },
            }));
        },
    });

    const retryMutation = useMutation({
        // A device waiting for its vault-encrypted SSH key asks for the vault first.
        mutationFn: () => retryAgentStart({ agent: props.agent, api, vault }),
        onMutate: () => {
            setStartStates((states) => ({
                ...states,
                [props.agent.id]: {
                    starting: true,
                    error: null,
                    autoRedirect:
                        props.preserveDestination !== true &&
                        (states[props.agent.id]?.autoRedirect ?? true),
                },
            }));
        },
        onSuccess: refreshAgents,
        onError: (error) => {
            setStartStates((states) => ({
                ...states,
                [props.agent.id]: {
                    starting: true,
                    error: vaultErrorMessage(error, "Failed to start agent"),
                    autoRedirect:
                        props.preserveDestination !== true &&
                        (states[props.agent.id]?.autoRedirect ?? true),
                },
            }));
        },
    });

    const shutdownMutation = useMutation({
        mutationFn: () => props.agent.shutdown(),
        onSuccess: async () => {
            setIsShutdownOpen(false);
            setStartStates((states) => {
                const next = { ...states };
                delete next[props.agent.id];

                return next;
            });
            await refreshAgents();
        },
    });

    const shutdownError = shutdownMutation.isError
        ? getErrorMessage(shutdownMutation.error, "Failed to shut down agent")
        : null;

    /** Leaves an in-flight shutdown modal in place until the request settles. */
    const closeShutdown = () => {
        if (shutdownMutation.isPending) return;
        setIsShutdownOpen(false);
        shutdownMutation.reset();
    };

    if (!props.agent.managed) {
        return null;
    }

    const disconnectButton = (
        <Button
            type="button"
            variant="secondary"
            tooltip="Stop the Redoor agent on the device"
            onClick={() => setIsShutdownOpen(true)}
        >
            <Power className="h-4 w-4" aria-hidden="true" />
            Disconnect
        </Button>
    );

    return (
        <>
            {phase === "connecting" ? (
                <>
                    <Button
                        type="button"
                        tooltip="Abandon the current attempt and start the agent again"
                        onClick={() => retryMutation.mutate()}
                        isLoading={retryMutation.isPending}
                    >
                        Retry Start
                    </Button>
                    {disconnectButton}
                </>
            ) : phase === "connected" ? (
                disconnectButton
            ) : (
                <Button
                    type="button"
                    size="lg"
                    tooltip="Start the Redoor agent on the device"
                    onClick={() => startMutation.mutate()}
                    isLoading={startMutation.isPending}
                >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Connect
                </Button>
            )}
            <ConfirmationDialog
                isOpen={isShutdownOpen}
                title={`Disconnect ${props.agent.name}?`}
                description="Stops the Redoor agent on the device and disables automatic reconnection. Active transfers and terminals for this device will end."
                confirmLabel="Disconnect"
                busyLabel="Disconnecting…"
                isBusy={shutdownMutation.isPending}
                errorMessage={shutdownError}
                onClose={closeShutdown}
                onConfirm={() => shutdownMutation.mutate()}
            />
        </>
    );
}

/** Renders accumulated SSH start steps with elapsed time since each row became current. */
export function ProvisioningStatusList(props: {
    messages: Agent["provisioningStatus"];
    nowMs: number;
    className?: string;
}) {
    return (
        <ol
            aria-label="Provisioning status"
            className={cn("space-y-2 text-left", props.className)}
        >
            {props.messages.map((step, index) => {
                const elapsed = formatElapsedSecsMs(
                    provisioningElapsedFromStartMs({
                        messages: props.messages,
                        index,
                        nowMs: props.nowMs,
                    }),
                );

                const sincePrevious = formatElapsedSecsMs(
                    provisioningStepElapsedMs({
                        messages: props.messages,
                        index,
                        nowMs: props.nowMs,
                    }),
                );

                return (
                    <li
                        key={`${step.at}-${index}`}
                        className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm"
                    >
                        <div className="flex items-start gap-3">
                            {/* Long paths and checksums must wrap anywhere, or they widen the list past narrow screens. */}
                            <span className="min-w-0 flex-1 wrap-anywhere text-slate-200">
                                {step.message}
                            </span>
                            <Tooltip
                                className="shrink-0"
                                content={provisioningElapsedTooltip(
                                    sincePrevious,
                                    index,
                                    props.messages.length,
                                )}
                            >
                                <span
                                    aria-label={`${elapsed} from start`}
                                    className="whitespace-nowrap tabular-nums text-slate-500"
                                >
                                    {elapsed}
                                </span>
                            </Tooltip>
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
