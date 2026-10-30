import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";

import type { UpgradeProcessReport } from "#bindings/UpgradeProcessReport";
import { serverInfoQueryOptions } from "#ui/queries";
import { useWaitForServerRestart } from "#ui/use-server-restart";
import { getErrorMessage } from "#ui/utils/error";
import { Button } from "./button";
import { ConfirmationDialog } from "./confirmation-dialog";
import { Toast } from "./toast";

const rootRouteApi = getRouteApi("__root__");

/** A local process still running the old binary, and why the update could not restart it. */
type ManualRestart = {
    pid: number;
    command: string;
    reason: string;
};

/** What the toast reports after the replacement server answered. */
type UpdateResult = {
    summary: string;
    manualRestarts: ManualRestart[];
};

/**
 * Picks the processes that keep running the old version until the operator restarts them,
 * with the server's hint or error, so the operator can tell why and which process it is.
 */
function manualRestarts(processes: UpgradeProcessReport[]): ManualRestart[] {
    return processes.flatMap((process) => {
        switch (process.outcome.type) {
            case "left_running":
                return [
                    {
                        pid: process.pid,
                        command: process.command,
                        reason: process.outcome.hint,
                    },
                ];
            case "failed":
                return [
                    {
                        pid: process.pid,
                        command: process.command,
                        reason: process.outcome.error,
                    },
                ];
            case "restarted":
            case "restarting":
                return [];
        }
    });
}

/**
 * Says what the update did, including the local processes it could not restart, since those
 * keep running the old version until the operator restarts them.
 */
function updateResult(update: {
    previousVersion: string;
    version: string | undefined;
    processes: UpgradeProcessReport[];
}): UpdateResult {
    const summary =
        update.version === undefined ||
        update.version === update.previousVersion
            ? `Reinstalled ${update.previousVersion}, which is already the latest release`
            : `Updated the server from ${update.previousVersion} to ${update.version}`;

    const restarts = manualRestarts(update.processes);

    if (restarts.length === 0) {
        return { summary, manualRestarts: restarts };
    }

    const pids = restarts.map((process) => process.pid).join(", ");

    return {
        summary: `${summary}. Restart PID ${pids} manually to run the new version.`,
        manualRestarts: restarts,
    };
}

/**
 * Updates the server to the latest published release. The install runs before anything
 * restarts, so a failed download or an unwritable binary is reported in the dialog while the
 * old server keeps serving; afterwards the dialog waits for the restarted server.
 */
export function ServerUpdateButton(props: {
    /** Version the server runs when the update starts, to tell an update from a reinstall. */
    currentVersion: string;
    /** Where the server binary lives, since the server must be able to replace it. */
    exePath: string;
}) {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const waitForServerRestart = useWaitForServerRestart();
    const [isOpen, setIsOpen] = React.useState(false);
    const [result, setResult] = React.useState<UpdateResult | null>(null);

    const updateMutation = useMutation({
        mutationFn: async () => {
            // Read before the update: the refreshed server info re-renders this component
            // with the new version before the summary is built.
            const previousVersion = props.currentVersion;
            const response = await api.upgradeServer(null);
            await waitForServerRestart();

            const version = queryClient.getQueryData(
                serverInfoQueryOptions(api).queryKey,
            )?.version;

            return { previousVersion, version, processes: response.processes };
        },
        onSuccess: (update) => {
            setIsOpen(false);
            setResult(updateResult(update));
        },
    });

    /** Keeps the dialog up while the update runs, and drops a stale error for the next open. */
    const close = () => {
        if (updateMutation.isPending) return;
        updateMutation.reset();
        setIsOpen(false);
    };

    return (
        <>
            <Button
                type="button"
                variant="subtle"
                tooltip="Install the latest Redoor release and restart the server"
                onClick={() => setIsOpen(true)}
                className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-surface px-2 py-0.5 text-sm font-normal text-slate-200 hover:border-slate-600 hover:bg-tint"
            >
                <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Update
            </Button>
            <ConfirmationDialog
                isOpen={isOpen}
                title="Update the server?"
                description={
                    <div className="space-y-2">
                        <p>
                            Downloads the latest Redoor release and replaces{" "}
                            <code className="font-mono break-all text-slate-200">
                                {props.exePath}
                            </code>
                            . The server and the local agents and relays running
                            that binary then restart in place.
                        </p>
                        <p>
                            In-flight transfers and terminals are interrupted.
                            The server needs write access to that directory.
                        </p>
                    </div>
                }
                confirmLabel="Update"
                busyLabel="Updating..."
                isBusy={updateMutation.isPending}
                errorMessage={
                    updateMutation.isError
                        ? getErrorMessage(updateMutation.error, "Update failed")
                        : null
                }
                onClose={close}
                onConfirm={() => updateMutation.mutate()}
            />
            {result ? (
                <Toast tone="success" onDismiss={() => setResult(null)}>
                    <p>{result.summary}</p>
                    {result.manualRestarts.length > 0 ? (
                        <ul
                            aria-label="Processes to restart manually"
                            className="mt-2 max-w-xl space-y-2"
                        >
                            {result.manualRestarts.map((process) => (
                                <li key={process.pid}>
                                    <code
                                        title={process.command}
                                        className="block truncate font-mono text-xs text-slate-300"
                                    >
                                        {process.pid}: {process.command}
                                    </code>
                                    <span className="block text-xs text-slate-400">
                                        {process.reason}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </Toast>
            ) : null}
        </>
    );
}
