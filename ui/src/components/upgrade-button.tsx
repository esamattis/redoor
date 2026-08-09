import * as React from "react";
import { PackageOpen } from "lucide-react";

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

/** Confirms an exact upgrade target and keeps platform incompatibility visible beside the action. */
export function UpgradeButton(props: {
    target: string;
    agentOs: string;
    agentArch: string;
    serverInfo: ServerInfoResponse;
    upgrade: () => Promise<unknown>;
    waitUntilReady: () => Promise<void>;
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [state, setState] = React.useState<UpgradeState>({ type: "idle" });
    const dirty = props.serverInfo.git_dirty || props.serverInfo.version_dirty;
    const incompatible =
        dirty &&
        (props.serverInfo.os !== props.agentOs ||
            props.serverInfo.arch !== props.agentArch);
    const disabledDescriptionId = `upgrade-disabled-${props.target.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
    const incompatibility = incompatible
        ? `This dirty server binary is ${props.serverInfo.os}/${props.serverInfo.arch}, but the agent is ${props.agentOs}/${props.agentArch}. Dirty builds can only upgrade agents on the server's platform.`
        : null;
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
        <div>
            <button
                type="button"
                disabled={incompatible || state.type === "upgrading"}
                aria-describedby={
                    incompatible ? disabledDescriptionId : undefined
                }
                onClick={() => {
                    setState({ type: "idle" });
                    setIsOpen(true);
                }}
                className="inline-flex items-center gap-2 rounded border border-blue-700 px-4 py-2 text-sm text-blue-200 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <PackageOpen className="h-4 w-4" aria-hidden="true" />
                Upgrade
            </button>
            {incompatibility ? (
                <p
                    id={disabledDescriptionId}
                    className="mt-2 max-w-md text-sm text-amber-300"
                >
                    {incompatibility}
                </p>
            ) : null}
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
        </div>
    );
}
