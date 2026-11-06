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
import type { ManualSshKeyResponse } from "#bindings/ManualSshKeyResponse";
import type { PrepareManualSshKeyRequest } from "#bindings/PrepareManualSshKeyRequest";
import type { SshHostKeyResponse } from "#bindings/SshHostKeyResponse";
import type { ApiClient } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
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
import {
    VaultUnlockCancelled,
    type VaultSession,
} from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/** Whether the dialog installs the device's first managed key or replaces the current one. */
export type SshKeySetupMode = "setup" | "rotate";

/**
 * How a first key gets onto the device: redoor logs in and installs it, or the user adds
 * the line themselves because redoor has no way to log in yet (for example on a host with
 * password login disabled).
 */
type InstallMethod = "automatic" | "manual";

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

/** Owns the probe and the enrollment requests for one opening of the dialog. */
function SshKeySetupDialogContent(props: SshKeySetupProps) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const vaultStatus = useQuery(vaultStatusQueryOptions(api));
    const [password, setPassword] = React.useState(props.initialPassword ?? "");
    const [method, setMethod] = React.useState<InstallMethod>("automatic");
    const needsHostKeyConfirmation = !props.hasPinnedHostKey;
    const isRotate = props.mode === "rotate";
    const isManual = !isRotate && method === "manual";

    const hostKeyQuery = useQuery({
        ...sshHostKeyQueryOptions(api, props.agentId),
        enabled: needsHostKeyConfirmation,
    });

    const hostKeyFingerprint = needsHostKeyConfirmation
        ? (hostKeyQuery.data?.fingerprint ?? null)
        : null;

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
                    hostKeyFingerprint,
                    password,
                }),
            ),
        // A first setup rewrites the device's configuration and stops its agent. Rotation
        // only switches the key file, but the configuration still reports the key state.
        onSuccess: () => invalidateSshKeyQueries(queryClient, props.agentId),
    });

    const { prepareMutation, confirmMutation, close } = useManualSetup({
        agentId: props.agentId,
        deviceName: props.deviceName,
        hostKeyFingerprint,
        onClose: props.onClose,
    });

    const enrolled = enrollMutation.data ?? confirmMutation.data;

    if (enrolled !== undefined) {
        return (
            <SshKeyInstalledStep
                deviceName={props.deviceName}
                isRotate={isRotate}
                fingerprint={enrolled.fingerprint}
                doneLabel={props.doneLabel}
                onClose={props.onClose}
            />
        );
    }

    const prepared = prepareMutation.data;

    if (prepared !== undefined) {
        return (
            <ManualInstallStep
                deviceName={props.deviceName}
                prepared={prepared}
                isVerifying={confirmMutation.isPending}
                errorMessage={
                    confirmMutation.isError
                        ? getErrorMessage(
                              confirmMutation.error,
                              "Failed to verify the SSH key",
                          )
                        : null
                }
                onConfirm={() => confirmMutation.mutate(prepared.fingerprint)}
                onClose={close}
            />
        );
    }

    const activeMutation = isManual ? prepareMutation : enrollMutation;
    const isPending = activeMutation.isPending;
    const hostKey = hostKeyQuery.data;

    const canSubmit =
        !isPending && (!needsHostKeyConfirmation || hostKey !== undefined);

    const errorMessage = setupErrorMessage(activeMutation.error, isManual);

    const hasVault =
        vaultStatus.data === undefined ? null : vaultStatus.data.vault !== null;

    return (
        <Dialog
            isOpen
            title={isRotate ? "Rotate SSH key" : "Set up a dedicated SSH key"}
            description={
                isRotate
                    ? `Creates a new key for ${props.deviceName}, installs it with the current key and then removes the current key from the device. A connected agent is not stopped.`
                    : `Creates an SSH key used only for ${props.deviceName} and adds it to the device's authorized_keys.`
            }
            closeAriaLabel="Close SSH key dialog"
            size="medium"
            isBusy={isPending}
            errorMessage={errorMessage}
            onClose={close}
        >
            <form
                className="mt-4 space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();

                    if (canSubmit) {
                        activeMutation.mutate();
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
                {isRotate ? null : (
                    <InstallMethodChoice
                        method={method}
                        disabled={isPending}
                        onChange={(value) => {
                            setMethod(value);
                            enrollMutation.reset();
                            prepareMutation.reset();
                        }}
                    />
                )}
                <SshKeyStorageNote hasVault={hasVault} />
                {props.mode === "setup" && !isManual ? (
                    <Password
                        label="SSH password (used once, not saved)"
                        value={password}
                        placeholder="Leave empty to try without a password"
                        description="Needed only when this server cannot log in yet. Redoor first tries a password stored for the device and this server's own SSH keys."
                        autoComplete="off"
                        ignoreIn1Password
                        required={false}
                        disabled={isPending}
                        onChange={(value) => {
                            setPassword(value);
                            enrollMutation.reset();
                        }}
                    />
                ) : null}
                {isPending ? (
                    <BusyStatus>
                        {isManual
                            ? "Creating the key..."
                            : "Installing the key on the device..."}
                    </BusyStatus>
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
                        disabled={isPending}
                        onClick={close}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        tooltip={submitTooltip({
                            needsHostKeyConfirmation,
                            isRotate,
                            isManual,
                        })}
                        disabled={!canSubmit}
                        isLoading={isPending}
                    >
                        {isPending ? (
                            <LoaderCircle
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <KeyRound className="h-4 w-4" aria-hidden="true" />
                        )}
                        {submitLabel({
                            isPending,
                            hasError: errorMessage !== null,
                            needsHostKeyConfirmation,
                            isRotate,
                            isManual,
                        })}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/**
 * The requests of a manual setup: preparing the key, confirming it was added, and
 * discarding it when the dialog closes before the confirmation succeeded, so a prepared
 * key does not linger on the server once the user gives up.
 */
function useManualSetup(options: {
    agentId: string;
    deviceName: string;
    hostKeyFingerprint: string | null;
    onClose: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    const prepareMutation = useMutation({
        mutationFn: async () =>
            api.prepareManualSshKey(
                options.agentId,
                await manualRequest({
                    api,
                    vault,
                    deviceName: options.deviceName,
                    hostKeyFingerprint: options.hostKeyFingerprint,
                }),
            ),
        // Preparing pins the host key, which the configuration page reports.
        onSuccess: () => invalidateSshKeyQueries(queryClient, options.agentId),
    });

    const confirmMutation = useMutation({
        mutationFn: (fingerprint: string) =>
            api.confirmManualSshKey(options.agentId, { fingerprint }),
        onSuccess: () => invalidateSshKeyQueries(queryClient, options.agentId),
    });

    const discardMutation = useMutation({
        mutationFn: () => api.discardManualSshKey(options.agentId),
    });

    const close = () => {
        if (prepareMutation.isSuccess && !confirmMutation.isSuccess) {
            discardMutation.mutate();
        }

        options.onClose();
    };

    return { prepareMutation, confirmMutation, close };
}

/** Confirms that the device now logs in with its new key and shows the key's fingerprint. */
function SshKeyInstalledStep(props: {
    deviceName: string;
    isRotate: boolean;
    fingerprint: string;
    doneLabel: string | undefined;
    onClose: () => void;
}) {
    return (
        <Dialog
            isOpen
            title={props.isRotate ? "SSH key rotated" : "SSH key installed"}
            closeAriaLabel="Close SSH key dialog"
            size="medium"
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
                        {props.isRotate
                            ? " A running connection stays connected, and every new connection uses the new key."
                            : " No password is stored for it. Connect the device again to use the new key."}
                    </span>
                </p>
                <CopyableCodeRow
                    label="New key fingerprint"
                    value={props.fingerprint}
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

/**
 * The message for a failed setup or preparation. Closing the vault dialog is the user's own
 * choice, so it returns to the form as it was instead of reporting a failure.
 */
function setupErrorMessage(error: Error | null, isManual: boolean) {
    if (error === null || error instanceof VaultUnlockCancelled) {
        return null;
    }

    return vaultErrorMessage(
        error,
        isManual
            ? "Failed to create the SSH key"
            : "Failed to set up the SSH key",
    );
}

/** A spinner with text, for the network round trips that take a while. */
function BusyStatus(props: { children: React.ReactNode }) {
    return (
        <p
            role="status"
            className="flex items-center gap-2 text-sm text-slate-300"
        >
            <LoaderCircle
                className="h-4 w-4 animate-spin text-blue-400"
                aria-hidden="true"
            />
            {props.children}
        </p>
    );
}

/** The submit button's tooltip, which says what pressing it does in the chosen flow. */
function submitTooltip(options: {
    needsHostKeyConfirmation: boolean;
    isRotate: boolean;
    isManual: boolean;
}): string {
    if (options.isManual) {
        return options.needsHostKeyConfirmation
            ? "Trust this host key for the device and create a key to add to it yourself"
            : "Create a key to add to the device yourself";
    }

    if (options.needsHostKeyConfirmation) {
        return "Trust this host key for the device and install a new SSH key on it";
    }

    return options.isRotate
        ? "Replace the device's SSH key with a new one"
        : "Install a new SSH key on the device";
}

/** The submit button's label, which follows the request's progress and the chosen flow. */
function submitLabel(options: {
    isPending: boolean;
    hasError: boolean;
    needsHostKeyConfirmation: boolean;
    isRotate: boolean;
    isManual: boolean;
}): string {
    if (options.isPending) {
        return options.isManual ? "Creating key..." : "Installing key...";
    }

    if (options.hasError) {
        return "Try again";
    }

    if (options.isManual) {
        return options.needsHostKeyConfirmation
            ? "Trust host key and create key"
            : "Create key";
    }

    if (options.needsHostKeyConfirmation) {
        return "Trust host key and install";
    }

    return options.isRotate ? "Rotate key" : "Install key";
}

/**
 * Lets the user pick who installs a first key. Redoor logging in is the default; adding
 * the line by hand is for devices redoor cannot log in to yet, such as hosts that only
 * accept keys redoor does not have.
 */
function InstallMethodChoice(props: {
    method: InstallMethod;
    disabled: boolean;
    onChange: (method: InstallMethod) => void;
}) {
    return (
        <RadioCardGroup
            legend="How to install the key"
            disabled={props.disabled}
            legendClassName="text-sm font-medium text-slate-300"
            optionsClassName="@xl:grid-cols-2"
        >
            <RadioCardOption
                name="ssh-key-install-method"
                value="automatic"
                label="Redoor installs it"
                description="Redoor logs in to the device once with a password or this server's own SSH keys."
                checked={props.method === "automatic"}
                layout="compact"
                onChange={() => props.onChange("automatic")}
            />
            <RadioCardOption
                name="ssh-key-install-method"
                value="manual"
                label="I add it myself"
                description="Run a command on the device yourself, for example when it does not allow password login."
                checked={props.method === "manual"}
                layout="compact"
                onChange={() => props.onChange("manual")}
            />
        </RadioCardGroup>
    );
}

/**
 * The second step of a manual setup: shows the command that adds the generated key to the
 * device and lets the user ask redoor to verify it. The key becomes the device's key only
 * once redoor logged in with it, and a failed check can be repeated after fixing the line.
 */
function ManualInstallStep(props: {
    deviceName: string;
    prepared: ManualSshKeyResponse;
    isVerifying: boolean;
    errorMessage: string | null;
    onConfirm: () => void;
    onClose: () => void;
}) {
    return (
        <Dialog
            isOpen
            title="Add the key to the device"
            description={`Run this command on ${props.deviceName} as the user redoor logs in as, for example in a console or an existing SSH session. It appends the new key to ~/.ssh/authorized_keys.`}
            closeAriaLabel="Close SSH key dialog"
            size="medium"
            isBusy={props.isVerifying}
            errorMessage={props.errorMessage}
            onClose={props.onClose}
        >
            <form
                className="mt-4 space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();

                    if (!props.isVerifying) {
                        props.onConfirm();
                    }
                }}
            >
                <CopyableCodeRow
                    label="Command"
                    value={props.prepared.install_command}
                    copyAriaLabel="Copy install command"
                    wrap
                />
                <CopyableCodeRow
                    label="authorized_keys line"
                    value={props.prepared.authorized_keys_line}
                    copyAriaLabel="Copy authorized_keys line"
                    wrap
                />
                <CopyableCodeRow
                    label="New key fingerprint"
                    value={props.prepared.fingerprint}
                />
                <p className="text-sm text-slate-400">
                    Redoor then logs in with the new key to check that it works
                    before the device starts using it.
                </p>
                {props.isVerifying ? (
                    <BusyStatus>Logging in with the new key...</BusyStatus>
                ) : null}
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        tooltip="Close and discard the new key. You can set up a key later from the device's configuration page."
                        disabled={props.isVerifying}
                        onClick={props.onClose}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        tooltip="Log in with the new key and start using it for the device"
                        disabled={props.isVerifying}
                        isLoading={props.isVerifying}
                    >
                        {props.isVerifying ? (
                            <LoaderCircle
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <ShieldCheck
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        )}
                        {props.isVerifying
                            ? "Verifying..."
                            : props.errorMessage !== null
                              ? "Check again"
                              : "I've added the key"}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/**
 * Builds the manual setup request, unlocking the vault first when the account has one,
 * because the new key is encrypted with it exactly like an automatically installed one.
 */
async function manualRequest(options: {
    api: ApiClient;
    vault: VaultSession;
    deviceName: string;
    hostKeyFingerprint: string | null;
}): Promise<PrepareManualSshKeyRequest> {
    const request: PrepareManualSshKeyRequest = {
        host_key_fingerprint: options.hostKeyFingerprint,
    };

    const seal = await newSshKeySealIfVault({
        api: options.api,
        vault: options.vault,
        reason: `Set up the SSH key of ${options.deviceName}`,
    });

    if (seal !== null) {
        request.vault = seal;
    }

    return request;
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
