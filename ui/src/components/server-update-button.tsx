import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { z } from "zod";

import type { UpgradeProcessReport } from "#bindings/UpgradeProcessReport";
import { serverInfoQueryOptions } from "#ui/queries";
import { isReloadingForNewBuild } from "#ui/use-reload-on-server-build-change";
import { useBeginServerRestart } from "#ui/use-server-restart";
import { getErrorMessage } from "#ui/utils/error";
import { Button } from "./button";
import { ConfirmationDialog } from "./confirmation-dialog";
import { TextField } from "./text-field";
import { Toast } from "./toast";

const rootRouteApi = getRouteApi("__root__");

/** A local process still running the old binary, and why the update could not restart it. */
const manualRestartSchema = z.object({
    pid: z.number(),
    command: z.string(),
    reason: z.string(),
});

type ManualRestart = z.infer<typeof manualRestartSchema>;

/**
 * What `updateResult` needs from the update request, kept until the new server answered.
 * It is parsed when read back, since session storage may hold what another build wrote.
 */
const pendingUpdateSchema = z.object({
    previousVersion: z.string(),
    /** Release tag the operator picked, or null for the latest release. */
    requestedTag: z.string().nullable(),
    manualRestarts: z.array(manualRestartSchema),
});

type PendingUpdate = z.infer<typeof pendingUpdateSchema>;

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
 * Turns the typed version into a release tag. Releases are tagged `v<version>` while the UI
 * shows bare versions, so a version starting with a digit gets the prefix; an empty field
 * means the latest release.
 */
function releaseTag(version: string): string | null {
    const trimmed = version.trim();

    if (trimmed === "") return null;

    return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}

/**
 * Says what the update did, including the local processes it could not restart, since those
 * keep running the old version until the operator restarts them.
 */
function updateResult(
    update: PendingUpdate & { version: string | undefined },
): UpdateResult {
    const reinstalled =
        update.version === undefined ||
        update.version === update.previousVersion;

    const summary = !reinstalled
        ? `Updated the server from ${update.previousVersion} to ${update.version}`
        : update.requestedTag === null
          ? `Reinstalled ${update.previousVersion}, which is already the latest release`
          : `Reinstalled ${update.previousVersion}`;

    const restarts = update.manualRestarts;

    if (restarts.length === 0) {
        return { summary, manualRestarts: restarts };
    }

    const pids = restarts.map((process) => process.pid).join(", ");

    return {
        summary: `${summary}. Restart PID ${pids} manually to run the new version.`,
        manualRestarts: restarts,
    };
}

/** Session key holding the update whose result is not shown yet. */
const PENDING_UPDATE_KEY = "redoor:pending-server-update";

/**
 * Keeps the update's outcome across the reload the shell does once the server runs another
 * build, which happens while the dialog still waits for the new server.
 */
function storePendingUpdate(update: PendingUpdate) {
    sessionStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify(update));
}

/** Returns and forgets the update a previous page of this tab started, if any. */
function takePendingUpdate(): PendingUpdate | null {
    const stored = sessionStorage.getItem(PENDING_UPDATE_KEY);
    sessionStorage.removeItem(PENDING_UPDATE_KEY);

    if (stored === null) return null;

    try {
        const parsed = pendingUpdateSchema.safeParse(JSON.parse(stored));

        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * The update a previous page of this tab started, read once per page load so a double
 * render in development cannot consume it before the toast shows it.
 */
let updateFromPreviousPage: PendingUpdate | null | undefined;

/** Reads the previous page's update without forgetting it until it was shown. */
function peekUpdateFromPreviousPage(): PendingUpdate | null {
    updateFromPreviousPage ??= takePendingUpdate();

    return updateFromPreviousPage;
}

/**
 * Updates the server to a published release, the latest unless the operator names a version,
 * so a bad release can be rolled back from the UI. The install runs before anything
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
    const beginServerRestart = useBeginServerRestart();
    const [isOpen, setIsOpen] = React.useState(false);
    const [version, setVersion] = React.useState("");

    // An update to another build reloads the page before the wait ends, so its result
    // arrives here, in the page the reload opened, which already runs the new version.
    const [result, setResult] = React.useState<UpdateResult | null>(() => {
        const pending = peekUpdateFromPreviousPage();

        return pending
            ? updateResult({ ...pending, version: props.currentVersion })
            : null;
    });

    // Shown once: coming back to this page later must not repeat the toast.
    React.useEffect(() => {
        updateFromPreviousPage = null;
    }, []);

    const updateMutation = useMutation({
        mutationFn: async (requestedTag: string | null) => {
            // Read before the update: the refreshed server info re-renders this component
            // with the new version before the summary is built.
            const previousVersion = props.currentVersion;
            const waitForReplacement = beginServerRestart();
            const response = await api.upgradeServer(requestedTag);

            const pending: PendingUpdate = {
                previousVersion,
                requestedTag,
                manualRestarts: manualRestarts(response.processes),
            };

            storePendingUpdate(pending);
            await waitForReplacement();

            // The new build is reloading the page, which shows the stored result; the dialog
            // stays busy until then.
            if (isReloadingForNewBuild()) {
                return new Promise<never>(() => {});
            }

            // This page survived the wait, so it shows the result itself.
            takePendingUpdate();

            const version = queryClient.getQueryData(
                serverInfoQueryOptions(api).queryKey,
            )?.version;

            return { ...pending, version };
        },
        onSuccess: (update) => {
            setIsOpen(false);
            setResult(updateResult(update));
        },
        // A wait that gave up must not show its result on a later page load.
        onError: () => takePendingUpdate(),
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
                tooltip="Install a Redoor release and restart the server"
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
                            Downloads the selected Redoor release, or the latest
                            one when no version is given, and replaces{" "}
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
                onConfirm={() => updateMutation.mutate(releaseTag(version))}
            >
                <TextField
                    label="Version"
                    value={version}
                    placeholder="latest"
                    description="Release such as 2.0.0 to install instead of the latest one."
                    autoComplete="off"
                    disabled={updateMutation.isPending}
                    onChange={setVersion}
                />
            </ConfirmationDialog>
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
