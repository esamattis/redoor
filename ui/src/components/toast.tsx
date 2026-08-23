import React from "react";
import { X } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";

type ToastTone = "info" | "success" | "error";

const toneClasses = {
    info: { accent: "border-l-blue-400", icon: "text-blue-400" },
    success: {
        accent: "border-l-emerald-400",
        icon: "text-emerald-400",
    },
    error: { accent: "border-l-red-400", icon: "text-red-400" },
} satisfies Record<ToastTone, { accent: string; icon: string }>;

/**
 * Keeps transient feedback non-modal so users can continue their current task.
 */
export function Toast(props: {
    tone: ToastTone;
    icon?: React.ReactNode;
    children: React.ReactNode;
    dismissAriaLabel?: string;
    onDismiss: () => void;
}) {
    const toastRef = React.useRef<HTMLDivElement>(null);
    const dismissedRef = React.useRef(false);
    const dismiss = React.useEffectEvent(() => {
        if (dismissedRef.current) {
            return;
        }
        dismissedRef.current = true;
        props.onDismiss();
    });

    React.useEffect(() => {
        const timeout = window.setTimeout(dismiss, 15_000);
        const handlePointerDown = (event: PointerEvent) => {
            const toast = toastRef.current;
            if (
                toast !== null &&
                event.target instanceof Node &&
                !toast.contains(event.target)
            ) {
                dismiss();
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => {
            window.clearTimeout(timeout);
            document.removeEventListener("pointerdown", handlePointerDown);
        };
    }, []);

    return (
        <div
            ref={toastRef}
            role={props.tone === "error" ? "alert" : "status"}
            aria-live={props.tone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`fixed left-1/2 top-16 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-l-4 border-slate-700 bg-[#11141b]/95 px-4 py-3 text-sm text-slate-200 shadow-xl backdrop-blur-md ${toneClasses[props.tone].accent}`}
        >
            {props.icon ? (
                <span
                    className={`shrink-0 ${toneClasses[props.tone].icon}`}
                    aria-hidden="true"
                >
                    {props.icon}
                </span>
            ) : null}
            <span>{props.children}</span>
            <IconButton
                type="button"
                label={props.dismissAriaLabel ?? "Dismiss notification"}
                onClick={dismiss}
                className="ml-1 shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
            >
                <X className="h-4 w-4" />
            </IconButton>
        </div>
    );
}
