import { createFileRoute, Outlet } from "@tanstack/react-router";

import { agentSearchSchema } from "#ui/agent-search";
import { useReloadUnavailableRoutes } from "#ui/agent-unavailable";
import { useRememberProvisioningStatus } from "#ui/provisioning-status";
import { DeviceNotFound } from "#ui/components/device-not-found";
import { SearchDialog } from "#ui/components/search-dialog";
import { RouteError } from "#ui/components/route-error";
import {
    agentDetailsQueryOptions,
    fetchQueryUncancelled,
    loadAgentByName,
} from "#ui/queries";
import { useAgent } from "#ui/use-agents";

export const Route = createFileRoute("/_app/agents/$deviceName")({
    validateSearch: agentSearchSchema,
    // The URL carries the name because people read and type it. It is resolved to the
    // device id once, when the page is entered; child navigation and refreshes keep that id
    // (see `invalidateDeviceViews`), so a rename elsewhere, or another device taking the old
    // name, cannot move an open page to a different device. The router reloads every stale
    // match when it reloads the same URL, so the resolution never goes stale, and it is
    // dropped as soon as the page is left, so entering the URL again resolves it afresh.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    // A link built from a device carries its id (see `deviceRoute`). Without this the kept
    // resolution would swallow choosing the device that now has this page's old name, and
    // the page would keep acting on the previous device. Links that only know the name
    // carry no id and keep the device the page was opened for.
    shouldReload: ({ location }) =>
        location.state.deviceId === undefined ? undefined : true,
    loader: async ({ context, params, location }) => {
        const agent = await loadAgentByName(
            context,
            location.state.deviceId ?? params.deviceName,
        );

        if (agent.status === "connected") {
            await fetchQueryUncancelled(
                context.queryClient,
                agentDetailsQueryOptions(agent),
            );
        }

        return { deviceId: agent.id };
    },
    component: AgentRouteLayout,
    notFoundComponent: DeviceNameNotFound,
    errorComponent: RouteError,
});

/** Hosts the device's child views and the search dialog that every one of them shares. */
function AgentRouteLayout() {
    const { deviceId } = Route.useLoaderData();
    const { deviceName } = Route.useParams();
    // Looked up by id, so the page follows a rename of its own device and shows "device not
    // found" once that device is deleted instead of switching to whoever takes its name.
    const agent = useAgent(deviceId);

    useRememberProvisioningStatus(agent);
    useReloadUnavailableRoutes(agent);

    if (!agent) {
        return <DeviceNotFound deviceName={deviceName} />;
    }

    return (
        <>
            <Outlet />
            <SearchDialog agent={agent} />
        </>
    );
}

/** Reports a URL name that no known device has, including a child route's id miss. */
function DeviceNameNotFound() {
    const { deviceName } = Route.useParams();

    return <DeviceNotFound deviceName={deviceName} />;
}
