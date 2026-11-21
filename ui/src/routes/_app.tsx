import { createFileRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "#ui/components/shell/app-shell";
import {
    agentsQueryOptions,
    fetchQueryUncancelled,
    serverInfoQueryOptions,
    terminalSessionsQueryOptions,
    transfersQueryOptions,
} from "#ui/queries";
import { userStateQueryOptions } from "#ui/user-state";

/**
 * Layout for every authenticated page. Keeping it a pathless route means `/login` and
 * `/migrate` are siblings that never load shell data or render shell chrome, so neither
 * the root nor this loader has to ask which page it is on.
 */
export const Route = createFileRoute("/_app")({
    // TEMPORARY MIGRATION: Gate authenticated shell loads until legacy global state is
    // confirmed into a user workspace, avoiding 503 errors from every shell query. Cached
    // once cleared because a server never returns to pending migration after layout v2. Can
    // be removed after layout v2 adoption.
    beforeLoad: async ({ context, location }) => {
        const migration = await context.queryClient.ensureQueryData({
            queryKey: ["migration-status"],
            queryFn: () => context.api.getMigrationStatus(),
            staleTime: Number.POSITIVE_INFINITY,
        });

        if (migration.pending) {
            throw redirect({
                to: "/migrate",
                search: {
                    redirect: location.href,
                },
            });
        }
    },
    // The shell only primes the cache; components read the same queries, so server events
    // and mutations refresh the UI by invalidating query keys instead of reloading routes.
    loader: async ({ context }) => {
        await Promise.all([
            fetchQueryUncancelled(
                context.queryClient,
                agentsQueryOptions(context.api),
            ),
            fetchQueryUncancelled(
                context.queryClient,
                transfersQueryOptions(context.api),
            ),
            fetchQueryUncancelled(
                context.queryClient,
                serverInfoQueryOptions(context.api),
            ),
            fetchQueryUncancelled(
                context.queryClient,
                userStateQueryOptions(context.api),
            ),
            // Primes the list the terminal tabs are restored from.
            fetchQueryUncancelled(
                context.queryClient,
                terminalSessionsQueryOptions(context.api),
            ),
        ]);
    },
    component: AppShell,
});
