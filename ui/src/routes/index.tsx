import type { ReactNode } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { FileCode2, Globe2, HardDrive, KeyRound, Server } from "lucide-react";

import type { ServerAuthMode } from "../api-client";
import { BinaryIdentityFields } from "../components/binary-identity";
import { CopyableCodeRow, CopyablePath } from "../components/copyable-code-row";
import { RestartButton, waitForRestart } from "../components/restart-button";
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

/** Labeled path row that keeps long absolute paths scannable and copyable. */
function PathField(props: {
    icon: ReactNode;
    label: string;
    value: string;
    copyAriaLabel: string;
    bordered?: boolean;
}) {
    return (
        <div
            className={
                props.bordered
                    ? "flex items-start gap-3 border-t border-slate-800 pt-4"
                    : "flex items-start gap-3"
            }
        >
            <div className="mt-0.5 shrink-0 text-slate-400">{props.icon}</div>
            <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-slate-400">
                    {props.label}
                </h2>
                <div className="mt-1">
                    <CopyablePath
                        value={props.value}
                        copyAriaLabel={props.copyAriaLabel}
                    />
                </div>
            </div>
        </div>
    );
}

/** Shows server identity, runtime details, and its process-level restart control. */
function Index() {
    const { serverInfo } = RootRoute.useLoaderData();
    const { api } = RootRoute.useRouteContext();
    const router = useRouter();
    const websocketProtocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";
    const websocketAddress = `${websocketProtocol}//${window.location.host}/ws`;
    const agentConfig = `agent_token = ${JSON.stringify(serverInfo.agent_token)}

[agent]
ws_address = ${JSON.stringify(websocketAddress)}
`;

    return (
        <div className="p-8">
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <Server className="h-6 w-6 text-blue-400" />
                        <h1 className="text-2xl font-bold text-slate-100">
                            Server
                        </h1>
                        <span className="rounded border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 font-mono text-xs text-blue-300">
                            {serverInfo.app_name}
                        </span>
                    </div>
                    <RestartButton
                        target="server"
                        description="The server will restart and re-read its configuration. Connected agents reconnect automatically. In-flight transfers and terminals are interrupted."
                        restart={() => api.restartServer()}
                        waitUntilReady={() => {
                            let oldServerClosed = false;
                            return waitForRestart(async () => {
                                try {
                                    await api.getServerInfo();
                                } catch (error) {
                                    oldServerClosed = true;
                                    throw error;
                                }
                                if (!oldServerClosed) {
                                    throw new Error(
                                        "Old server is still shutting down",
                                    );
                                }
                                await router.invalidate();
                            }, "Server did not come back after restart");
                        }}
                    />
                </div>
                <div className="space-y-4 rounded-lg border border-slate-800 bg-[#11141b] p-6">
                    <PathField
                        icon={<FileCode2 className="h-5 w-5" />}
                        label="Config file"
                        value={serverInfo.config_path}
                        copyAriaLabel="Copy config file path"
                    />
                    <PathField
                        icon={<HardDrive className="h-5 w-5" />}
                        label="Binary path"
                        value={serverInfo.exe_path}
                        copyAriaLabel="Copy binary path"
                        bordered
                    />
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                External IP
                            </h2>
                            <p className="mt-1 font-mono text-xs text-slate-100">
                                {serverInfo.external_ip ?? "Unavailable"}
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
                <div className="mt-6">
                    <div className="mb-3">
                        <h2 className="text-lg font-semibold text-slate-100">
                            Connect an agent
                        </h2>
                        <p className="mt-1 text-sm text-slate-400">
                            Save this as config.toml and run{" "}
                            <code className="font-mono text-slate-200">
                                redoor agent --config config.toml
                            </code>
                            . The agent uses the computer hostname as its name.
                        </p>
                    </div>
                    <CopyableCodeRow
                        label="config.toml"
                        value={agentConfig}
                        copyAriaLabel="Copy agent config"
                        multiline
                    />
                </div>
            </div>
        </div>
    );
}
