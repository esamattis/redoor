import * as React from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";

import { useIsBelowBreakpoint } from "#ui/utils/use-breakpoint";
import { atomWithSessionStorage } from "#ui/utils/local-storage-atom";

/** Identifies which edge menu the shell should present as a drawer. */
export type SideMenuId = "application" | "agents";

/** Shares drawer requests so in-page controls can open the same side menus as the top bar. */
export const openSideMenuAtom = atom<SideMenuId | null>(null);

/**
 * Names each menu's drawer element once, so the menu and the controls that open it agree on
 * the `aria-controls` target.
 */
export const sideMenuDrawerIds = {
    application: "application-menu-drawer",
    agents: "agent-menu-drawer",
} satisfies Record<SideMenuId, string>;

/** Lets menu content dismiss its own drawer after navigation without receiving callbacks. */
export function useCloseSideMenu(): () => void {
    const setOpenMenu = useSetAtom(openSideMenuAtom);

    return React.useCallback(() => setOpenMenu(null), [setOpenMenu]);
}

/** Keeps bookmark folding consistent between the sidebar and drawer across tab reloads. */
export const foldedBookmarkAgentsAtom = atomWithSessionStorage<string[]>(
    "redoor.folded-bookmark-agents",
    [],
);

export type SidebarMode = "auto" | "show" | "hide";

/** Remembers the tab's layout choice without affecting other windows. */
export const sidebarModeAtom = atomWithSessionStorage<SidebarMode>(
    "redoor.sidebar-mode",
    "auto",
);

/**
 * Starting width of each edge. The application menu starts wider because open file names
 * share its width with the navigation rail, and the names are what the user scans for.
 */
export const defaultSidebarWidths = { left: 260, right: 224 };

/** Remembers each edge's preferred width independently across navigation and tab reloads. */
export const sidebarWidthsAtom = atomWithSessionStorage(
    "redoor.sidebar-widths",
    defaultSidebarWidths,
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

/**
 * Share of the application menu's file column given to the open files when changed files are
 * listed below them, as a percentage. Null until the user drags the split, so the open files
 * first take only the room their rows need.
 */
export const sidebarFilesSplitAtom = atomWithSessionStorage<number | null>(
    "redoor.sidebar-files-split",
    null,
);
