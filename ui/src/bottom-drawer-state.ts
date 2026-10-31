import { atom } from "jotai";
import { z } from "zod";
import { atomWithSessionStorage } from "#ui/utils/local-storage-atom";

/** Identifies one primary pane in the shared application drawer. */
export type BottomDrawerTabId = "selected" | "transfers" | "terminal";

/**
 * Shares drawer visibility so feature buttons can fold an already visible pane. Kept in
 * session storage so a reload puts the drawer back the way this tab left it, without
 * opening it in other windows.
 */
export const bottomDrawerCollapsedAtom = atomWithSessionStorage(
    "redoor.bottom-drawer-collapsed",
    true,
);

/** Identifies which drawer pane a feature toggle would hide, restored with the tab. */
export const bottomDrawerActiveTabAtom =
    atomWithSessionStorage<BottomDrawerTabId>(
        "redoor.bottom-drawer-tab",
        "terminal",
    );

/** Height of the expanded drawer before the user has dragged it. */
export const DEFAULT_BOTTOM_DRAWER_HEIGHT = 400;

/** The stored height; session storage can hold anything, so it is parsed on the way out. */
const storedBottomDrawerHeightAtom = atomWithSessionStorage<unknown>(
    "redoor.bottom-drawer-height",
    DEFAULT_BOTTOM_DRAWER_HEIGHT,
);

/** A broken stored height falls back to the default instead of collapsing the drawer. */
const bottomDrawerHeightSchema = z
    .number()
    .positive()
    .catch(DEFAULT_BOTTOM_DRAWER_HEIGHT);

/** Remembers the dragged drawer height so a reload does not snap it back to the default. */
export const bottomDrawerHeightAtom = atom(
    (get) => bottomDrawerHeightSchema.parse(get(storedBottomDrawerHeightAtom)),
    (_get, set, height: number) => {
        set(storedBottomDrawerHeightAtom, height);
    },
);

/**
 * Reveals a pane after a direct user action by changing the tab and expanding the drawer in
 * one write. The drawer reads the same two atoms, so there is no request to queue and no
 * effect to drain it: the action is the state change.
 */
export const activateBottomDrawerTabAtom = atom(
    null,
    (_get, set, tab: BottomDrawerTabId) => {
        set(bottomDrawerActiveTabAtom, tab);
        set(bottomDrawerCollapsedAtom, false);
    },
);
