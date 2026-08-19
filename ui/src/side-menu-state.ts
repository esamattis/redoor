import { atom, useAtomValue } from "jotai";

import { useIsBelowBreakpoint } from "#ui/utils/use-breakpoint";
import { atomWithSessionStorage } from "#ui/utils/local-storage-atom";

/** Identifies which edge menu the shell should present as a drawer. */
export type SideMenuId = "application" | "agents";

/** Shares drawer requests so in-page controls can open the same side menus as the top bar. */
export const openSideMenuAtom = atom<SideMenuId | null>(null);

export type SidebarMode = "auto" | "show" | "hide";

/** Remembers the tab's layout choice without affecting other windows. */
export const sidebarModeAtom = atomWithSessionStorage<SidebarMode>(
    "redoor.sidebar-mode",
    "auto",
);

/** Resolves whether both edge menus should occupy layout space instead of drawers. */
export function usePersistentSideMenus(): boolean {
    const mode = useAtomValue(sidebarModeAtom);
    const isBelowLg = useIsBelowBreakpoint("lg");
    if (mode === "show") {
        return true;
    }
    if (mode === "hide") {
        return false;
    }
    return !isBelowLg;
}
