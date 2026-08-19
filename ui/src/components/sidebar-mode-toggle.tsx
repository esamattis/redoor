import { Columns2, PanelLeftClose, PanelsLeftRight } from "lucide-react";
import { useAtom } from "jotai";

import { Button } from "#ui/components/button";
import { Tooltip } from "#ui/components/tooltip";
import { sidebarModeAtom, type SidebarMode } from "#ui/side-menu-state";

const sidebarModeOptions = [
    {
        value: "auto",
        label: "Auto",
        icon: Columns2,
        tooltip: "Click to always show the sidebars",
    },
    {
        value: "show",
        label: "Show",
        icon: PanelsLeftRight,
        tooltip: "Click to always hide the sidebars",
    },
    {
        value: "hide",
        label: "Hide",
        icon: PanelLeftClose,
        tooltip: "Click to automatically show the sidebars",
    },
] as const satisfies ReadonlyArray<{
    value: SidebarMode;
    label: string;
    icon: typeof Columns2;
    tooltip: string;
}>;

/** Cycles the persistent-sidebar preference from the application menu. */
export function SidebarModeToggle() {
    const [storedMode, setSidebarMode] = useAtom(sidebarModeAtom);
    const selectedIndex = Math.max(
        0,
        sidebarModeOptions.findIndex((option) => option.value === storedMode),
    );
    const selectedOption =
        sidebarModeOptions[selectedIndex] ?? sidebarModeOptions[0];
    const nextOption =
        sidebarModeOptions[(selectedIndex + 1) % sidebarModeOptions.length] ??
        sidebarModeOptions[0];
    const SelectedIcon = selectedOption.icon;

    /** Advances through Auto, Show, and Hide in the order advertised by the tooltip. */
    const toggleSidebarMode = () => {
        setSidebarMode(nextOption.value);
    };

    return (
        <Tooltip content={selectedOption.tooltip} className="w-full">
            <Button
                type="button"
                variant="subtle"
                aria-label={`Sidebar mode: ${selectedOption.label}`}
                onClick={toggleSidebarMode}
                className="flex w-full items-center justify-start gap-2.5 rounded px-3 py-2.5 text-left text-sm font-normal text-slate-300 hover:bg-white/5 hover:text-slate-100"
            >
                <SelectedIcon
                    className="h-4 w-4 shrink-0 text-slate-400"
                    aria-hidden="true"
                />
                {selectedOption.label}
            </Button>
        </Tooltip>
    );
}
