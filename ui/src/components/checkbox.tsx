import React from "react";
import { CheckSquare, Square } from "lucide-react";

/** Keeps checkbox visuals consistent while supporting button and checkbox semantics. */
export function Checkbox(props: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label?: string;
    role?: "checkbox";
    children?: React.ReactNode;
}) {
    return (
        <button
            type="button"
            role={props.role}
            aria-label={props.label}
            title={props.label}
            aria-checked={props.role === "checkbox" ? props.checked : undefined}
            aria-pressed={props.role === undefined ? props.checked : undefined}
            onClick={() => props.onCheckedChange(!props.checked)}
            className="inline-flex items-center gap-2 rounded p-1 text-sm text-slate-300 hover:bg-white/10 hover:text-slate-100"
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
