import { atom } from "jotai";

/** Identifies which edge menu the shell should present as a drawer. */
export type SideMenuId = "application" | "agents";

/** Shares drawer requests so in-page controls can open the same side menus as the top bar. */
export const openSideMenuAtom = atom<SideMenuId | null>(null);
