import { atom } from "jotai";

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
