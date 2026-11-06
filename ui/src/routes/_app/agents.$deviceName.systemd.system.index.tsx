import { createFileRoute } from "@tanstack/react-router";

import {
    loadSystemdRoute,
    systemdUnitsQueryOptions,
} from "#ui/systemd-queries";
import { useRouteAgent } from "#ui/use-active-agent";
import { SystemdRouteError } from "#ui/components/systemd/systemd-states";
import {
    SystemdUnitList,
    systemdUnitListSearchSchema,
} from "#ui/components/systemd/unit-list";

/** The system manager, shared by the loader and the page so both ask the same manager. */
const SYSTEM_SCOPE = { type: "system" } as const;

export const Route = createFileRoute(
    "/_app/agents/$deviceName/systemd/system/",
)({
    validateSearch: systemdUnitListSearchSchema,
    loader: async ({ context, parentMatchPromise }) => {
        const { agent, overview } = await loadSystemdRoute(
            context,
            parentMatchPromise,
        );

        // Primed without throwing: the page shows a failed list inline with its controls.
        if (overview !== null) {
            await context.queryClient.prefetchQuery(
                systemdUnitsQueryOptions(agent, SYSTEM_SCOPE),
            );
        }
    },
    component: SystemUnitsPage,
    errorComponent: SystemdRouteError,
});

/** Lists the system manager's units; read-only unless the agent runs as root. */
function SystemUnitsPage() {
    const agent = useRouteAgent();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();

    return (
        <SystemdUnitList
            agent={agent}
            scope={SYSTEM_SCOPE}
            search={search}
            onSearchChange={(next) =>
                void navigate({ search: next, replace: true })
            }
        />
    );
}
