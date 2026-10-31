import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
    CheckCircle2,
    KeyRound,
    LoaderCircle,
    LockKeyhole,
    ShieldCheck,
} from "lucide-react";

import type { EnrollSshKeyRequest } from "#bindings/EnrollSshKeyRequest";
import type { SshHostKeyResponse } from "#bindings/SshHostKeyResponse";
import type { ApiClient } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import {
    invalidateSshKeyQueries,
    sshHostKeyQueryOptions,
    vaultStatusQueryOptions,
} from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import {
    currentSshKeyFileKey,
    newSshKeySealIfVault,
} from "#ui/vault/ssh-key-vault";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import type { VaultSession } from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/** Whether the dialog installs the device's first managed key or replaces the current one. */
export type SshKeySetupMode = "setup" | "rotate";

/** Props shared by the dialog shell and its content, which only exists while it is open. */
type SshKeySetupProps = {
    agentId: string;
    deviceName: string;
    mode: SshKeySetupMode;
    /**
     * With a pinned host key the server checks the device against the pin itself, so the
     * user is not asked to confirm a fingerprint they already confirmed once.
     */
    hasPinnedHostKey: boolean;
    /** Password typed earlier in the add-device form, so it does not have to be typed twice. */
    initialPassword?: string;
    /** Label of the button that closes the dialog after the key was installed. */
    doneLabel?: string;
    onClose: () => void;
};

/**
 * Walks the user through creating a dedicated SSH key for one device: confirm the host key
 * the device presents, optionally type the login password once, and install the key. Shared
 * by the add-device form and the device's configuration page so both run the same flow.
 */
export function SshKeySetupDialog(
    props: SshKeySetupProps & { isOpen: boolean },
) {
    // Mounting the content only while open drops the typed password, the host key probe and
    // the last result when the dialog closes, so reopening always starts a fresh attempt.
    if (!props.isOpen) {
        return null;
    }

    return (
        <SshKeySetupDialogContent
            agentId={props.agentId}
            deviceName={props.deviceName}
            mode={props.mode}
            hasPinnedHostKey={props.hasPinnedHostKey}
            initialPassword={props.initialPassword}
            doneLabel={props.doneLabel}
            onClose={props.onClose}
        />
    );
}

/** Owns the probe and the enrollment request for one opening of the dialog. */
function SshKeySetupDialogContent(props: SshKeySetupProps) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const vaultStatus = useQuery(vaultStatusQueryOptions(api));
    const [password, setPassword] = React.useState(props.initialPassword ?? "");
    const needsHostKeyConfirmation = !props.hasPinnedHostKey;

    const hostKeyQuery = useQuery({
        ...sshHostKeyQueryOptions(api, props.agentId),
        enabled: needsHostKeyConfirmation,
    });

    const enrollMutation = useMutation({
        mutationFn: async () =>
            api.enrollSshKey(
                props.agentId,
                await enrollRequest({
                    api,
                    vault,
                    agentId: props.agentId,
                    deviceName: props.deviceName,
                    mode: props.mode,
                    hostKeyFingerprint: needsHostKeyConfirmation
                        ? (hostKeyQuery.data?.fingerprint ?? null)
                        : null,
                    password,
                }),
            ),
        // A first setup rewrites the device's configuration and stops its agent. Rotation
        // only switches the key file, but the configuration still reports the key state.
        onSuccess: () => invalidateSshKeyQueries(queryClient, props.agentId),
    });

    const isRotate = props.mode === "rotate";
    const title = isRotate ? "Rotate SSH key" : "Set up a dedicated SSH key";

    if (enrollMutation.isSuccess) {
        return (
            <Dialog
                isOpen
                title={isRotate ? "SSH key rotated" : "SSH key installed"}
                closeAriaLabel="Close SSH key dialog"
                onClose={props.onClose}
            >
                <div className="mt-4 space-y-4 text-sm text-slate-300">
                    <p role="status" className="flex items-start gap-2">
                        <CheckCircle2
                            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                            aria-hidden="true"
                        />
                        <span>
                            {props.deviceName} now logs in with its own SSH key.
                            {isRotate
                                ? " A running connection stays connected, and every new connection uses the new key."
                                : " No password is stored for it. Connect the device again to use the new key."}
                        </span>
                    </p>
                    <CopyableCodeRow
                        label="New key fingerprint"
                        value={enrollMutation.data.fingerprint}
                    />
                </div>
                <DialogActions>
                    <Button
                        type="button"
                        tooltip="Close this dialog"
                        onClick={props.onClose}
                    >
                        {props.doneLabel ?? "Done"}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    const hostKey = hostKeyQuery.data;

    const canSubmit =
        !enrollMutation.isPending &&
        (!needsHostKeyConfirmation || hostKey !== undefined);

    const errorMessage = enrollMutation.isError
        ? vaultErrorMessage(
              enrollMutation.error,
              "Failed to set up the SSH key",
          )
        : null;

    const hasVault =
        vaultStatus.data === undefined ? null : vaultStatus.data.vault !== null;

    return (
        <Dialog
            isOpen
            title={title}
            description={
                isRotate
                    ? `Creates a new key for ${props.deviceName}, installs it with the current key and then removes the current key from the device. A connected agent is not stopped.`
                    : `Creates an SSH key used only for ${props.deviceName} and installs it in the device's authorized_keys.`
            }
            closeAriaLabel="Close SSH key dialog"
            isBusy={enrollMutation.isPending}
            errorMessage={errorMessage}
            onClose={props.onClose}
        >
            <form
                className="mt-4 space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();

                    if (canSubmit) {
                        enrollMutation.mutate();
                    }
                }}
            >
                {needsHostKeyConfirmation ? (
                    <HostKeyConfirmation
                        isLoading={hostKeyQuery.isPending}
                        error={
                            hostKeyQuery.isError
                                ? getErrorMessage(
                                      hostKeyQuery.error,
                                      "Failed to fetch the host key",
                                  )
                                : null
                        }
                        hostKey={hostKey}
                        onRetry={() => void hostKeyQuery.refetch()}
                    />
                ) : null}
                <SshKeyStorageNote hasVault={hasVault} />
                {props.mode === "setup" ? (
                    <Password
                        label="SSH password (used once, not saved)"
                        value={password}
                        placeholder="Leave empty to try without a password"
                        description="Needed only when this server cannot log in yet. Redoor first tries a password stored for the device and this server's own SSH keys."
                        autoComplete="current-password"
                        required={false}
                        disabled={enrollMutation.isPending}
                        onChange={(value) => {
                            setPassword(value);
                            enrollMutation.reset();
                        }}
                    />
                ) : null}
                {enrollMutation.isPending ? (
                    <p
                        role="status"
                        className="flex items-center gap-2 text-sm text-slate-300"
                    >
                        <LoaderCircle
                            className="h-4 w-4 animate-spin text-blue-400"
                            aria-hidden="true"
                        />
                        Installing the key on the device...
                    </p>
                ) : null}
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        tooltip={
                            isRotate
                                ? "Keep using the current key"
                                : "Close without creating a key. You can set it up later from the device's configuration page."
                        }
                        disabled={enrollMutation.isPending}
                        onClick={props.onClose}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        tooltip={
                            needsHostKeyConfirmation
                                ? "Trust this host key for the device and install a new SSH key on it"
                                : isRotate
                                  ? "Replace the device's SSH key with a new one"
                                  : "Install a new SSH key on the device"
                        }
                        disabled={!canSubmit}
                        isLoading={enrollMutation.isPending}
                    >
                        {enrollMutation.isPending ? (
                            <LoaderCircle
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <KeyRound className="h-4 w-4" aria-hidden="true" />
                        )}
                        {enrollMutation.isPending
                            ? "Installing key..."
                            : errorMessage !== null
                              ? "Try again"
                              : needsHostKeyConfirmation
                                ? "Trust host key and install"
                                : isRotate
                                  ? "Rotate key"
                                  : "Install key"}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/**
 * Builds the enrollment request, unlocking the vault when the key needs it: an account with
 * a vault encrypts every new key with it, and a rotation of an encrypted key logs in with
 * the current key, which needs its file key.
 */
async function enrollRequest(options: {
    api: ApiClient;
    vault: VaultSession;
    agentId: string;
    deviceName: string;
    mode: SshKeySetupMode;
    hostKeyFingerprint: string | null;
    password: string;
}): Promise<EnrollSshKeyRequest> {
    const reason = `${options.mode === "rotate" ? "Rotate" : "Set up"} the SSH key of ${options.deviceName}`;

    const request: EnrollSshKeyRequest = {
        host_key_fingerprint: options.hostKeyFingerprint,
        // Rotation logs in with the current key, so a typed password is never sent.
        password:
            options.mode === "setup" && options.password !== ""
                ? options.password
                : null,
    };

    const seal = await newSshKeySealIfVault({
        api: options.api,
        vault: options.vault,
        reason,
    });

    if (seal !== null) {
        request.vault = seal;
    }

    if (options.mode === "rotate") {
        const currentFileKey = await currentSshKeyFileKey({
            api: options.api,
            vault: options.vault,
            agentId: options.agentId,
            reason,
        });

        if (currentFileKey !== null) {
            request.current_file_key = currentFileKey;
        }
    }

    return request;
}

/**
 * Tells the user how the new key is stored on this server: encrypted with the vault, which
 * then asks to be unlocked, or in plaintext until they create a vault.
 */
function SshKeyStorageNote(props: { hasVault: boolean | null }) {
    if (props.hasVault === null) {
        return null;
    }

    return (
        <p className="flex items-start gap-2 text-sm text-slate-400">
            <LockKeyhole
                className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
                aria-hidden="true"
            />
            <span>
                {props.hasVault
                    ? "The key is encrypted with your vault, so you unlock the vault to install it and whenever you start the device."
                    : "The key is stored unencrypted on this server. Create a vault in Settings to keep SSH keys encrypted; existing keys can then be rotated to encrypted ones."}
            </span>
        </p>
    );
}

/**
 * Shows the fingerprint the device presented so the user can compare it with the one on the
 * device before any credential is sent to it.
 */
function HostKeyConfirmation(props: {
    isLoading: boolean;
    error: string | null;
    hostKey: SshHostKeyResponse | undefined;
    onRetry: () => void;
}) {
    if (props.isLoading) {
        return (
            <p
                role="status"
                className="flex items-center gap-2 text-sm text-slate-300"
            >
                <LoaderCircle
                    className="h-4 w-4 animate-spin text-blue-400"
                    aria-hidden="true"
                />
                Fetching the device's host key...
            </p>
        );
    }

    if (props.hostKey === undefined) {
        return (
            <div className="space-y-3">
                <p
                    role="alert"
                    className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 whitespace-pre-line break-words"
                >
                    {props.error ?? "Failed to fetch the host key"}
                </p>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip="Connect to the device again to read its host key"
                    onClick={props.onRetry}
                >
                    Fetch host key again
                </Button>
            </div>
        );
    }

    const pinned = props.hostKey.pinned_fingerprint;
    const changed = pinned !== null && pinned !== props.hostKey.fingerprint;

    return (
        <section aria-label="Host key confirmation" className="space-y-3">
            <p className="text-sm text-slate-300">
                Confirm that this is the host key of the device. Compare it with
                the output of{" "}
                <code className="font-mono text-xs text-slate-200">
                    ssh-keygen -lf /etc/ssh/ssh_host_{"<type>"}_key.pub
                </code>{" "}
                on the device.
            </p>
            <CopyableCodeRow
                label={`Host key (${props.hostKey.key_type})`}
                value={props.hostKey.fingerprint}
                copyAriaLabel="Copy host key fingerprint"
            />
            {props.hostKey.previously_trusted ? (
                <p className="flex items-start gap-2 text-xs text-emerald-300">
                    <ShieldCheck
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                    This server's known_hosts already trusts this key for the
                    device.
                </p>
            ) : null}
            {changed ? (
                <p
                    role="alert"
                    className="rounded border border-amber-800 bg-amber-950/30 px-3 py-2 text-sm text-amber-300"
                >
                    The device presents a different key than the one pinned
                    earlier ({pinned}). Re-pin the host key first if the change
                    is expected.
                </p>
            ) : null}
        </section>
    );
}
