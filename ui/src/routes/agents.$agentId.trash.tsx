import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArchiveRestore, Trash2 } from "lucide-react";

import type { TrashItem } from "#bindings/TrashItem";
import type { TrashListResponse } from "#bindings/TrashListResponse";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RouteError } from "#ui/components/route-error";
import { TextField } from "#ui/components/text-field";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage, joinBrowserPath } from "#ui/components/browser/utils";
import { queryKeys, trashQueryOptions } from "#ui/queries";

type TrashRow = TrashItem & { locationId: string; locationPath: string };

export const Route = createFileRoute("/agents/$agentId/trash")({
    loader: async ({ context, params, parentMatchPromise }) => {
        const agentMatch = await parentMatchPromise;
        const loaderData = agentMatch.loaderData;
        if (!loaderData || loaderData.kind !== "connected") {
            throw redirect({
                to: "/agents/$agentId",
                params: { agentId: params.agentId },
            });
        }
        const agent = loaderData.agent;
        if (!agent.supportsTrash) {
            return { agent, os: loaderData.details.os, trash: null };
        }
        const trash = await context.queryClient.fetchQuery(
            trashQueryOptions(agent),
        );
        return { agent, os: loaderData.details.os, trash };
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

/** Restores one opaque trash item to the user-confirmed destination path. */
function RestoreTrashDialog(props: {
    agent: Agent;
    item: TrashRow | null;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const [destinationPath, setDestinationPath] = React.useState("");
    const mutation = useMutation({
        mutationFn: (item: TrashRow) =>
            props.agent.restoreTrashItem({
                location_id: item.locationId,
                item_id: item.id,
                destination_path: destinationPath.trim(),
            }),
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: queryKeys.trash(props.agent.id),
            });
            props.onClose();
        },
    });

    React.useEffect(() => {
        if (!props.item) return;
        setDestinationPath(props.item.original_path ?? "");
        mutation.reset();
    }, [props.item]);

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

/** Lists all provider locations as one globally newest-first restore queue. */
function TrashPage() {
    const { agent, os, trash: initialTrash } = Route.useLoaderData();
    if (!initialTrash) {
        return (
            <main className="flex h-full items-center justify-center p-6">
                <section className="max-w-lg rounded-lg border border-slate-800 bg-[#11141b] px-8 py-12 text-center">
                    <Trash2
                        className="mx-auto h-10 w-10 text-slate-600"
                        aria-hidden="true"
                    />
                    <h1 className="mt-4 text-xl font-semibold text-slate-100">
                        Trash inventory is not available
                    </h1>
                    <p className="mt-2 text-sm text-slate-400">
                        {agent.supportsMoveToTrash
                            ? `Items can be moved to the native ${os} Trash from file delete dialogs, but Redoor cannot list or restore them here.`
                            : `Trash operations are not available on ${os}. Permanent deletion remains available from file delete dialogs.`}
                    </p>
                </section>
            </main>
        );
    }
    return <TrashInventoryPage agent={agent} initialTrash={initialTrash} />;
}

/** Keeps supported-platform query hooks separate from the static unsupported state. */
function TrashInventoryPage(props: {
    agent: Agent;
    initialTrash: TrashListResponse;
}) {
    const { data: trash } = useQuery({
        ...trashQueryOptions(props.agent),
        initialData: props.initialTrash,
    });
    const [restoreItem, setRestoreItem] = React.useState<TrashRow | null>(null);
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
        <main className="h-full overflow-y-auto p-3 sm:p-5 lg:p-7">
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
                    <span className="shrink-0 text-sm tabular-nums text-slate-500">
                        {items.length} {items.length === 1 ? "item" : "items"}
                    </span>
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
                    <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]">
                        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_10rem_7rem] gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid">
                            <span>Name</span>
                            <span>Original path</span>
                            <span>Deleted</span>
                            <span className="sr-only">Actions</span>
                        </div>
                        {items.map((item) => (
                            <article
                                key={`${item.locationId}:${item.id}`}
                                aria-label={`Trashed item ${item.name}`}
                                className="grid gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_10rem_7rem] md:items-center md:gap-4"
                            >
                                <Link
                                    to={props.agent.getBrowserUrl(
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
                                <Tooltip content={`Restore ${item.name}`}>
                                    <Button
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
                                </Tooltip>
                            </article>
                        ))}
                    </div>
                )}
            </div>
            <RestoreTrashDialog
                agent={props.agent}
                item={restoreItem}
                onClose={() => setRestoreItem(null)}
            />
        </main>
    );
}
