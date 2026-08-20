import { atom } from "jotai";
import type { Agent } from "#ui/api-client";

/** Identifies one primary pane in the shared application drawer. */
export type BottomDrawerTabId = "selected" | "transfers" | "terminal";

/** Carries ordered activation requests so only explicit feature actions steal focus. */
export const bottomDrawerActivationAtom = atom<{
    tab: BottomDrawerTabId;
    sequence: number;
}>({ tab: "terminal", sequence: 0 });

/** Requests that the shared drawer reveal a feature after a direct user action. */
export const activateBottomDrawerTabAtom = atom(
    null,
    (get, set, tab: BottomDrawerTabId) => {
        const current = get(bottomDrawerActivationAtom);
        set(bottomDrawerActivationAtom, {
            tab,
            sequence: current.sequence + 1,
        });
    },
);

/** Carries one ordered request for a fresh terminal with optional one-shot input. */
export type TerminalCreationRequest = {
    readonly agent: Agent;
    readonly cwd: string;
    readonly startupCommand: string;
    readonly refreshTarget: BrowserListingRefreshTarget;
};

/** Identifies the exact canonical listing that should reflect command-created entries. */
export type BrowserListingRefreshTarget = {
    readonly agentId: string;
    readonly path: string;
};

/** Queues every creation request until the global terminal owner atomically consumes them. */
export const terminalCreationRequestsAtom = atom<TerminalCreationRequest[]>([]);

/** Appends terminal requests so rapid actions cannot replace an earlier request. */
export const requestTerminalCreationAtom = atom(
    null,
    (_get, set, request: TerminalCreationRequest) => {
        set(terminalCreationRequestsAtom, (current) => [...current, request]);
    },
);

/** Removes and returns queued requests before creating tabs, preventing remount replays. */
export const consumeTerminalCreationRequestsAtom = atom(null, (get, set) => {
    const requests = get(terminalCreationRequestsAtom);
    set(terminalCreationRequestsAtom, []);
    return requests;
});
