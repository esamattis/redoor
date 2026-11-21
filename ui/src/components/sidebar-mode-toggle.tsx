import { Columns2, PanelLeftClose, PanelsLeftRight } from "lucide-react";
import { useAtom } from "jotai";

import { SegmentedControl } from "#ui/components/segmented-control";
import type { SegmentedControlOption } from "#ui/components/segmented-control";
import { sidebarModeAtom } from "#ui/side-menu-state";
import type { SidebarMode } from "#ui/side-menu-state";

const sidebarModeOptions = [
    {
        value: "auto",
        label: "Auto",
        icon: Columns2,
        tooltip: "Auto: show the sidebars when the window is wide enough",
    },
    {
        value: "show",
        label: "Show",
        icon: PanelsLeftRight,
        tooltip: "Show: always show the sidebars",
    },
    {
        value: "hide",
        label: "Hide",
        icon: PanelLeftClose,
        tooltip: "Hide: always hide the sidebars behind menu buttons",
    },
] as const satisfies ReadonlyArray<SegmentedControlOption<SidebarMode>>;

/**
 * Lets the user pick the persistent-sidebar preference directly from the application menu.
 * It is icon-only so it fits beside the menu title and leaves the column to open files;
 * the tooltips start with the mode name because the icons alone do not say which is which.
 */
export function SidebarModeToggle() {
    const [sidebarMode, setSidebarMode] = useAtom(sidebarModeAtom);

    return (
        <SegmentedControl
            label="Sidebar mode"
            options={sidebarModeOptions}
            value={sidebarMode}
            onChange={setSidebarMode}
            iconOnly
            className="shrink-0"
        />
    );
}
