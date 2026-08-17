import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";

import type { ServerInfoResponse } from "#ui/api-client";
import { Button } from "./button";
import { ConfirmationDialog } from "./confirmation-dialog";
import { InputControl } from "./input-control";

type UpgradeAction = "published_release" | "running_server";

type UpgradeButtonProps = {
    target: string;
    agentOs: string;
    agentArch: string;
    agentExePath: string;
    supportsSelfExec: boolean;
    serverInfo: ServerInfoResponse;
    upgrade: (targetVersion: string) => Promise<unknown>;
    forceInstallRunningBinary: () => Promise<unknown>;
    waitUntilReady: (
        targetVersion: string,
        requireServerIdentity: boolean,
    ) => Promise<void>;
};

/** Converts request and reconnection failures into dialog feedback. */
function upgradeErrorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : "Upgrade failed";
}

/** Explains a client-known condition that prevents the server from starting an upgrade. */
function upgradeUnavailableReason(props: {
    supportsSelfExec: boolean;
    exePath: string;
}): string | null {
    if (!props.supportsSelfExec) {
        return "This agent does not support safe self-exec upgrades. Install a current Redoor agent manually, reconnect it, and try again.";
    }
    if (props.exePath === "unknown" || !props.exePath.startsWith("/")) {
        return `The agent reported an unusable executable path (${props.exePath}), so Redoor cannot safely replace its binary.`;
    }
    return null;
}

/** Explains the atomic replacement and interruption shared by both upgrade sources. */
function UpgradeConfirmationDescription(props: { targetDescription: string }) {
    return (
        <div className="space-y-2">
            <p>{props.targetDescription}</p>
            <p>
                The binary is atomically replaced. In-flight transfers and
                terminals are interrupted when the agent self-executes.
            </p>
        </div>
    );
}

/** Presents upgrade identity and availability before confirming the disruptive action. */
export function UpgradeButton(props: UpgradeButtonProps) {
    const [action, setAction] = React.useState<UpgradeAction | null>(null);
    const [targetVersion, setTargetVersion] = React.useState(
        props.serverInfo.version,
    );
    const normalizedTargetVersion = targetVersion.trim();
    const disabledDescriptionId = `upgrade-disabled-${props.target.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
    const unavailableReason = upgradeUnavailableReason({
        supportsSelfExec: props.supportsSelfExec,
        exePath: props.agentExePath,
    });
    const runningBinaryUnavailableReason =
        props.agentArch === props.serverInfo.arch
            ? unavailableReason
            : `The running server binary is ${props.serverInfo.arch}, but this agent is ${props.agentArch}.`;
    const targetDescription =
        action === "running_server"
            ? `Force install the exact Redoor ${props.serverInfo.version} executable currently running this server.`
            : `Download and install Redoor ${normalizedTargetVersion} for ${props.agentOs}/${props.agentArch}.`;
    const upgradeMutation = useMutation({
        mutationFn: async (selectedAction: UpgradeAction) => {
            if (selectedAction === "running_server") {
                await props.forceInstallRunningBinary();
                await props.waitUntilReady(props.serverInfo.version, true);
                return;
            }
            await props.upgrade(normalizedTargetVersion);
            await props.waitUntilReady(normalizedTargetVersion, false);
        },
        onSuccess: () => setAction(null),
    });

    const close = () => {
        if (upgradeMutation.isPending) return;
        setAction(null);
        upgradeMutation.reset();
    };

    const upgrade = () => {
        if (action === null) return;
        upgradeMutation.mutate(action);
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
                <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                    Published release
                </span>
            </div>
            <div className="mt-4 flex flex-col gap-4 border-t border-slate-800 pt-4 lg:flex-row lg:items-center">
                <div className="shrink-0 lg:w-40">
                    <label
                        htmlFor="agent-upgrade-target-version"
                        className="text-xs text-slate-500"
                    >
                        Target version
                    </label>
                    <InputControl
                        id="agent-upgrade-target-version"
                        type="text"
                        value={targetVersion}
                        disabled={upgradeMutation.isPending}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) =>
                            setTargetVersion(event.target.value)
                        }
                        className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-lg font-semibold focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                    />
                    <p className="font-mono text-xs text-slate-500">
                        {props.agentOs}/{props.agentArch}
                    </p>
                </div>
                <div className="min-w-0 flex-1 text-sm leading-5 text-slate-400">
                    <p>
                        Downloads the selected published release for this
                        agent's architecture before replacing its executable.
                    </p>
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
                <div className="flex shrink-0 flex-col gap-2 self-start lg:self-center">
                    <Button
                        type="button"
                        disabled={
                            unavailableReason !== null ||
                            upgradeMutation.isPending ||
                            normalizedTargetVersion.length === 0
                        }
                        aria-describedby={
                            unavailableReason
                                ? disabledDescriptionId
                                : undefined
                        }
                        onClick={() => {
                            upgradeMutation.reset();
                            setAction("published_release");
                        }}
                        className="disabled:bg-slate-700 disabled:text-slate-400"
                    >
                        <PackageOpen className="h-4 w-4" aria-hidden="true" />
                        Upgrade to {normalizedTargetVersion || "version"}
                    </Button>
                    <Button
                        type="button"
                        variant="warning"
                        disabled={
                            runningBinaryUnavailableReason !== null ||
                            upgradeMutation.isPending
                        }
                        aria-describedby={
                            runningBinaryUnavailableReason
                                ? runningBinaryUnavailableReason ===
                                  unavailableReason
                                    ? disabledDescriptionId
                                    : "running-binary-upgrade-disabled"
                                : undefined
                        }
                        onClick={() => {
                            upgradeMutation.reset();
                            setAction("running_server");
                        }}
                    >
                        <PackageOpen className="h-4 w-4" aria-hidden="true" />
                        Force install server binary
                    </Button>
                    {runningBinaryUnavailableReason &&
                    runningBinaryUnavailableReason !== unavailableReason ? (
                        <p
                            id="running-binary-upgrade-disabled"
                            className="max-w-64 text-xs text-amber-300"
                        >
                            {runningBinaryUnavailableReason}
                        </p>
                    ) : null}
                </div>
            </div>
            <ConfirmationDialog
                isOpen={action !== null}
                title={
                    action === "running_server"
                        ? `Force install server binary on ${props.target}?`
                        : `Upgrade ${props.target}?`
                }
                description={
                    <UpgradeConfirmationDescription
                        targetDescription={targetDescription}
                    />
                }
                confirmLabel={
                    action === "running_server" ? "Force install" : "Upgrade"
                }
                busyLabel="Installing..."
                isBusy={upgradeMutation.isPending}
                errorMessage={
                    upgradeMutation.isError
                        ? upgradeErrorMessage(upgradeMutation.error)
                        : null
                }
                onClose={close}
                onConfirm={upgrade}
            />
        </section>
    );
}
