import { createFileRoute } from "@tanstack/react-router";
import {
    FileCode2,
    GitCommitHorizontal,
    Hammer,
    KeyRound,
    Server,
    Tag,
} from "lucide-react";

import type { ServerAuthMode, ServerBuildMode } from "../api-client";
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

function Index() {
    const { serverInfo } = RootRoute.useLoaderData();
    const commitUrl = gitCommitUrl(serverInfo.git_rev);
    const shortRev = serverInfo.git_rev.slice(0, 7);

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
        </div>
    );
}
