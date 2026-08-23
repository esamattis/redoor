import { Maximize2, Minimize2 } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";

/** Keeps full-window controls consistent while naming the surface they resize. */
export function FullWindowToggle(props: {
    targetName: string;
    isFullWindow: boolean;
    onToggle: () => void;
}) {
    return (
        <IconButton
            type="button"
            label={
                props.isFullWindow
                    ? `Restore ${props.targetName} size`
                    : `Expand ${props.targetName} to full window`
            }
            aria-pressed={props.isFullWindow}
            onClick={props.onToggle}
            className="h-8 w-8 shrink-0 rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
        >
            {props.isFullWindow ? (
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
        </IconButton>
    );
}
