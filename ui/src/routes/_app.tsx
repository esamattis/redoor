import { createFileRoute } from "@tanstack/react-router";

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
 * Layout for every authenticated page. Keeping it a pathless route means `/login` is a
 * sibling that never loads shell data or renders shell chrome, so neither the root nor this
 * loader has to ask which page it is on.
 */
export const Route = createFileRoute("/_app")({
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
