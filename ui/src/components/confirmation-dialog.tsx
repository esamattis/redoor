import React from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Dialog } from "./dialog";

/**
 * Builds a consistent confirmation workflow on the shared modal foundation.
 */
export function ConfirmationDialog(props: {
    isOpen: boolean;
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    busyLabel?: string;
    isBusy?: boolean;
    errorMessage?: string | null;
    children?: React.ReactNode;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog
            isOpen={props.isOpen}
            title={props.title}
            description={props.description}
            closeAriaLabel="Close confirmation dialog"
            isBusy={props.isBusy}
            errorMessage={props.errorMessage}
            role="dialog"
            onClose={props.onClose}
        >
            {props.children ? (
                <div className="mt-4">{props.children}</div>
            ) : null}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                    type="button"
                    onClick={props.onClose}
                    disabled={props.isBusy}
                    className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={props.onConfirm}
                    disabled={props.isBusy}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:border-red-500/60 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {props.isBusy ? (
                        <LoaderCircle
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                        />
                    ) : (
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    )}
                    {props.isBusy
                        ? (props.busyLabel ?? "Confirming...")
                        : props.confirmLabel}
                </button>
            </div>
        </Dialog>
    );
}
