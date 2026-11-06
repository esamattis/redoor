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
import { UserManagerHeader } from "#ui/components/systemd/user-manager";

export const Route = createFileRoute(
    "/_app/agents/$deviceName/systemd/user/$user/",
)({
    validateSearch: systemdUnitListSearchSchema,
    loader: async ({ context, params, parentMatchPromise }) => {
        const { agent, overview } = await loadSystemdRoute(
            context,
            parentMatchPromise,
        );

        // Primed without throwing: a manager that is not running is shown inline with the
        // offer to enable linger.
        if (overview !== null) {
            await context.queryClient.prefetchQuery(
                systemdUnitsQueryOptions(agent, {
                    type: "user",
                    name: params.user,
                }),
            );
        }
    },
    component: UserUnitsPage,
    errorComponent: SystemdRouteError,
});

/** Lists one user's units under that user's linger state. */
function UserUnitsPage() {
    const agent = useRouteAgent();
    const params = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();

    return (
        <SystemdUnitList
            key={params.user}
            agent={agent}
            scope={{ type: "user", name: params.user }}
            header={<UserManagerHeader agent={agent} user={params.user} />}
            search={search}
            onSearchChange={(next) =>
                void navigate({ search: next, replace: true })
            }
        />
    );
}
