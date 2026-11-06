import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, UserRound } from "lucide-react";

import type { SystemdOverviewResponse } from "#bindings/SystemdOverviewResponse";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Tooltip } from "#ui/components/tooltip";
import {
    SystemdFeedbackToast,
    systemdFeedback,
    type SystemdFeedback,
} from "#ui/components/systemd/systemd-states";
import {
    invalidateSystemdData,
    systemdOverviewQueryOptions,
} from "#ui/systemd-queries";
import { getErrorMessage } from "#ui/utils/error";

/** What the overview knows about one account's manager, or null for accounts it does not list. */
function userManagerState(
    overview: SystemdOverviewResponse,
    user: string,
): { linger: boolean; managerRunning: boolean } | null {
    if (user === overview.username) {
        return {
            linger: overview.linger,
            managerRunning: overview.user_manager_running,
        };
    }

    const summary = overview.users.find((entry) => entry.name === user);

    return summary
        ? { linger: summary.linger, managerRunning: summary.manager_running }
        : null;
}

/**
 * Changes one user's linger and reports the outcome. Linger starts or stops the user's
 * manager, so every systemd view of the agent refreshes afterwards.
 */
function useLingerMutation(agent: Agent, user: string) {
    const queryClient = useQueryClient();

    const [feedback, setFeedback] = React.useState<SystemdFeedback | null>(
        null,
    );

    const mutation = useMutation({
        mutationFn: (enabled: boolean) => agent.setSystemdLinger(user, enabled),
        onSuccess: async (response) => {
            setFeedback(
                systemdFeedback(
                    "success",
                    response.linger
                        ? `Linger enabled for ${response.user}`
                        : `Linger disabled for ${response.user}`,
                ),
            );
            await invalidateSystemdData(queryClient, agent.id);
        },
        onError: (error) => {
            setFeedback(
                systemdFeedback(
                    "error",
                    getErrorMessage(error, "Could not change linger"),
                ),
            );
        },
    });

    const toast = (
        <SystemdFeedbackToast
            feedback={feedback}
            onDismiss={() => setFeedback(null)}
        />
    );

    return { mutation, toast };
}

/**
 * Heads a user's units with that user's linger, the one setting that belongs to the user
 * rather than to a unit: with it the manager starts at boot and outlives the last logout.
 */
export function UserManagerHeader(props: { agent: Agent; user: string }) {
    const overviewQuery = useQuery(systemdOverviewQueryOptions(props.agent));
    const linger = useLingerMutation(props.agent, props.user);

    const state = overviewQuery.data
        ? userManagerState(overviewQuery.data, props.user)
        : null;

    return (
        <section
            aria-label={`User ${props.user}`}
            className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-surface px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between"
        >
            <div className="flex min-w-0 items-center gap-3">
                <UserRound
                    className="h-5 w-5 shrink-0 text-blue-400"
                    aria-hidden="true"
                />
                <div className="min-w-0">
                    <h2 className="truncate font-semibold text-slate-100">
                        {props.user}
                    </h2>
                    <p className="text-sm text-slate-400">
                        {state === null
                            ? "Manager state unknown"
                            : state.managerRunning
                              ? "User manager running"
                              : "User manager not running"}
                    </p>
                </div>
            </div>
            <Tooltip
                content={`Start ${props.user}'s manager at boot and keep it running after the last logout`}
            >
                <Checkbox
                    role="checkbox"
                    label="Linger"
                    title={false}
                    checked={state?.linger ?? false}
                    disabled={state === null || linger.mutation.isPending}
                    onCheckedChange={(checked) =>
                        linger.mutation.mutate(checked)
                    }
                    className="min-h-11 self-start px-2 @xl:min-h-0 @xl:self-auto"
                >
                    Linger
                </Checkbox>
            </Tooltip>
            {linger.toast}
        </section>
    );
}

/**
 * Explains a user manager that is not running instead of showing the bus error, and offers
 * the fix: with linger the manager runs without anybody logged in.
 */
export function UserManagerNotRunning(props: { agent: Agent; user: string }) {
    const linger = useLingerMutation(props.agent, props.user);

    return (
        <section
            aria-label="User manager not running"
            className="rounded-lg border border-dashed border-slate-700 bg-slate-900/25 px-6 py-10 text-center"
        >
            <Power
                className="mx-auto h-10 w-10 text-slate-600"
                aria-hidden="true"
            />
            <h2 className="mt-4 font-medium text-slate-200">
                User manager not running
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
                {props.user} has no running systemd user manager, which usually
                means nobody is logged in as {props.user}. Enabling linger
                starts the manager now and at every boot.
            </p>
            <Button
                type="button"
                className="mt-5"
                isLoading={linger.mutation.isPending}
                tooltip={`Start ${props.user}'s manager and keep it running without a login`}
                onClick={() => linger.mutation.mutate(true)}
            >
                Enable linger
            </Button>
            {linger.toast}
        </section>
    );
}
