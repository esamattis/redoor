import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { SystemdOverviewResponse } from "#bindings/SystemdOverviewResponse";
import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdUnitListResponse } from "#bindings/SystemdUnitListResponse";
import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import type { Agent } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    fetchQueryUncancelled,
    loadDeviceRouteAgent,
    queryKeys,
    type QueryContext,
} from "#ui/queries";
import { shouldCheckSystemdAfterSave } from "#ui/utils/systemd-reload-offer";

/**
 * How often unit lists and unit status refresh while they are on screen. Units change state
 * on their own (timers fire, services crash), and systemd pushes nothing to the UI, so a
 * few seconds keeps the page honest without hammering `systemctl`.
 */
const SYSTEMD_POLL_MS = 3000;

/** The overview only changes when linger or a user's session changes, so it can rest longer. */
const SYSTEMD_OVERVIEW_STALE_MS = 10_000;

/**
 * How long unit files and the managers that load a file count as fresh. They change only
 * when files are added, moved or reloaded, so links and the Systemd tab need no polling.
 */
const SYSTEMD_INDEX_STALE_MS = 30_000;

/** Keys a manager in caches and React keys; the same text as its URL segment. */
export function systemdScopeKey(scope: SystemdScope): string {
    return scope.type === "system" ? "system" : `user/${scope.name}`;
}

/**
 * The user a `user/<name>` scope key names, for questions about a file that should ask that
 * user's manager; `undefined` for the system manager or no key.
 */
export function systemdScopeKeyUser(
    scopeKey: string | undefined,
): string | undefined {
    return scopeKey?.startsWith("user/") === true
        ? scopeKey.slice("user/".length)
        : undefined;
}

/**
 * Retries only failures that are not an answer from the server. A 409 "manager not running"
 * or a 501 "no systemd" is the device's real state, so the default three retries would only
 * delay showing it by several seconds.
 */
function retrySystemdRequest(failureCount: number, error: Error): boolean {
    return !(error instanceof ApiError) && failureCount < 2;
}

/** Whether a failure says the device does not run systemd after all. */
export function isSystemdUnsupportedError(error: Error | null): boolean {
    return error instanceof ApiError && error.code === "systemd_unsupported";
}

/** Whether a failure says the user's manager is not running, which linger can fix. */
export function isUserManagerNotRunningError(error: Error | null): boolean {
    return (
        error instanceof ApiError &&
        error.code === "systemd_user_manager_not_running"
    );
}

/** Shares who the agent is to systemd between the systemd routes and their headers. */
export function systemdOverviewQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.systemdOverview(agent.id),
        queryFn: ({ signal }) => agent.systemdOverview({ signal }),
        staleTime: SYSTEMD_OVERVIEW_STALE_MS,
        retry: retrySystemdRequest,
    });
}

/** Lists one manager's units and keeps polling them while the list is visible. */
export function systemdUnitsQueryOptions(agent: Agent, scope: SystemdScope) {
    return queryOptions({
        queryKey: queryKeys.systemdUnits(agent.id, systemdScopeKey(scope)),
        queryFn: ({ signal }) => agent.listSystemdUnits(scope, { signal }),
        refetchInterval: SYSTEMD_POLL_MS,
        retry: retrySystemdRequest,
    });
}

/** Indexes a unit list by name once per answer, for links that resolve unit names. */
function indexUnits(
    response: SystemdUnitListResponse,
): Map<string, SystemdUnitSummary> {
    return new Map(response.units.map((unit) => [unit.name, unit]));
}

/**
 * Resolves unit names of one manager to their files, for links between units such as the
 * service a timer activates. It shares the unit list's cache entry, which is usually there
 * already, and does not poll: unit files rarely move, and a stale link still opens a file.
 */
export function systemdUnitIndexQueryOptions(
    agent: Agent,
    scope: SystemdScope,
) {
    return queryOptions({
        ...systemdUnitsQueryOptions(agent, scope),
        refetchInterval: false,
        staleTime: SYSTEMD_INDEX_STALE_MS,
        select: indexUnits,
    });
}

/**
 * Which managers load a file and as which unit, for the file view's Systemd tab. Without a
 * user it shares the cache entry the editor's reload offer refreshes after each save, so the
 * tab follows a save that turns the file into a unit. `user` comes from the unit list that led to the
 * file: shared root-owned files such as `/usr/lib/systemd/user/*` would otherwise be checked
 * against the owner root's manager instead of that user's.
 */
export function systemdPathStatusQueryOptions(
    agent: Agent,
    path: string,
    user: string | undefined,
) {
    return queryOptions({
        queryKey: queryKeys.systemdPathStatus(agent.id, path, user),
        queryFn: ({ signal }) =>
            agent.systemdPathStatus(path, { user, signal }),
        staleTime: SYSTEMD_INDEX_STALE_MS,
        retry: retrySystemdRequest,
    });
}

/** Reads one unit's status and keeps polling it while the unit page is visible. */
export function systemdUnitQueryOptions(
    agent: Agent,
    scope: SystemdScope,
    unit: string,
) {
    return queryOptions({
        queryKey: queryKeys.systemdUnit(agent.id, systemdScopeKey(scope), unit),
        queryFn: ({ signal }) => agent.systemdUnit(scope, unit, { signal }),
        refetchInterval: SYSTEMD_POLL_MS,
        retry: retrySystemdRequest,
    });
}

/** Refreshes every systemd view of an agent after a change such as an action or a reload. */
export function invalidateSystemdData(
    queryClient: QueryClient,
    agentId: string,
): Promise<void> {
    return queryClient.invalidateQueries({
        queryKey: queryKeys.systemd(agentId),
    });
}

/**
 * Whether the systemd pages can talk to the device at all. Disconnected devices and devices
 * without systemd get an explanation instead, so neither loaders nor pages send requests
 * that can only fail.
 */
export function canUseSystemd(agent: Agent): boolean {
    return (
        agent.status === "connected" && agent.systemd?.status === "available"
    );
}

/**
 * Whether a file may belong to a systemd manager at all: only unit files and drop-ins on a
 * device whose systemd pages can be used, so other files never cost the agent a question.
 */
export function isSystemdFileCandidate(agent: Agent, path: string): boolean {
    return (
        canUseSystemd(agent) && shouldCheckSystemdAfterSave(path, agent.systemd)
    );
}

/**
 * Loads the device and its systemd overview for a systemd route. The overview is null when
 * the device cannot be asked (see `canUseSystemd`); the layout then explains why. Every
 * systemd loader goes through this so each of them can redirect from the overview without
 * waiting for the layout's component.
 */
export async function loadSystemdRoute(
    context: QueryContext,
    parentMatchPromise: Promise<{ loaderData?: { deviceId: string } }>,
): Promise<{ agent: Agent; overview: SystemdOverviewResponse | null }> {
    const agent = await loadDeviceRouteAgent(context, parentMatchPromise);

    if (!canUseSystemd(agent)) {
        return { agent, overview: null };
    }

    const overview = await fetchQueryUncancelled(
        context.queryClient,
        systemdOverviewQueryOptions(agent),
    );

    return { agent, overview };
}
