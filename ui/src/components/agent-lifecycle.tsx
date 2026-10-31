import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { HardDrive, LoaderCircle } from "lucide-react";

import type { Agent } from "#ui/api-client";
import { agentStartStatesAtom } from "#ui/agent-start-state";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Tooltip } from "#ui/components/tooltip";
import { queryKeys } from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import { startAgent } from "#ui/vault/ssh-key-vault";
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

/** Presents explicit managed lifecycle controls while preserving pending filesystem destinations. */
export function AgentLifecycle(props: {
    agent: Agent;
    preserveDestination?: boolean;
}) {
    const queryClient = useQueryClient();
    const { api, vault } = rootRouteApi.useRouteContext();
    const startStates = useAtomValue(agentStartStatesAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const state = startStates[props.agent.id];
    const now = useNow(100);
    const [isShutdownOpen, setIsShutdownOpen] = React.useState(false);

    const shouldAppearStarting =
        props.agent.status === "starting" || state?.starting === true;

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
        mutationFn: () => props.agent.retryStart(),
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
                    error: getErrorMessage(error, "Failed to start agent"),
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

    return (
        // Margin auto centers the section only while it fits; flex centering would push
        // tall content above the scroll origin, cutting off the spinner and the buttons.
        <div className="flex h-full overflow-y-auto p-4 @xl:p-8">
            <section
                aria-live="polite"
                className="m-auto w-full min-w-0 max-w-xl text-center"
            >
                {shouldAppearStarting ? (
                    <LoaderCircle className="mx-auto h-12 w-12 animate-spin text-blue-400" />
                ) : (
                    <HardDrive className="mx-auto h-12 w-12 text-slate-500" />
                )}
                <h1 className="mt-4 text-2xl font-semibold text-slate-100">
                    {shouldAppearStarting
                        ? `Connecting ${props.agent.name}`
                        : props.agent.name}
                </h1>
                {shouldAppearStarting &&
                props.agent.provisioningStatus.length > 0 ? (
                    <ProvisioningStatusList
                        className="mt-4"
                        messages={props.agent.provisioningStatus}
                        nowMs={now}
                    />
                ) : (
                    <p className="mt-2 text-slate-400">
                        {shouldAppearStarting
                            ? "The server is waiting for the agent connection."
                            : props.agent.managed
                              ? "This device is disconnected. Connect it to start its Redoor agent."
                              : "This device is disconnected. Start the Redoor agent on this device to connect it."}
                    </p>
                )}
                <p className="mt-2 text-sm text-slate-500">
                    {formatAgentRecency(props.agent, now)}
                </p>
                {props.agent.connectionIssue ? (
                    <p
                        role="alert"
                        className="mt-4 whitespace-pre-wrap wrap-anywhere rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300"
                    >
                        {props.agent.connectionIssue}
                    </p>
                ) : null}
                {state?.error ? (
                    <p
                        role="alert"
                        className="mt-4 wrap-anywhere rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-300"
                    >
                        {state.error}
                    </p>
                ) : null}
                {props.agent.managed ? (
                    <div className="mt-6 flex justify-center gap-3">
                        {shouldAppearStarting ? (
                            <>
                                <Button
                                    type="button"
                                    onClick={() => retryMutation.mutate()}
                                    isLoading={retryMutation.isPending}
                                >
                                    Retry Start
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setIsShutdownOpen(true)}
                                >
                                    Disconnect
                                </Button>
                            </>
                        ) : (
                            <Button
                                type="button"
                                onClick={() => startMutation.mutate()}
                                isLoading={startMutation.isPending}
                            >
                                Connect
                            </Button>
                        )}
                    </div>
                ) : null}
                <ConfirmationDialog
                    isOpen={isShutdownOpen}
                    title={`Disconnect ${props.agent.name}?`}
                    description="Stops the Redoor agent and disables automatic reconnection. Active transfers and terminals for this device will be interrupted."
                    confirmLabel="Disconnect"
                    busyLabel="Disconnecting…"
                    isBusy={shutdownMutation.isPending}
                    errorMessage={shutdownError}
                    onClose={closeShutdown}
                    onConfirm={() => shutdownMutation.mutate()}
                />
            </section>
        </div>
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
