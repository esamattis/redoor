import { atom } from "jotai";
import { atomWithLocalStorage } from "./utils/local-storage-atom";

export type AgentTabLocations = Record<string, string>;

/** Keeps every agent tab's last route available across switches and reloads. */
export const agentTabLocationsAtom = atomWithLocalStorage<AgentTabLocations>(
    "redoor.agent-tab-locations",
    {},
);

/** Records one route without replacing remembered locations for other agents. */
export const rememberAgentTabLocationAtom = atom(
    null,
    (
        get,
        set,
        location: {
            agentId: string;
            pathname: string;
        },
    ) => {
        const locations = get(agentTabLocationsAtom);
        if (locations[location.agentId] === location.pathname) {
            return;
        }

        set(agentTabLocationsAtom, {
            ...locations,
            [location.agentId]: location.pathname,
        });
    },
);

/**
 * Uses a remembered route only when it still belongs to the requested agent,
 * preventing malformed localStorage data from making one tab open another.
 */
export function getAgentTabLocation(
    locations: AgentTabLocations,
    agentId: string,
    fallback: string,
): string {
    const rememberedLocation = locations[agentId];
    const agentPrefix = `/agents/${encodeURIComponent(agentId)}`;
    if (
        rememberedLocation === agentPrefix ||
        rememberedLocation?.startsWith(`${agentPrefix}/`)
    ) {
        return rememberedLocation;
    }

    return fallback;
}
