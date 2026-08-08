import * as React from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";

import { ApiError } from "../api-client";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/config/reload")({
    component: ConfigReloadPage,
});

type ReloadState =
    | { type: "idle" }
    | { type: "reloading" }
    | { type: "error"; message: string };

/** Produces a useful fallback when a reload failure is not an API error. */
function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return "Reload failed";
}

/** Gives configuration reloads a focused page because they restart the server. */
function ConfigReloadPage() {
    const { serverInfo } = RootRoute.useLoaderData();
    const { api } = RootRoute.useRouteContext();
    const router = useRouter();
    const [isReloadDialogOpen, setIsReloadDialogOpen] = React.useState(false);
    const [reloadState, setReloadState] = React.useState<ReloadState>({
        type: "idle",
    });

    /** Keeps the dialog open while the server restarts so the operator sees progress. */
    const closeReloadDialog = () => {
        if (reloadState.type === "reloading") {
            return;
        }

        setIsReloadDialogOpen(false);
        setReloadState({ type: "idle" });
    };

    /** Restarts the server, then waits until the refreshed configuration is available. */
    const handleReloadConfig = async () => {
        setReloadState({ type: "reloading" });

        try {
            await api.reloadConfig();

            // TCP dies shortly after the 200; poll until the restarted process answers.
            const startedAt = Date.now();
            const timeoutMs = 30_000;
            while (Date.now() - startedAt < timeoutMs) {
                try {
                    await api.listAgents();
                    await router.invalidate();
                    await router.load();
                    setIsReloadDialogOpen(false);
                    setReloadState({ type: "idle" });
                    return;
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }

            setReloadState({
                type: "error",
                message: "Server did not come back after reload",
            });
        } catch (error) {
            setReloadState({
                type: "error",
                message:
                    error instanceof ApiError
                        ? error.message
                        : getErrorMessage(error),
            });
        }
    };

    return (
        <div className="p-8">
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center gap-3">
                    <RefreshCw className="h-6 w-6 text-blue-400" />
                    <h1 className="text-2xl font-bold text-slate-100">
                        Reload config
                    </h1>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#11141b] p-6">
                    <p className="text-sm leading-6 text-slate-300">
                        Restart the server and re-read the configuration from
                        <span className="ml-1 break-all font-mono text-slate-100">
                            {serverInfo.config_path}
                        </span>
                        . Connected agents reconnect automatically, but
                        in-flight transfers and terminals are interrupted.
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            setReloadState({ type: "idle" });
                            setIsReloadDialogOpen(true);
                        }}
                        className="mt-6 rounded border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-white/5"
                    >
                        Reload config
                    </button>
                </div>
            </div>

            <ConfirmationDialog
                isOpen={isReloadDialogOpen}
                title="Reload config?"
                description="The server will restart and re-read config.toml. Connected agents reconnect automatically. In-flight transfers and terminals are interrupted. If you changed the listen port, open the new URL after reload."
                confirmLabel="Reload config"
                busyLabel="Reloading..."
                isBusy={reloadState.type === "reloading"}
                errorMessage={
                    reloadState.type === "error" ? reloadState.message : null
                }
                onClose={closeReloadDialog}
                onConfirm={handleReloadConfig}
            />
        </div>
    );
}
