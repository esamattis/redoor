import React from "react";
import { X } from "lucide-react";

/**
 * Provides consistent modal structure and dismissal behavior for UI workflows.
 */
export function Dialog(props: {
    isOpen: boolean;
    title: string;
    description?: React.ReactNode;
    closeAriaLabel: string;
    isBusy?: boolean;
    errorMessage?: string | null;
    role?: "dialog" | "alertdialog";
    children: React.ReactNode;
    onClose: () => void;
}) {
    const titleId = React.useId();
    const descriptionId = React.useId();

    React.useEffect(() => {
        if (!props.isOpen || props.isBusy) {
            return;
        }

        /** Closes an idle dialog from the keyboard for accessible dismissal. */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                props.onClose();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [props.isBusy, props.isOpen, props.onClose]);

    if (!props.isOpen) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
            role={props.role ?? "dialog"}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={props.description ? descriptionId : undefined}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !props.isBusy) {
                    props.onClose();
                }
            }}
        >
            <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#11141b] p-6 shadow-2xl shadow-black/40">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2
                            id={titleId}
                            className="text-lg font-semibold text-slate-100"
                        >
                            {props.title}
                        </h2>
                        {props.description ? (
                            <div
                                id={descriptionId}
                                className="mt-2 text-sm text-slate-400"
                            >
                                {props.description}
                            </div>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        aria-label={props.closeAriaLabel}
                        onClick={props.onClose}
                        disabled={props.isBusy}
                        className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {props.errorMessage ? (
                    <p
                        role="alert"
                        className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                    >
                        {props.errorMessage}
                    </p>
                ) : null}

                {props.children}
            </div>
        </div>
    );
}
