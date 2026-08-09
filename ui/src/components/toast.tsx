import React from "react";
import { X } from "lucide-react";

type ToastTone = "info" | "success" | "error";

const toneClasses: Record<ToastTone, string> = {
    info: "border-blue-500/50 bg-blue-950 text-blue-100",
    success: "border-emerald-500/50 bg-emerald-950 text-emerald-100",
    error: "border-red-500/50 bg-red-950 text-red-100",
};

/**
 * Keeps transient feedback non-modal so users can continue their current task.
 */
export function Toast(props: {
    tone: ToastTone;
    icon?: React.ReactNode;
    children: React.ReactNode;
    dismissAriaLabel?: string;
    onDismiss?: () => void;
}) {
    return (
        <div
            role={props.tone === "error" ? "alert" : "status"}
            aria-live={props.tone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`fixed left-1/2 top-16 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-2xl ${toneClasses[props.tone]}`}
        >
            {props.icon}
            <span>{props.children}</span>
            {props.onDismiss ? (
                <button
                    type="button"
                    aria-label={
                        props.dismissAriaLabel ?? "Dismiss notification"
                    }
                    onClick={props.onDismiss}
                    className="ml-1 rounded p-1 hover:bg-white/10"
                >
                    <X className="h-4 w-4" />
                </button>
            ) : null}
        </div>
    );
}
