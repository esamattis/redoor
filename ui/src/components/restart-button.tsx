import * as React from "react";
import { RefreshCw } from "lucide-react";

import { ConfirmationDialog } from "./confirmation-dialog";

type RestartState =
    | { type: "idle" }
    | { type: "restarting" }
    | { type: "error"; message: string };

/** Normalizes failures from both API requests and readiness polling. */
function restartErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Restart failed";
}

/** Provides the same confirmed restart workflow for server and agent process homes. */
export function RestartButton(props: {
    target: string;
    description: React.ReactNode;
    restart: () => Promise<unknown>;
    waitUntilReady: () => Promise<void>;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [state, setState] = React.useState<RestartState>({ type: "idle" });

    const close = () => {
        if (state.type === "restarting") return;
        setIsOpen(false);
        setState({ type: "idle" });
    };

    const restart = async () => {
        setState({ type: "restarting" });
        try {
            await props.restart();
            await props.waitUntilReady();
            setIsOpen(false);
            setState({ type: "idle" });
        } catch (error) {
            setState({ type: "error", message: restartErrorMessage(error) });
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setState({ type: "idle" });
                    setIsOpen(true);
                }}
                className="inline-flex items-center gap-2 rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-white/5"
            >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Restart
            </button>
            <ConfirmationDialog
                isOpen={isOpen}
                title={`Restart ${props.target}?`}
                description={props.description}
                confirmLabel="Restart"
                busyLabel="Restarting..."
                isBusy={state.type === "restarting"}
                errorMessage={state.type === "error" ? state.message : null}
                onClose={close}
                onConfirm={() => void restart()}
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
