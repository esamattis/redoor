import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Ban,
    CirclePower,
    EllipsisVertical,
    Play,
    RefreshCw,
    RotateCcw,
    Square,
    type LucideIcon,
} from "lucide-react";

import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdUnitAction } from "#bindings/SystemdUnitAction";
import type { SystemdUnitDetailsResponse } from "#bindings/SystemdUnitDetailsResponse";
import type { Agent } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import {
    SystemdFeedbackToast,
    systemdFeedback,
    type SystemdFeedback,
} from "#ui/components/systemd/systemd-states";
import { queryKeys } from "#ui/queries";
import { invalidateSystemdData, systemdScopeKey } from "#ui/systemd-queries";
import { useIsContentBelow } from "#ui/utils/use-breakpoint";
import { getErrorMessage } from "#ui/utils/error";
import { unitActionAvailability } from "#ui/utils/systemd-unit-action-availability";

/** Explains every disabled systemd control the same way, since root is the only fix. */
export const REQUIRES_ROOT_TOOLTIP = "Requires the agent to run as root";

/** How each unit action is presented; `verb` reads in toasts such as "Started x". */
type UnitActionInfo = {
    action: SystemdUnitAction;
    label: string;
    verb: string;
    icon: LucideIcon;
    tooltip: string;
    tone: "default" | "danger";
};

const UNIT_ACTIONS: readonly UnitActionInfo[] = [
    {
        action: "start",
        label: "Start",
        verb: "Started",
        icon: Play,
        tooltip: "Start the unit now",
        tone: "default",
    },
    {
        action: "stop",
        label: "Stop",
        verb: "Stopped",
        icon: Square,
        tooltip: "Stop the unit and its processes",
        tone: "danger",
    },
    {
        action: "restart",
        label: "Restart",
        verb: "Restarted",
        icon: RotateCcw,
        tooltip: "Stop and start the unit again",
        tone: "default",
    },
    {
        action: "reload",
        label: "Reload",
        verb: "Reloaded",
        icon: RefreshCw,
        tooltip: "Ask the unit to reload its configuration without stopping",
        tone: "default",
    },
    {
        action: "enable",
        label: "Enable",
        verb: "Enabled",
        icon: CirclePower,
        tooltip: "Start the unit automatically, without starting it now",
        tone: "default",
    },
    {
        action: "disable",
        label: "Disable",
        verb: "Disabled",
        icon: Ban,
        tooltip:
            "Stop starting the unit automatically, without stopping it now",
        tone: "danger",
    },
];

/**
 * Whether an action asks first. Stopping and disabling are the destructive ones; on the unit
 * Redoor itself runs in, restarting also cuts the connection, so it asks too.
 */
function needsConfirmation(
    action: SystemdUnitAction,
    isAgentUnit: boolean,
): boolean {
    return (
        action === "stop" ||
        action === "disable" ||
        (isAgentUnit && action === "restart")
    );
}

/** Describes what a confirmed action will do, with the stronger warning for Redoor's own unit. */
function confirmationText(confirmation: {
    action: SystemdUnitAction;
    unit: string;
    agentName: string;
    isAgentUnit: boolean;
}): string {
    const unit = confirmation.unit;
    const agentName = confirmation.agentName;

    if (confirmation.isAgentUnit) {
        switch (confirmation.action) {
            case "stop":
                return `Redoor itself runs in ${unit}. Stopping it disconnects ${agentName}, and Redoor cannot start it again: you need another way into the device.`;
            case "restart":
                return `Redoor itself runs in ${unit}. Restarting it disconnects ${agentName} until the agent comes back, and if it fails to start you need another way into the device.`;
            case "disable":
                return `Redoor itself runs in ${unit}. Disabled, it no longer starts at boot, so ${agentName} stays disconnected after the next reboot.`;
            default:
                return `Redoor itself runs in ${unit}.`;
        }
    }

    return confirmation.action === "stop"
        ? `Stop ${unit}? Its processes are terminated.`
        : `Disable ${unit}? It no longer starts automatically. A running unit keeps running.`;
}

/**
 * Makes a manager reload its unit files and reports the outcome, so the list button and the
 * unit page's hint share one behaviour.
 */
export function DaemonReloadButton(props: {
    agent: Agent;
    scope: SystemdScope;
    canManage: boolean;
    size?: "sm" | "md";
}) {
    const queryClient = useQueryClient();

    const [feedback, setFeedback] = React.useState<SystemdFeedback | null>(
        null,
    );

    const mutation = useMutation({
        mutationFn: () => props.agent.systemdDaemonReload(props.scope),
        onSuccess: async () => {
            setFeedback(systemdFeedback("success", "Reloaded unit files"));
            await invalidateSystemdData(queryClient, props.agent.id);
        },
        onError: (error) => {
            setFeedback(
                systemdFeedback(
                    "error",
                    getErrorMessage(error, "Daemon reload failed"),
                ),
            );
        },
    });

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                size={props.size ?? "sm"}
                disabled={!props.canManage}
                isLoading={mutation.isPending}
                tooltip={
                    props.canManage
                        ? "Make systemd read changed unit files (daemon-reload)"
                        : REQUIRES_ROOT_TOOLTIP
                }
                onClick={() => mutation.mutate()}
                className="whitespace-nowrap"
            >
                <RefreshCw
                    className={
                        mutation.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"
                    }
                    aria-hidden="true"
                />
                Daemon reload
            </Button>
            <SystemdFeedbackToast
                feedback={feedback}
                onDismiss={() => setFeedback(null)}
            />
        </>
    );
}

/**
 * Runs one unit action and keeps the unit's status in step: the action answers with the
 * status after systemd's job finished, which replaces the cached one at once instead of
 * waiting for the next poll.
 */
function useUnitActionMutation(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    onFeedback: (feedback: SystemdFeedback) => void;
}) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (action: SystemdUnitAction) =>
            props.agent.runSystemdUnitAction(props.scope, props.unit, action),
        onSuccess: async (details, action) => {
            queryClient.setQueryData(
                queryKeys.systemdUnit(
                    props.agent.id,
                    systemdScopeKey(props.scope),
                    props.unit,
                ),
                details,
            );

            const verb =
                UNIT_ACTIONS.find((info) => info.action === action)?.verb ??
                "Changed";

            props.onFeedback(
                systemdFeedback("success", `${verb} ${details.id}`),
            );
            await queryClient.invalidateQueries({
                queryKey: queryKeys.systemdUnits(
                    props.agent.id,
                    systemdScopeKey(props.scope),
                ),
            });
        },
        onError: (error) => {
            props.onFeedback(
                systemdFeedback(
                    "error",
                    getErrorMessage(error, "The unit action failed"),
                ),
            );
        },
    });
}

/**
 * The unit's start, stop, restart, reload, enable and disable actions. Wide columns show
 * them as buttons; a phone-narrow column folds them into one menu so the header keeps its
 * title. Actions that do nothing in the unit's current state (starting a running unit,
 * disabling a disabled one) and actions without permission stay visible but disabled, with
 * the reason in their tooltip, so the controls read as the unit's state.
 */
export function SystemdUnitActions(props: {
    agent: Agent;
    scope: SystemdScope;
    /** The unit name the page was opened with, which keys its cached status. */
    unit: string;
    details: SystemdUnitDetailsResponse;
}) {
    const isNarrow = useIsContentBelow("xl");

    const [feedback, setFeedback] = React.useState<SystemdFeedback | null>(
        null,
    );

    const [pendingConfirmation, setPendingConfirmation] =
        React.useState<SystemdUnitAction | null>(null);

    const mutation = useUnitActionMutation({
        agent: props.agent,
        scope: props.scope,
        unit: props.unit,
        onFeedback: setFeedback,
    });

    const actions = UNIT_ACTIONS.filter(
        (info) => info.action !== "reload" || props.details.can_reload,
    );

    /** Runs an action at once, or asks first for the ones that stop or cut things off. */
    const request = (action: SystemdUnitAction) => {
        if (needsConfirmation(action, props.details.is_agent_unit)) {
            setPendingConfirmation(action);

            return;
        }

        mutation.mutate(action);
    };

    const pendingInfo = UNIT_ACTIONS.find(
        (info) => info.action === pendingConfirmation,
    );

    const disabled = !props.details.can_manage || mutation.isPending;

    /**
     * Why an action's control is inert, or null when it can run. Missing permission wins,
     * because no unit state makes the action possible without root.
     */
    const blockedReason = (action: SystemdUnitAction): string | null => {
        if (!props.details.can_manage) {
            return REQUIRES_ROOT_TOOLTIP;
        }

        const availability = unitActionAvailability(action, props.details);

        return availability.available ? null : availability.reason;
    };

    return (
        <>
            {isNarrow ? (
                <ActionMenu
                    label="Unit actions"
                    icon={
                        <EllipsisVertical
                            className="h-4 w-4"
                            aria-hidden="true"
                        />
                    }
                    disabled={disabled}
                    tooltip={
                        props.details.can_manage
                            ? "Start, stop, enable or disable the unit"
                            : REQUIRES_ROOT_TOOLTIP
                    }
                    className="min-h-11 border border-slate-700"
                >
                    {(close) =>
                        actions.map((info) => {
                            const Icon = info.icon;

                            return (
                                <ActionMenuButton
                                    key={info.action}
                                    tone={info.tone}
                                    disabled={
                                        blockedReason(info.action) !== null
                                    }
                                    onClick={() => {
                                        close();
                                        request(info.action);
                                    }}
                                >
                                    <Icon
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    {info.label}
                                </ActionMenuButton>
                            );
                        })
                    }
                </ActionMenu>
            ) : (
                <div
                    role="group"
                    aria-label="Unit actions"
                    className="flex flex-wrap items-center gap-2"
                >
                    {actions.map((info) => {
                        const Icon = info.icon;
                        const reason = blockedReason(info.action);

                        return (
                            <Button
                                key={info.action}
                                type="button"
                                size="sm"
                                variant={
                                    info.tone === "danger"
                                        ? "danger"
                                        : "secondary"
                                }
                                disabled={disabled || reason !== null}
                                isLoading={
                                    mutation.isPending &&
                                    mutation.variables === info.action
                                }
                                tooltip={reason ?? info.tooltip}
                                onClick={() => request(info.action)}
                            >
                                <Icon className="h-4 w-4" aria-hidden="true" />
                                {info.label}
                            </Button>
                        );
                    })}
                </div>
            )}
            <ConfirmationDialog
                isOpen={pendingInfo !== undefined}
                title={
                    pendingInfo
                        ? `${pendingInfo.label} ${props.details.id}?`
                        : "Confirm"
                }
                description={
                    pendingInfo
                        ? confirmationText({
                              action: pendingInfo.action,
                              unit: props.details.id,
                              agentName: props.agent.name,
                              isAgentUnit: props.details.is_agent_unit,
                          })
                        : ""
                }
                confirmLabel={pendingInfo?.label ?? "Confirm"}
                onClose={() => setPendingConfirmation(null)}
                onConfirm={() => {
                    if (pendingConfirmation !== null) {
                        mutation.mutate(pendingConfirmation);
                    }

                    setPendingConfirmation(null);
                }}
            />
            <SystemdFeedbackToast
                feedback={feedback}
                onDismiss={() => setFeedback(null)}
            />
        </>
    );
}
