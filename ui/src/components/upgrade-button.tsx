import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";

import type { ServerInfoResponse } from "#bindings/ServerInfoResponse";
import type { UpgradeAgentResponse } from "#bindings/UpgradeAgentResponse";
import { Button } from "./button";
import { ConfirmationDialog } from "./confirmation-dialog";
import { DetailCard } from "./detail-card";
import { InputControl } from "./input-control";
import { getErrorMessage } from "#ui/utils/error";

type UpgradeAction = "published_release" | "running_server";

type UpgradeButtonProps = {
    target: string;
    agentOs: string;
    agentArch: string;
    agentExePath: string;
    serverInfo: ServerInfoResponse;
    /** Whether an upgrade of this agent is still running, which blocks starting another. */
    isUpgrading: boolean;
    upgrade: (targetVersion: string) => Promise<UpgradeAgentResponse>;
    forceInstallRunningBinary: () => Promise<UpgradeAgentResponse>;
    /** Called once the server accepted the upgrade, so its progress can be followed. */
    onStarted: () => void;
};

/** Converts a refused upgrade request into dialog feedback. */
function upgradeErrorMessage(cause: unknown): string {
    return getErrorMessage(cause, "Upgrade failed");
}

/** Explains a client-known condition that prevents the server from starting an upgrade. */
function upgradeUnavailableReason(props: { exePath: string }): string | null {
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

/**
 * Presents upgrade identity and availability before confirming the disruptive action. The
 * dialog only starts the upgrade: the server runs it in the background, and
 * `AgentUpgradeStatus` shows its progress, which survives the page switching to the
 * lifecycle view while the agent restarts, and a reload.
 */
export function UpgradeButton(props: UpgradeButtonProps) {
    const [action, setAction] = React.useState<UpgradeAction | null>(null);

    const [targetVersion, setTargetVersion] = React.useState(
        props.serverInfo.version,
    );

    const normalizedTargetVersion = targetVersion.trim();
    const disabledDescriptionId = `upgrade-disabled-${props.target.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;

    const unavailableReason = upgradeUnavailableReason({
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
        mutationFn: (selectedAction: UpgradeAction) =>
            selectedAction === "running_server"
                ? props.forceInstallRunningBinary()
                : props.upgrade(normalizedTargetVersion),
        onSuccess: () => {
            setAction(null);
            props.onStarted();
        },
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
        <>
            <DetailCard
                title="Upgrade"
                icon={<PackageOpen className="h-5 w-5" aria-hidden="true" />}
                actions={
                    <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                        Published release
                    </span>
                }
                bodyClassName="flex flex-col gap-4 border-t border-slate-800 pt-4 @4xl:flex-row @4xl:items-center"
            >
                <div className="shrink-0 @4xl:w-40">
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
                <div className="flex shrink-0 flex-col gap-2 self-start @4xl:self-center">
                    <Button
                        type="button"
                        disabled={
                            unavailableReason !== null ||
                            upgradeMutation.isPending ||
                            props.isUpgrading ||
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
                            upgradeMutation.isPending ||
                            props.isUpgrading
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
            </DetailCard>
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
                busyLabel="Starting..."
                isBusy={upgradeMutation.isPending}
                errorMessage={
                    upgradeMutation.isError
                        ? upgradeErrorMessage(upgradeMutation.error)
                        : null
                }
                onClose={close}
                onConfirm={upgrade}
            />
        </>
    );
}
