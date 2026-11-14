import * as React from "react";
import {
    useMutation,
    useQueryClient,
    useSuspenseQuery,
} from "@tanstack/react-query";
import {
    createFileRoute,
    Link,
    Navigate,
    redirect,
} from "@tanstack/react-router";
import { ArchiveRestore, Trash2 } from "lucide-react";

import type { TrashItem } from "#bindings/TrashItem";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RouteError } from "#ui/components/route-error";
import { TextField } from "#ui/components/text-field";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { getErrorMessage } from "#ui/utils/error";
import {
    agentDetailsQueryOptions,
    fetchQueryUncancelled,
    invalidateAgentData,
    loadDeviceRouteAgent,
    trashQueryOptions,
} from "#ui/queries";
import { useRouteAgent } from "#ui/use-active-agent";
import { browserRoute, deviceRoute } from "#ui/browser-route";

type TrashRow = TrashItem & { locationId: string; locationPath: string };

export const Route = createFileRoute("/_app/agents/$deviceName/trash")({
    loader: async ({ context, params, parentMatchPromise }) => {
        const agent = await loadDeviceRouteAgent(context, parentMatchPromise);

        if (agent.status !== "connected") {
            throw redirect({
                to: "/agents/$deviceName",
                params: { deviceName: params.deviceName },
            });
        }

        await fetchQueryUncancelled(
            context.queryClient,
            agentDetailsQueryOptions(agent),
        );

        if (agent.supportsTrash) {
            await fetchQueryUncancelled(
                context.queryClient,
                trashQueryOptions(agent),
            );
        }
    },
    component: TrashPage,
    errorComponent: RouteError,
});

/** Formats provider timestamps in the browser's locale without hiding exact time. */
function formatDeletedAt(timestampSeconds: number): string {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(timestampSeconds * 1000));
}

/**
 * Restores one opaque trash item to the user-confirmed destination path. The parent keys it by
 * item, so choosing another item mounts a fresh form instead of this dialog resetting its own
 * state when the prop changes.
 */
function RestoreTrashDialog(props: {
    agent: Agent;
    item: TrashRow | null;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();

    const [destinationPath, setDestinationPath] = React.useState(
        props.item?.original_path ?? "",
    );

    const mutation = useMutation({
        mutationFn: (item: TrashRow) =>
            props.agent.restoreTrashItem({
                location_id: item.locationId,
                item_id: item.id,
                destination_path: destinationPath.trim(),
            }),
        onSuccess: async () => {
            // A restored item reappears in listings, not only in the trash inventory.
            await invalidateAgentData(queryClient, props.agent.id);
            props.onClose();
        },
    });

    /** Submits through the form so keyboard and button activation share validation. */
    const restore = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (props.item && destinationPath.trim()) mutation.mutate(props.item);
    };

    return (
        <Dialog
            isOpen={props.item !== null}
            title="Restore trashed item"
            description={
                props.item
                    ? `Choose where ${props.item.name} will be restored.`
                    : "Choose a restore destination."
            }
            closeAriaLabel="Close restore dialog"
            isBusy={mutation.isPending}
            errorMessage={
                mutation.isError
                    ? getErrorMessage(mutation.error, "Restore failed")
                    : null
            }
            onClose={props.onClose}
        >
            <form className="mt-4" onSubmit={restore}>
                <TextField
                    label="Restore path"
                    codeMode
                    value={destinationPath}
                    placeholder="/absolute/path/to/item"
                    description="The parent directory must already exist. Existing files are not replaced."
                    required
                    autoFocus
                    autoComplete="off"
                    disabled={mutation.isPending}
                    onChange={(value) => {
                        setDestinationPath(value);
                        mutation.reset();
                    }}
                />
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={mutation.isPending}
                        onClick={props.onClose}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        isLoading={mutation.isPending}
                        disabled={!destinationPath.trim() || mutation.isPending}
                    >
                        <ArchiveRestore
                            className="h-4 w-4"
                            aria-hidden="true"
                        />
                        {mutation.isPending ? "Restoring..." : "Restore"}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/** Confirms and executes permanent removal of every currently stored trash payload. */
function EmptyTrashDialog(props: {
    agent: Agent;
    itemCount: number;
    isOpen: boolean;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();

    const mutation = useMutation({
        mutationFn: () => props.agent.emptyTrash(),
        onSuccess: async () => {
            await invalidateAgentData(queryClient, props.agent.id);
            props.onClose();
        },
    });

    /** Forgets a failed attempt on close, so reopening never shows a stale error. */
    const close = () => {
        mutation.reset();
        props.onClose();
    };

    return (
        <ConfirmationDialog
            isOpen={props.isOpen}
            title="Empty trash?"
            description={`Permanently delete ${props.itemCount} ${props.itemCount === 1 ? "item" : "items"}. This cannot be undone.`}
            confirmLabel="Empty trash"
            busyLabel="Emptying trash..."
            isBusy={mutation.isPending}
            errorMessage={
                mutation.isError
                    ? getErrorMessage(mutation.error, "Empty trash failed")
                    : null
            }
            onClose={() => {
                if (!mutation.isPending) close();
            }}
            onConfirm={() => mutation.mutate()}
        />
    );
}

/** Leaves the page when the agent disconnects, since trash can only be read from a live agent. */
function TrashPage() {
    const agent = useRouteAgent();

    if (agent.status !== "connected") {
        return <Navigate {...deviceRoute(agent, "/agents/$deviceName")} />;
    }

    return <TrashAvailability agent={agent} />;
}

/** Explains platforms without a restorable trash instead of an empty inventory. */
function TrashAvailability(props: { agent: Agent }) {
    const { data: details } = useSuspenseQuery(
        agentDetailsQueryOptions(props.agent),
    );

    if (!props.agent.supportsTrash) {
        return (
            <main className="flex h-full items-center justify-center p-6">
                <section className="max-w-lg rounded-lg border border-slate-800 bg-surface px-8 py-12 text-center">
                    <Trash2
                        className="mx-auto h-10 w-10 text-slate-600"
                        aria-hidden="true"
                    />
                    <h1 className="mt-4 text-xl font-semibold text-slate-100">
                        Trash inventory is not available
                    </h1>
                    <p className="mt-2 text-sm text-slate-400">
                        {props.agent.supportsMoveToTrash
                            ? `Items can be moved to the native ${details.os} Trash from file delete dialogs, but Redoor cannot list or restore them here.`
                            : `Trash operations are not available on ${details.os}. Permanent deletion remains available from file delete dialogs.`}
                    </p>
                </section>
            </main>
        );
    }

    return <TrashInventoryPage agent={props.agent} />;
}

/** Lists all provider locations as one globally newest-first restore queue. */
function TrashInventoryPage(props: { agent: Agent }) {
    const { data: trash } = useSuspenseQuery(trashQueryOptions(props.agent));

    const [restoreItem, setRestoreItem] = React.useState<TrashRow | null>(null);
    const [isEmptyDialogOpen, setIsEmptyDialogOpen] = React.useState(false);

    const items = trash.locations
        .flatMap((location) =>
            location.items.map((item) => ({
                ...item,
                locationId: location.id,
                locationPath: location.path,
            })),
        )
        .sort(
            (left, right) =>
                right.deleted_at - left.deleted_at ||
                left.id.localeCompare(right.id),
        );

    return (
        <main className="h-full overflow-y-auto p-3 @xl:p-5 @4xl:p-7">
            <div className="mx-auto w-full max-w-6xl">
                <div className="mb-5 flex items-end justify-between gap-4">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {props.agent.name}
                        </p>
                        <h1 className="mt-1 text-2xl font-semibold text-slate-100">
                            Trash
                        </h1>
                        <p className="mt-1 text-sm text-slate-400">
                            Restore files and directories moved from the agent
                            filesystem.
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm tabular-nums text-slate-500">
                            {items.length}{" "}
                            {items.length === 1 ? "item" : "items"}
                        </span>
                        <Button
                            tooltip="Permanently delete every item in trash"
                            type="button"
                            variant="danger"
                            size="sm"
                            disabled={items.length === 0}
                            onClick={() => setIsEmptyDialogOpen(true)}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Empty trash
                        </Button>
                    </div>
                </div>

                {items.length === 0 ? (
                    <section className="rounded-lg border border-dashed border-slate-700 bg-slate-900/25 px-6 py-16 text-center">
                        <Trash2
                            className="mx-auto h-10 w-10 text-slate-600"
                            aria-hidden="true"
                        />
                        <h2 className="mt-4 font-medium text-slate-200">
                            Trash is empty
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Files moved to trash will appear here.
                        </p>
                    </section>
                ) : (
                    <div className="overflow-hidden rounded-lg border border-slate-800 bg-surface">
                        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_10rem_7rem] gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 @2xl:grid">
                            <span>Name</span>
                            <span>Original path</span>
                            <span>Deleted</span>
                            <span className="sr-only">Actions</span>
                        </div>
                        {items.map((item) => (
                            <article
                                key={`${item.locationId}:${item.id}`}
                                aria-label={`Trashed item ${item.name}`}
                                className="grid gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_10rem_7rem] @2xl:items-center @2xl:gap-4"
                            >
                                <Link
                                    {...browserRoute(
                                        props.agent,
                                        joinBrowserPath(
                                            joinBrowserPath(
                                                item.locationPath,
                                                "files",
                                            ),
                                            item.name,
                                        ),
                                    )}
                                    className="min-w-0 truncate font-medium text-blue-300 hover:text-blue-200 hover:underline"
                                >
                                    {item.name}
                                </Link>
                                <span
                                    className="min-w-0 truncate font-mono text-xs text-slate-400"
                                    title={item.original_path ?? undefined}
                                >
                                    {item.original_path ??
                                        "Original path unavailable"}
                                </span>
                                <time
                                    dateTime={new Date(
                                        item.deleted_at * 1000,
                                    ).toISOString()}
                                    className="whitespace-nowrap text-xs text-slate-500"
                                >
                                    {formatDeletedAt(item.deleted_at)}
                                </time>
                                <Button
                                    tooltip={`Restore ${item.name}`}
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setRestoreItem(item)}
                                >
                                    <ArchiveRestore
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    Restore
                                </Button>
                            </article>
                        ))}
                    </div>
                )}
            </div>
            <RestoreTrashDialog
                key={
                    restoreItem
                        ? `${restoreItem.locationId}:${restoreItem.id}`
                        : "none"
                }
                agent={props.agent}
                item={restoreItem}
                onClose={() => setRestoreItem(null)}
            />
            <EmptyTrashDialog
                agent={props.agent}
                itemCount={items.length}
                isOpen={isEmptyDialogOpen}
                onClose={() => setIsEmptyDialogOpen(false)}
            />
        </main>
    );
}
