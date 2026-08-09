import * as React from "react";
import { AlertTriangle, CheckCircle2, PackageOpen } from "lucide-react";

import type { ServerInfoResponse } from "../api-client";
import { ConfirmationDialog } from "./confirmation-dialog";

type UpgradeState =
    | { type: "idle" }
    | { type: "upgrading" }
    | { type: "error"; message: string };

/** Converts request and reconnection failures into dialog feedback. */
function upgradeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Upgrade failed";
}

/** Mirrors the release targets that the server can provision for clean builds. */
function isSupportedReleasePlatform(os: string, arch: string): boolean {
    return (
        (os === "linux" && (arch === "x86_64" || arch === "aarch64")) ||
        (os === "macos" && arch === "aarch64")
    );
}

/** Explains a client-known condition that prevents the server from starting an upgrade. */
function upgradeUnavailableReason(props: {
    supportsSelfExec: boolean;
    exePath: string;
    agentOs: string;
    agentArch: string;
    serverInfo: ServerInfoResponse;
}): string | null {
    if (!props.supportsSelfExec) {
        return "This agent does not support safe self-exec upgrades. Install a current Redoor agent manually, reconnect it, and try again.";
    }
    if (props.exePath === "unknown" || !props.exePath.startsWith("/")) {
        return `The agent reported an unusable executable path (${props.exePath}), so Redoor cannot safely replace its binary.`;
    }
    if (!isSupportedReleasePlatform(props.agentOs, props.agentArch)) {
        return `Redoor does not publish upgrade binaries for ${props.agentOs}/${props.agentArch}. Upgrade this agent manually.`;
    }
    const dirty = props.serverInfo.git_dirty || props.serverInfo.version_dirty;
    if (
        dirty &&
        (props.serverInfo.os !== props.agentOs ||
            props.serverInfo.arch !== props.agentArch)
    ) {
        return `This dirty server binary is ${props.serverInfo.os}/${props.serverInfo.arch}, but the agent is ${props.agentOs}/${props.agentArch}. Dirty builds can only upgrade agents on the server's platform.`;
    }
    return null;
}

/** Presents upgrade identity and availability before confirming the disruptive action. */
export function UpgradeButton(props: {
    target: string;
    agentOs: string;
    agentArch: string;
    agentExePath: string;
    supportsSelfExec: boolean;
    serverInfo: ServerInfoResponse;
    upgrade: () => Promise<unknown>;
    waitUntilReady: () => Promise<void>;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [state, setState] = React.useState<UpgradeState>({ type: "idle" });
    const dirty = props.serverInfo.git_dirty || props.serverInfo.version_dirty;
    const disabledDescriptionId = `upgrade-disabled-${props.target.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
    const unavailableReason = upgradeUnavailableReason({
        supportsSelfExec: props.supportsSelfExec,
        exePath: props.agentExePath,
        agentOs: props.agentOs,
        agentArch: props.agentArch,
        serverInfo: props.serverInfo,
    });
    const targetDescription = dirty
        ? `Upgrade to the exact dirty server build: ${props.serverInfo.version}, revision ${props.serverInfo.git_rev.slice(0, 8)}, built ${props.serverInfo.build_date}.`
        : `Upgrade to Redoor ${props.serverInfo.version} for ${props.agentOs}/${props.agentArch}, matching the server version.`;

    const close = () => {
        if (state.type === "upgrading") return;
        setIsOpen(false);
        setState({ type: "idle" });
    };

    const upgrade = async () => {
        setState({ type: "upgrading" });
        try {
            await props.upgrade();
            await props.waitUntilReady();
            setIsOpen(false);
            setState({ type: "idle" });
        } catch (error) {
            setState({ type: "error", message: upgradeErrorMessage(error) });
        }
    };

    return (
        <section
            aria-labelledby="agent-upgrade-title"
            className="rounded-lg border border-slate-800 bg-[#11141b] p-4"
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2
                    id="agent-upgrade-title"
                    className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-300"
                >
                    <PackageOpen
                        className="h-5 w-5 text-slate-400"
                        aria-hidden="true"
                    />
                    Upgrade
                </h2>
                <span
                    className={
                        dirty
                            ? "inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300"
                            : "inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300"
                    }
                >
                    {dirty ? (
                        <AlertTriangle
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    ) : (
                        <CheckCircle2
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    )}
                    {dirty ? "Dirty build" : "Clean release"}
                </span>
            </div>
            <div className="mt-4 flex flex-col gap-4 border-t border-slate-800 pt-4 lg:flex-row lg:items-center">
                <div className="shrink-0 lg:w-40">
                    <p className="text-xs text-slate-500">Target version</p>
                    <p className="mt-1 font-mono text-xl font-semibold text-slate-100">
                        {props.serverInfo.version}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                        {props.agentOs}/{props.agentArch}
                    </p>
                </div>
                <div className="min-w-0 flex-1 text-sm leading-5 text-slate-400">
                    <p>
                        {dirty
                            ? "The exact server executable will be copied because this build does not match a published release."
                            : "Installs the published release matching this server."}
                    </p>
                    {props.serverInfo.git_dirty ? (
                        <p className="mt-1 text-amber-300">
                            It includes uncommitted or untracked source changes.
                        </p>
                    ) : null}
                    {props.serverInfo.version_dirty ? (
                        <p className="mt-1 text-amber-300">
                            Revision {props.serverInfo.git_rev.slice(0, 8)} is
                            not tagged v{props.serverInfo.version}.
                        </p>
                    ) : null}
                    {unavailableReason ? (
                        <p
                            id={disabledDescriptionId}
                            className="mt-2 text-amber-300"
                        >
                            <span className="font-medium">
                                Upgrade unavailable:
                            </span>{" "}
                            {unavailableReason}
                        </p>
                    ) : (
                        <p className="mt-1 text-slate-500">
                            The restart interrupts active transfers and
                            terminals.
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    disabled={
                        unavailableReason !== null || state.type === "upgrading"
                    }
                    aria-describedby={
                        unavailableReason ? disabledDescriptionId : undefined
                    }
                    onClick={() => {
                        setState({ type: "idle" });
                        setIsOpen(true);
                    }}
                    className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 lg:self-center"
                >
                    <PackageOpen className="h-4 w-4" aria-hidden="true" />
                    Upgrade to {props.serverInfo.version}
                </button>
            </div>
            <ConfirmationDialog
                isOpen={isOpen}
                title={`Upgrade ${props.target}?`}
                description={
                    <div className="space-y-2">
                        <p>{targetDescription}</p>
                        <p>
                            The binary is atomically replaced. In-flight
                            transfers and terminals are interrupted when the
                            agent self-executes.
                        </p>
                    </div>
                }
                confirmLabel="Upgrade"
                busyLabel="Upgrading..."
                isBusy={state.type === "upgrading"}
                errorMessage={state.type === "error" ? state.message : null}
                onClose={close}
                onConfirm={() => void upgrade()}
            />
        </section>
    );
}
