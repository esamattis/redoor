import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

import type { AgentUpgradeJob } from "#bindings/AgentUpgradeJob";
import type { AgentUpgradeStatusResponse } from "#bindings/AgentUpgradeStatusResponse";
import type { Agent } from "#ui/api-client";
import { agentUpgradeQueryOptions, queryKeys } from "#ui/queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import { formatSize } from "#ui/utils/path";
import { Button } from "./button";

/** Whether the server is still working on the upgrade or waiting for the agent to return. */
export function isUpgradeInProgress(job: AgentUpgradeJob | null | undefined) {
    const phase = job?.phase.phase;

    return (
        phase === "preparing" || phase === "uploading" || phase === "restarting"
    );
}

/** One line saying what the upgrade does right now. */
function phaseDescription(job: AgentUpgradeJob): string {
    switch (job.phase.phase) {
        case "preparing":
            return job.source === "running_server"
                ? "Preparing the running server binary"
                : `Fetching the Redoor ${job.target_version} release`;
        case "uploading":
            return `Sending the binary: ${formatSize(job.phase.sent_bytes)} of ${formatSize(job.phase.total_bytes)}`;
        case "restarting":
            return "Waiting for the agent to restart on the new binary";
        case "completed":
            return `The agent now runs Redoor ${job.target_version}.`;
        case "failed":
            return job.phase.error;
    }
}

/** Upload completion in percent, or null outside the upload. */
function uploadPercent(job: AgentUpgradeJob): number | null {
    if (job.phase.phase !== "uploading") return null;

    if (job.phase.total_bytes === 0) return 0;

    return Math.floor((job.phase.sent_bytes / job.phase.total_bytes) * 100);
}

/**
 * Shows the agent's running or last upgrade, which the server runs in the background.
 *
 * It reads the server's record rather than the state of the dialog that started it, so it
 * stays when the device page swaps the details for the lifecycle view while the agent
 * restarts, and after a reload. A finished upgrade stays until it is dismissed, so its
 * outcome is not missed.
 */
export function AgentUpgradeStatus(props: {
    agent: Agent;
    className?: string;
}) {
    const queryClient = useQueryClient();
    const statusQuery = useQuery(agentUpgradeQueryOptions(props.agent));

    const dismissMutation = useMutation({
        mutationFn: () => props.agent.dismissUpgrade(),
        onSuccess: () => {
            const cleared: AgentUpgradeStatusResponse = { job: null };
            queryClient.setQueryData(
                queryKeys.agentUpgrade(props.agent.id),
                cleared,
            );
        },
    });

    const job = statusQuery.data?.job;

    if (!job) return null;

    const inProgress = isUpgradeInProgress(job);
    const failed = job.phase.phase === "failed";
    const percent = uploadPercent(job);

    const title = inProgress
        ? `Upgrading to Redoor ${job.target_version}`
        : failed
          ? `Upgrade to Redoor ${job.target_version} failed`
          : `Upgraded to Redoor ${job.target_version}`;

    return (
        <div className={props.className}>
            <section
                aria-label="Agent upgrade"
                aria-live="polite"
                className={cn(
                    "flex flex-col gap-3 rounded-lg border p-4 @xl:flex-row @xl:items-start",
                    failed
                        ? "border-red-800 bg-red-950/20"
                        : "border-slate-800 bg-surface",
                )}
            >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    {inProgress ? (
                        <LoaderCircle
                            className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-blue-400"
                            aria-hidden="true"
                        />
                    ) : failed ? (
                        <CircleAlert
                            className="mt-0.5 h-5 w-5 shrink-0 text-red-400"
                            aria-hidden="true"
                        />
                    ) : (
                        <CircleCheck
                            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400"
                            aria-hidden="true"
                        />
                    )}
                    <div className="min-w-0 flex-1 space-y-2">
                        <p className="font-medium text-slate-200">{title}</p>
                        <p
                            className={cn(
                                "text-sm break-words",
                                failed ? "text-red-300" : "text-slate-400",
                            )}
                        >
                            {phaseDescription(job)}
                        </p>
                        {percent !== null ? (
                            <div
                                role="progressbar"
                                aria-label="Upgrade upload"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={percent}
                                className="h-2 overflow-hidden rounded-full bg-slate-800"
                            >
                                <div
                                    className="h-full bg-blue-500 transition-[width]"
                                    style={{ width: `${percent}%` }}
                                />
                            </div>
                        ) : null}
                        {dismissMutation.isError ? (
                            <p className="text-sm text-red-300">
                                {getErrorMessage(
                                    dismissMutation.error,
                                    "Dismissing the upgrade failed",
                                )}
                            </p>
                        ) : null}
                    </div>
                </div>
                {inProgress ? null : (
                    <Button
                        type="button"
                        variant="secondary"
                        tooltip="Hide this upgrade result"
                        disabled={dismissMutation.isPending}
                        onClick={() => dismissMutation.mutate()}
                        className="self-start"
                    >
                        Dismiss
                    </Button>
                )}
            </section>
        </div>
    );
}
