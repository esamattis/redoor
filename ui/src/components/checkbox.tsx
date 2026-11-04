import React from "react";
import { CheckSquare, Square } from "lucide-react";
import { cn } from "#ui/utils/cn";

/** Keeps checkbox visuals consistent while supporting button and checkbox semantics. */
export function Checkbox(props: {
    checked: boolean;
    onCheckedChange: (
        checked: boolean,
        event: React.MouseEvent<HTMLButtonElement>,
    ) => void;
    label?: string;
    title?: string | false;
    role?: "checkbox";
    disabled?: boolean;
    className?: string;
    "aria-describedby"?: string;
    tabIndex?: number;
    children?: React.ReactNode;
}) {
    return (
        <button
            type="button"
            role={props.role}
            aria-label={props.label}
            title={
                props.title === false ? undefined : (props.title ?? props.label)
            }
            aria-describedby={props["aria-describedby"]}
            aria-checked={props.role === "checkbox" ? props.checked : undefined}
            aria-pressed={props.role === undefined ? props.checked : undefined}
            tabIndex={props.tabIndex}
            onClick={(event) => props.onCheckedChange(!props.checked, event)}
            disabled={props.disabled}
            className={cn(
                "inline-flex items-center gap-2 rounded p-1 text-sm text-slate-300 hover:bg-tint-strong hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-slate-300",
                props.className,
            )}
        >
            {props.checked ? (
                <CheckSquare className="h-4 w-4 shrink-0 text-blue-400" />
            ) : (
                <Square className="h-4 w-4 shrink-0" />
            )}
            {props.children}
        </button>
    );
}
