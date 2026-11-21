import {
    getRouteApi,
    useMatch,
    useMatchRoute,
    useRouterState,
} from "@tanstack/react-router";
import type { RegisteredRouter } from "@tanstack/react-router";

import type { Agent } from "#ui/api-client";
import { useAgents, useRequiredAgent } from "#ui/use-agents";

/** Route id of the layout that owns every page of one device. */
export const deviceRouteId = "/_app/agents/$deviceName";

const deviceRouteApi = getRouteApi(deviceRouteId);

/**
 * Reads the device id the committed device route resolved from its URL name, so it always
 * agrees with the other data read from the committed matches, such as the browser location.
 * Use it for what describes the page that is on screen. The URL name is never used as an
 * id: after a rename it would point at nothing, or at another device.
 */
export function useDisplayedAgentId(): string | null {
    const agentId = useMatch({
        from: deviceRouteId,
        shouldThrow: false,
        select: (match) => match.loaderData?.deviceId,
    });

    return agentId ?? null;
}

/**
 * Returns the live device a device page was opened for. Every page below the device route
 * uses this instead of the URL name, so a rename or a new device taking the old name can
 * never switch the page to another device. The device route only renders its children while
 * the device exists, so this never throws for them.
 */
export function useRouteAgent(): Agent {
    const deviceId = deviceRouteApi.useLoaderData({
        select: (data) => data.deviceId,
    });

    return useRequiredAgent(deviceId);
}

/**
 * Reloads the routes on screen without resolving the device URL again. A refresh must keep
 * the page on the device it was opened for even when the URL still carries a name that no
 * longer belongs to it, so the device route keeps its resolved id.
 */
export function invalidateDeviceViews(router: RegisteredRouter): Promise<void> {
    return router.invalidate({
        filter: (match) => match.routeId !== deviceRouteId,
    });
}

/**
 * Resolves the device the user is heading to, including a navigation whose loaders are still
 * running, or undefined on application pages and for an unknown name. Use it for controls
 * that must follow a click at once, such as the sidebar highlight and the terminal shortcut:
 * a slow agent would otherwise leave them pointed at the previous device for the length of
 * its loader.
 */
export function useTargetAgent(): Agent | undefined {
    const matchRoute = useMatchRoute();
    const agents = useAgents();
    const displayedAgentId = useDisplayedAgentId();

    // `location` is the latest location, including one whose loaders are still running.
    const selectedDeviceId = useRouterState({
        select: (state) => state.location.state.deviceId,
    });

    const displayedName = useMatch({
        from: deviceRouteId,
        shouldThrow: false,
        select: (match) => match.params.deviceName,
    });

    // The router only exposes a pending location through `pending: true`, which is false
    // while idle, so ask for it first and fall back to the settled location.
    const params =
        matchRoute({
            to: "/agents/$deviceName",
            fuzzy: true,
            pending: true,
        }) || matchRoute({ to: "/agents/$deviceName", fuzzy: true });

    if (!params) {
        return undefined;
    }

    // A link built from a device names it by id (see `deviceRoute`), and the device route
    // resolves that id, so follow it before any name-based guess.
    if (selectedDeviceId !== undefined) {
        return agents.find((agent) => agent.id === selectedDeviceId);
    }

    // The page on screen keeps the device it resolved, even after a rename gave its URL name
    // to another device. Only a navigation to another name is resolved here, the same way the
    // device route's loader is about to resolve it.
    if (params.deviceName === displayedName && displayedAgentId !== null) {
        return agents.find((agent) => agent.id === displayedAgentId);
    }

    return (
        agents.find((agent) => agent.id === params.deviceName) ??
        agents.find((agent) => agent.name === params.deviceName)
    );
}
