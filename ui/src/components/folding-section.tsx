import React from "react";
import { ChevronDown } from "lucide-react";
import { Tooltip } from "#ui/components/tooltip";

/**
 * Keeps optional controls collapsed until the user asks for them, so dense views stay readable.
 */
export function FoldingSection(props: {
    title: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
    tooltip?: string;
    className?: string;
}) {
    const panelId = React.useId();
    const toggle = (
        <button
            type="button"
            aria-expanded={props.open}
            aria-controls={props.open ? panelId : undefined}
            onClick={() => props.onOpenChange(!props.open)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-slate-300 hover:bg-white/5 hover:text-slate-100"
        >
            {props.title}
            <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${
                    props.open ? "rotate-180" : ""
                }`}
                aria-hidden="true"
            />
        </button>
    );

    return (
        <section
            aria-label={props.title}
            className={`rounded-lg border border-slate-800 bg-[#0b0d12] ${props.className ?? ""}`}
        >
            {props.tooltip === undefined ? (
                toggle
            ) : (
                <Tooltip className="w-full" content={props.tooltip}>
                    {toggle}
                </Tooltip>
            )}
            {props.open ? (
                <div
                    id={panelId}
                    className="space-y-3 border-t border-slate-800 px-3 py-3"
                >
                    {props.children}
                </div>
            ) : null}
        </section>
    );
}
