import * as React from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
    FileCode2,
    GitCommitHorizontal,
    Hammer,
    KeyRound,
    Server,
    Tag,
} from "lucide-react";

import {
    ApiError,
    type ServerAuthMode,
    type ServerBuildMode,
} from "../api-client";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

/** Human-readable label for the configured browser login backend. */
function authModeLabel(authMode: ServerAuthMode): string {
    switch (authMode) {
        case "toml":
            return "TOML (username/password in config file)";
        case "pam":
            return "PAM (system account)";
    }
}

/** Human-readable cargo profile name. */
function buildModeLabel(buildMode: ServerBuildMode): string {
    switch (buildMode) {
        case "debug":
            return "debug";
        case "release":
            return "release";
        case "unknown":
            return "unknown";
    }
}

/** GitHub commit URL when the baked revision looks like a real SHA. */
function gitCommitUrl(gitRev: string): string | null {
    if (!/^[0-9a-f]{7,40}$/i.test(gitRev)) {
        return null;
    }
    return `https://github.com/esamattis/redoor/commit/${gitRev}`;
}

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
    const { serverInfo } = RootRoute.useLoaderData();
    const { api } = RootRoute.useRouteContext();
    const router = useRouter();
    const commitUrl = gitCommitUrl(serverInfo.git_rev);
    const shortRev = serverInfo.git_rev.slice(0, 7);
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
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <Server className="h-6 w-6 text-blue-400" />
                        <h1 className="text-2xl font-bold text-slate-100">
                            Server
                        </h1>
                    </div>
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
                <div className="space-y-4 rounded-lg border border-slate-800 bg-[#11141b] p-6">
                    <div className="flex items-start gap-3">
                        <FileCode2 className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Config file
                            </h2>
                            <p className="mt-1 break-all font-mono text-sm text-slate-100">
                                {serverInfo.config_path}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Authentication
                            </h2>
                            <p className="mt-1 text-sm text-slate-100">
                                {authModeLabel(serverInfo.auth_mode)}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <Tag className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Version
                            </h2>
                            <p className="mt-1 font-mono text-sm text-slate-100">
                                {serverInfo.version}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <GitCommitHorizontal className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Git revision
                            </h2>
                            <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-sm text-slate-100">
                                {commitUrl ? (
                                    <a
                                        href={commitUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-400 hover:underline"
                                    >
                                        {shortRev}
                                    </a>
                                ) : (
                                    <span>{shortRev}</span>
                                )}
                                {serverInfo.git_dirty ? (
                                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-sans font-medium text-amber-300">
                                        dirty
                                    </span>
                                ) : null}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <Hammer className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Build mode
                            </h2>
                            <p className="mt-1 font-mono text-sm text-slate-100">
                                {buildModeLabel(serverInfo.build_mode)}
                            </p>
                        </div>
                    </div>
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
