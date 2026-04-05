import React from "react";
import { X } from "lucide-react";

export function BrowserActionDialog(props: {
    isOpen: boolean;
    title: string;
    description: React.ReactNode;
    dialogTitleId: string;
    dialogDescriptionId: string;
    closeAriaLabel: string;
    isBusy: boolean;
    errorMessage: string | null;
    children: React.ReactNode;
    onClose: () => void;
}) {
    if (!props.isOpen) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.dialogTitleId}
            aria-describedby={props.dialogDescriptionId}
        >
            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2
                            id={props.dialogTitleId}
                            className="text-lg font-semibold text-gray-900"
                        >
                            {props.title}
                        </h2>
                        <div
                            id={props.dialogDescriptionId}
                            className="mt-2 text-sm text-gray-600"
                        >
                            {props.description}
                        </div>
                    </div>
                    <button
                        type="button"
                        aria-label={props.closeAriaLabel}
                        onClick={props.onClose}
                        disabled={props.isBusy}
                        className="rounded p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {props.errorMessage ? (
                    <p
                        role="alert"
                        className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                    >
                        {props.errorMessage}
                    </p>
                ) : null}

                {props.children}
            </div>
        </div>
    );
}
