import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadSystemdRoute } from "#ui/systemd-queries";
import { useRouteAgent } from "#ui/use-active-agent";
import { SystemdRouteError } from "#ui/components/systemd/systemd-states";
import { SystemdUsersList } from "#ui/components/systemd/users-list";

export const Route = createFileRoute("/_app/agents/$deviceName/systemd/user/")({
    /**
     * Only a root agent can reach other users' managers, so any other agent goes straight to
     * its own user's page instead of a list with one entry.
     */
    loader: async ({ context, params, parentMatchPromise }) => {
        const { overview } = await loadSystemdRoute(
            context,
            parentMatchPromise,
        );

        if (overview !== null && !overview.is_root) {
            throw redirect({
                to: "/agents/$deviceName/systemd/user/$user",
                params: {
                    deviceName: params.deviceName,
                    user: overview.username,
                },
                replace: true,
            });
        }
    },
    component: UsersPage,
    errorComponent: SystemdRouteError,
});

/** Lists every user manager a root agent can manage. */
function UsersPage() {
    const agent = useRouteAgent();

    return <SystemdUsersList agent={agent} />;
}
