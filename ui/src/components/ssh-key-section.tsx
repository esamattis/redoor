import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
    CheckCircle2,
    KeyRound,
    LoaderCircle,
    LockKeyhole,
    RefreshCw,
    ShieldAlert,
    Trash2,
    TriangleAlert,
} from "lucide-react";

import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import type { SshKeyRemovalResponse } from "#bindings/SshKeyRemovalResponse";
import type { SshKeyStatusResponse } from "#bindings/SshKeyStatusResponse";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import {
    SshKeySetupDialog,
    type SshKeySetupMode,
} from "#ui/components/ssh-key-setup-dialog";
import { Toast } from "#ui/components/toast";
import {
    invalidateSshKeyQueries,
    queryKeys,
    sshHostKeyQueryOptions,
    sshKeyStatusQueryOptions,
    vaultStatusQueryOptions,
} from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import { currentSshKeyFileKey } from "#ui/vault/ssh-key-vault";
import { vaultErrorMessage } from "#ui/vault/vault-errors";

const rootRouteApi = getRouteApi("__root__");

/** Result of a finished key action, shown as a toast after its dialog closed. */
type SshKeyFeedback = { tone: "success" | "error"; message: string };

/**
 * Shows how an SSH device authenticates and offers the managed key actions for it: set up
 * a key, rotate or remove it, and re-pin a changed host key. Lives on the configuration page
 * because these actions rewrite the same configuration the form below it edits.
 */
export function SshKeySection(props: {
    agentId: string;
    deviceName: string;
    configuration: ManagedSshAgentConfigurationResponse;
}) {
    const [setupMode, setSetupMode] = React.useState<SshKeySetupMode | null>(
        null,
    );

    const [isRemoveOpen, setIsRemoveOpen] = React.useState(false);
    const [isRepinOpen, setIsRepinOpen] = React.useState(false);

    const [feedback, setFeedback] = React.useState<SshKeyFeedback | null>(null);

    const { api } = rootRouteApi.useRouteContext();
    const hasKey = props.configuration.has_managed_ssh_key;

    const keyStatus = useQuery({
        ...sshKeyStatusQueryOptions(api, props.agentId),
        enabled: hasKey,
    });

    const vaultStatus = useQuery(vaultStatusQueryOptions(api));
    const hasVault = vaultStatus.data?.vault != null;

    // An account with a vault keeps keys encrypted, so a plaintext key is rotated into one.
    const rotatesToEncrypted =
        hasVault && keyStatus.data !== undefined && !keyStatus.data.encrypted;

    return (
        <section
            aria-labelledby="ssh-key-heading"
            className="border-b border-slate-800 px-6 py-6 @xl:px-8"
        >
            <h2
                id="ssh-key-heading"
                className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300"
            >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                SSH key
            </h2>
            <p
                aria-label="SSH key status"
                className="mt-3 flex items-start gap-2 text-sm text-slate-300"
            >
                {hasKey ? (
                    <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                        aria-hidden="true"
                    />
                ) : null}
                <span>{authenticationSummary(props.configuration)}</span>
            </p>
            {hasKey && keyStatus.data !== undefined ? (
                <SshKeyStorage status={keyStatus.data} hasVault={hasVault} />
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
                {hasKey ? (
                    <>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            tooltip={
                                rotatesToEncrypted
                                    ? "Replace the plaintext key with a new key encrypted with your vault and remove the old key from the device"
                                    : "Replace the device's SSH key with a new one and remove the old key from the device"
                            }
                            onClick={() => setSetupMode("rotate")}
                        >
                            {rotatesToEncrypted ? (
                                <LockKeyhole
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            ) : (
                                <RefreshCw
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            )}
                            {rotatesToEncrypted
                                ? "Rotate to a vault-encrypted key"
                                : "Rotate key"}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            tooltip="Remove the key from the device's authorized_keys and delete it from this server"
                            onClick={() => setIsRemoveOpen(true)}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Remove key
                        </Button>
                    </>
                ) : (
                    <Button
                        type="button"
                        size="sm"
                        tooltip="Create an SSH key used only for this device and install it on the device"
                        onClick={() => setSetupMode("setup")}
                    >
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        Set up SSH key
                    </Button>
                )}
                {props.configuration.has_pinned_host_key ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        tooltip="Check the device's host key and trust it again after a confirmed change"
                        onClick={() => setIsRepinOpen(true)}
                    >
                        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                        Re-pin host key
                    </Button>
                ) : null}
            </div>
            <SshKeySetupDialog
                isOpen={setupMode !== null}
                agentId={props.agentId}
                deviceName={props.deviceName}
                mode={setupMode ?? "setup"}
                hasPinnedHostKey={props.configuration.has_pinned_host_key}
                onClose={() => setSetupMode(null)}
            />
            <RemoveSshKeyDialog
                isOpen={isRemoveOpen}
                agentId={props.agentId}
                deviceName={props.deviceName}
                onClose={() => setIsRemoveOpen(false)}
                onRemoved={(result) => {
                    setIsRemoveOpen(false);
                    setFeedback(removalFeedback(props.deviceName, result));
                }}
            />
            <SshHostKeyRepinDialog
                isOpen={isRepinOpen}
                agentId={props.agentId}
                deviceName={props.deviceName}
                onClose={() => setIsRepinOpen(false)}
                onPinned={(fingerprint) => {
                    setIsRepinOpen(false);
                    setFeedback({
                        tone: "success",
                        message: `Pinned the new host key ${fingerprint} for ${props.deviceName}.`,
                    });
                }}
            />
            {feedback ? (
                <Toast tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                    {feedback.message}
                </Toast>
            ) : null}
        </section>
    );
}

/** Describes the credential the device uses now, so the actions next to it make sense. */
function authenticationSummary(
    configuration: ManagedSshAgentConfigurationResponse,
): string {
    if (configuration.has_managed_ssh_key) {
        return "This device logs in with a dedicated SSH key that Redoor created for it. The key works only for this device and no password is stored.";
    }

    if (configuration.has_password) {
        return "This device logs in with a password stored as plaintext in config.toml. Set up a dedicated SSH key to replace it; the stored password is used once to install the key and then removed.";
    }

    return "This device logs in with this server's own SSH keys or ssh-agent. Set up a dedicated SSH key so the device gets a key that can be revoked on its own.";
}

/**
 * How the device's key is stored on this server: encrypted with the vault (and whether the
 * server holds it unlocked for the running device) or in plaintext, plus any problem that
 * keeps it from being used.
 */
function SshKeyStorage(props: {
    status: SshKeyStatusResponse;
    hasVault: boolean;
}) {
    const keyStatus = props.status.key_status?.status;

    const unusable =
        props.status.problem ??
        (props.status.encrypted &&
        keyStatus !== undefined &&
        keyStatus !== "current" &&
        keyStatus !== "older"
            ? "The key is encrypted with a vault key this vault cannot open. Remove the key and set it up again."
            : null);

    return (
        <div className="mt-2 space-y-2 text-sm">
            <p
                aria-label="SSH key storage"
                className="flex items-start gap-2 text-slate-300"
            >
                <LockKeyhole
                    className={
                        props.status.encrypted
                            ? "mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                            : "mt-0.5 h-4 w-4 shrink-0 text-slate-500"
                    }
                    aria-hidden="true"
                />
                <span>
                    {props.status.encrypted
                        ? `Encrypted with vault. ${props.status.held ? "Unlocked on the server while the device runs." : "Starting the device asks for the vault."}`
                        : props.hasVault
                          ? "Plaintext. Rotate it to a key encrypted with your vault."
                          : "Plaintext. Create a vault in Settings to encrypt SSH keys."}
                </span>
            </p>
            {props.status.encrypted && keyStatus === "older" ? (
                <p className="text-slate-400">
                    Encrypted with an older vault key. Rewrap it in the vault
                    settings.
                </p>
            ) : null}
            {unusable !== null ? (
                <p
                    role="alert"
                    className="flex items-start gap-2 text-amber-300"
                >
                    <TriangleAlert
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                    <span>{unusable}</span>
                </p>
            ) : null}
        </div>
    );
}

/** Tells the user whether the key line is gone from the device or still has to be cleaned up. */
function removalFeedback(
    deviceName: string,
    result: SshKeyRemovalResponse,
): SshKeyFeedback {
    if (result.removed_from_device) {
        return {
            tone: "success",
            message: `Removed the SSH key from ${deviceName} and from this server.`,
        };
    }

    return {
        tone: "error",
        message: `Deleted the SSH key from this server, but its line was left in the device's authorized_keys${result.device_error ? `: ${result.device_error}` : "."}`,
    };
}

/** Confirms removal, because the device falls back to the server's own credentials afterwards. */
function RemoveSshKeyDialog(props: {
    isOpen: boolean;
    agentId: string;
    deviceName: string;
    onClose: () => void;
    onRemoved: (result: SshKeyRemovalResponse) => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    const removeMutation = useMutation({
        mutationFn: async () => {
            // An encrypted key logs in to remove its own line only once unlocked.
            const fileKey = await currentSshKeyFileKey({
                api,
                vault,
                agentId: props.agentId,
                reason: `Remove the SSH key of ${props.deviceName}`,
            });

            return api.removeSshKey(
                props.agentId,
                fileKey === null ? undefined : { current_file_key: fileKey },
            );
        },
        onSuccess: async (result) => {
            await invalidateSshKeyQueries(queryClient, props.agentId);
            props.onRemoved(result);
        },
    });

    return (
        <ConfirmationDialog
            isOpen={props.isOpen}
            title={`Remove the SSH key of ${props.deviceName}?`}
            description="Removes the key from the device's authorized_keys and deletes it from this server. The device then logs in with this server's own SSH keys or ssh-agent, or needs a new key or password. The pinned host key is kept."
            confirmLabel="Remove key"
            busyLabel="Removing key..."
            isBusy={removeMutation.isPending}
            errorMessage={
                removeMutation.isError
                    ? vaultErrorMessage(
                          removeMutation.error,
                          "Failed to remove the SSH key",
                      )
                    : null
            }
            onClose={() => {
                if (removeMutation.isPending) return;
                removeMutation.reset();
                props.onClose();
            }}
            onConfirm={() => removeMutation.mutate()}
        />
    );
}

/**
 * Re-pins the device's host key after a change. Shows both fingerprints so the user decides
 * with the evidence in front of them; nothing is ever re-pinned automatically.
 */
function SshHostKeyRepinDialog(props: {
    isOpen: boolean;
    agentId: string;
    deviceName: string;
    onClose: () => void;
    onPinned: (fingerprint: string) => void;
}) {
    // Mounting only while open makes every opening probe the device again.
    if (!props.isOpen) {
        return null;
    }

    return (
        <SshHostKeyRepinDialogContent
            agentId={props.agentId}
            deviceName={props.deviceName}
            onClose={props.onClose}
            onPinned={props.onPinned}
        />
    );
}

/** Owns the probe and the pin request for one opening of the re-pin dialog. */
function SshHostKeyRepinDialogContent(props: {
    agentId: string;
    deviceName: string;
    onClose: () => void;
    onPinned: (fingerprint: string) => void;
}) {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const hostKeyQuery = useQuery(sshHostKeyQueryOptions(api, props.agentId));
    const hostKey = hostKeyQuery.data;

    const pinMutation = useMutation({
        mutationFn: (fingerprint: string) =>
            api.pinSshHostKey(props.agentId, {
                host_key_fingerprint: fingerprint,
            }),
        onSuccess: async (result) => {
            await queryClient.invalidateQueries({
                queryKey: queryKeys.agentConfiguration(props.agentId),
            });
            props.onPinned(result.fingerprint);
        },
    });

    const unchanged =
        hostKey !== undefined &&
        hostKey.pinned_fingerprint === hostKey.fingerprint;

    return (
        <Dialog
            isOpen
            title="Re-pin host key"
            description={`Checks the host key ${props.deviceName} presents now against the key pinned for it.`}
            closeAriaLabel="Close host key dialog"
            isBusy={pinMutation.isPending}
            errorMessage={
                pinMutation.isError
                    ? getErrorMessage(
                          pinMutation.error,
                          "Failed to pin the host key",
                      )
                    : hostKeyQuery.isError
                      ? getErrorMessage(
                            hostKeyQuery.error,
                            "Failed to fetch the host key",
                        )
                      : null
            }
            onClose={props.onClose}
        >
            <div className="mt-4 space-y-3 text-sm text-slate-300">
                {hostKeyQuery.isPending ? (
                    <p role="status" className="flex items-center gap-2">
                        <LoaderCircle
                            className="h-4 w-4 animate-spin text-blue-400"
                            aria-hidden="true"
                        />
                        Fetching the device's host key...
                    </p>
                ) : null}
                {hostKey !== undefined && unchanged ? (
                    <>
                        <p role="status">
                            The host key is unchanged. The device still presents
                            the pinned key, so there is nothing to re-pin.
                        </p>
                        <CopyableCodeRow
                            label={`Pinned host key (${hostKey.key_type})`}
                            value={hostKey.fingerprint}
                            copyAriaLabel="Copy pinned host key fingerprint"
                        />
                    </>
                ) : null}
                {hostKey !== undefined && !unchanged ? (
                    <>
                        <p
                            role="alert"
                            className="rounded border border-amber-800 bg-amber-950/30 px-3 py-2 text-amber-300"
                        >
                            The device presents a different host key. Trust it
                            only if you know why it changed, for example after
                            reinstalling the device. Otherwise someone may be
                            impersonating it.
                        </p>
                        <CopyableCodeRow
                            label="Pinned host key"
                            value={hostKey.pinned_fingerprint ?? "None"}
                            copyAriaLabel="Copy pinned host key fingerprint"
                        />
                        <CopyableCodeRow
                            label={`Presented host key (${hostKey.key_type})`}
                            value={hostKey.fingerprint}
                            copyAriaLabel="Copy presented host key fingerprint"
                        />
                    </>
                ) : null}
            </div>
            <DialogActions stackOnMobile>
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Close without changing the pinned host key"
                    disabled={pinMutation.isPending}
                    onClick={props.onClose}
                >
                    {unchanged ? "Close" : "Cancel"}
                </Button>
                {hostKey !== undefined && !unchanged ? (
                    <Button
                        type="button"
                        variant="warning"
                        tooltip="Replace the pinned host key with the one the device presents now"
                        isLoading={pinMutation.isPending}
                        disabled={pinMutation.isPending}
                        onClick={() => pinMutation.mutate(hostKey.fingerprint)}
                    >
                        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                        {pinMutation.isPending
                            ? "Pinning..."
                            : "Trust new host key"}
                    </Button>
                ) : null}
                {hostKeyQuery.isError ? (
                    <Button
                        type="button"
                        tooltip="Connect to the device again to read its host key"
                        onClick={() => void hostKeyQuery.refetch()}
                    >
                        Try again
                    </Button>
                ) : null}
            </DialogActions>
        </Dialog>
    );
}
