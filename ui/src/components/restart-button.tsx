import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { ConfirmationDialog } from "./confirmation-dialog";

/** Normalizes failures from both API requests and readiness polling. */
function restartErrorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : "Restart failed";
}

/** Provides the same confirmed restart workflow for server and agent process homes. */
export function RestartButton(props: {
    target: string;
    description: React.ReactNode;
    restart: () => Promise<unknown>;
    waitUntilReady: () => Promise<void>;
    className?: string;
    ariaLabel?: string;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const restartMutation = useMutation({
        mutationFn: async () => {
            await props.restart();
            await props.waitUntilReady();
        },
        onSuccess: () => {
            setIsOpen(false);
        },
    });

    const close = () => {
        if (restartMutation.isPending) return;
        setIsOpen(false);
        restartMutation.reset();
    };

    const button = (
        <button
            type="button"
            aria-label={props.ariaLabel}
            onClick={() => {
                restartMutation.reset();
                setIsOpen(true);
            }}
            className={
                props.className ??
                "inline-flex items-center gap-2 rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-white/5"
            }
        >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Restart
        </button>
    );

    return (
        <>
            {button}
            <ConfirmationDialog
                isOpen={isOpen}
                title={`Restart ${props.target}?`}
                description={props.description}
                confirmLabel="Restart"
                busyLabel="Restarting..."
                isBusy={restartMutation.isPending}
                errorMessage={
                    restartMutation.isError
                        ? restartErrorMessage(restartMutation.error)
                        : null
                }
                onClose={close}
                onConfirm={() => restartMutation.mutate()}
            />
        </>
    );
}

/** Polls a target-specific probe until it proves the replacement process is ready. */
export async function waitForRestart(
    probe: () => Promise<unknown>,
    timeoutMessage: string,
): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
        try {
            await probe();
            return;
        } catch {
            // The target is still shutting down or starting up.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(timeoutMessage);
}
