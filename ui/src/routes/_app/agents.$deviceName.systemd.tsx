import { createFileRoute, Outlet } from "@tanstack/react-router";

import { loadSystemdRoute } from "#ui/systemd-queries";
import { useRouteAgent } from "#ui/use-active-agent";
import {
    SystemdBlockedState,
    SystemdRouteError,
    systemdBlock,
} from "#ui/components/systemd/systemd-states";
import { SystemdLayout } from "#ui/components/systemd/systemd-layout";

export const Route = createFileRoute("/_app/agents/$deviceName/systemd")({
    loader: async ({ context, parentMatchPromise }) => {
        const { agent } = await loadSystemdRoute(context, parentMatchPromise);

        // The child routes read the device id from this route's data, the way device pages
        // read it from the device route.
        return { deviceId: agent.id };
    },
    component: SystemdRoute,
    errorComponent: SystemdRouteError,
});

/**
 * Explains a device the systemd pages cannot talk to, instead of rendering pages whose every
 * request would fail. It re-renders from the live device, so a disconnect while the page is
 * open replaces the page with the explanation and a reconnect brings it back.
 */
function SystemdRoute() {
    const agent = useRouteAgent();
    const block = systemdBlock(agent);

    if (block) {
        return <SystemdBlockedState agent={agent} block={block} />;
    }

    return (
        <SystemdLayout agent={agent}>
            <Outlet />
        </SystemdLayout>
    );
}
