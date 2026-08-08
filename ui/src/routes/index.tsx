import * as React from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";

import { ApiError } from "../api-client";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

type ReloadState =
    | { type: "idle" }
    | { type: "reloading" }
    | { type: "error"; message: string };

function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return "Reload failed";
}

function Index() {
    const { agents } = RootRoute.useLoaderData();
    const { api } = RootRoute.useRouteContext();
    const router = useRouter();
    const sortedAgents = [...agents].sort((left, right) =>
        left.name.localeCompare(right.name),
    );
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
            <div className="mx-auto max-w-6xl">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <h1 className="text-2xl font-bold text-slate-100">
                        Agents
                    </h1>
                    <button
                        type="button"
                        onClick={() => {
                            setReloadState({ type: "idle" });
                            setIsReloadDialogOpen(true);
                        }}
                        className="rounded border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-white/5"
                    >
                        Reload config
                    </button>
                </div>
                {agents.length === 0 ? (
                    <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-slate-800">
                        <p className="text-slate-500">No agents connected</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {sortedAgents.map((agent) => (
                            <Link
                                key={agent.id}
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                className="flex cursor-pointer items-center gap-4 rounded-lg border border-slate-800 bg-[#11141b] p-6 transition-all hover:border-blue-500/60 hover:bg-[#161a23] hover:shadow-[0_0_0_1px_rgba(59,130,246,0.35)]"
                            >
                                <HardDrive className="h-8 w-8 flex-shrink-0 text-blue-400" />
                                <div className="min-w-0">
                                    <h2 className="truncate font-semibold text-slate-100">
                                        {agent.name}
                                    </h2>
                                    <p className="mt-1 truncate text-sm text-slate-500">
                                        {agent.id}
                                    </p>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
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
