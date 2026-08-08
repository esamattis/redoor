import { createFileRoute } from "@tanstack/react-router";
import { FileCode2, KeyRound, Server } from "lucide-react";

import type { ServerAuthMode } from "../api-client";
import { BinaryIdentityFields } from "../components/binary-identity";
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

/** Shows server identity and runtime details without operational controls. */
function Index() {
    const { serverInfo } = RootRoute.useLoaderData();

    return (
        <div className="p-8">
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center gap-3">
                    <Server className="h-6 w-6 text-blue-400" />
                    <h1 className="text-2xl font-bold text-slate-100">
                        Server
                    </h1>
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
                    <BinaryIdentityFields
                        binary={{
                            version: serverInfo.version,
                            git_rev: serverInfo.git_rev,
                            git_dirty: serverInfo.git_dirty,
                            version_dirty: serverInfo.version_dirty,
                            build_mode: serverInfo.build_mode,
                            build_date: serverInfo.build_date,
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
