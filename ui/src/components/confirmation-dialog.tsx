import React from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { DialogActions } from "./dialog-actions";

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
    confirmDisabled?: boolean;
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

            <DialogActions stackOnMobile>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={props.onClose}
                    disabled={props.isBusy}
                    className="rounded-md hover:border-slate-600"
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    variant="danger"
                    onClick={props.onConfirm}
                    disabled={props.confirmDisabled}
                    isLoading={props.isBusy}
                    className="rounded-md border-red-500/40 bg-red-500/15 font-semibold text-red-200 hover:border-red-500/60 hover:bg-red-500/25"
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
                </Button>
            </DialogActions>
        </Dialog>
    );
}
