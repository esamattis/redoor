import { cn } from "#ui/utils/cn";

/** Colours systemd's `ActiveState`, so running, failed and changing units stand apart at a glance. */
function activeStateTone(activeState: string): string {
    switch (activeState) {
        case "active":
        case "reloading":
            return "border-emerald-700/60 bg-emerald-500/10 text-emerald-300";
        case "failed":
            return "border-red-800/70 bg-red-500/10 text-red-300";
        case "activating":
        case "deactivating":
        case "refreshing":
            return "border-amber-700/60 bg-amber-500/10 text-amber-300";
        default:
            return "border-slate-700 bg-slate-800/40 text-slate-400";
    }
}

/**
 * Shows a unit's active state with its type-specific sub state (`active (running)`), the way
 * `systemctl status` words it. Units that are only files on disk are inactive.
 */
export function UnitStateBadge(props: {
    activeState: string | null;
    subState: string | null;
    className?: string;
}) {
    const activeState = props.activeState ?? "inactive";

    const label =
        props.subState !== null && props.subState !== activeState
            ? `${activeState} (${props.subState})`
            : activeState;

    return (
        <span
            aria-label={`State: ${label}`}
            className={cn(
                "inline-flex w-fit max-w-full items-center truncate rounded-full border px-2 py-0.5 text-xs font-medium",
                activeStateTone(activeState),
                props.className,
            )}
        >
            {label}
        </span>
    );
}
