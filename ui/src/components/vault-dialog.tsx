import React from "react";
import {
    useIsMutating,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Fingerprint, LockKeyhole } from "lucide-react";

import type { VaultLockAfter } from "#bindings/VaultLockAfter";
import type { VaultSummary } from "#bindings/VaultSummary";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import { Select } from "#ui/components/select";
import { TextField } from "#ui/components/text-field";
import { queryKeys, vaultStatusQueryOptions } from "#ui/queries";
import { wipe } from "#ui/vault/vault-crypto";
import { vaultDebug } from "#ui/vault/vault-debug";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    NewPassphraseFields,
    PasswordlessWarning,
    newPassphraseProblem,
} from "#ui/components/vault/new-passphrase-fields";
import {
    buildNewVault,
    newPassphraseKek,
    openGenerations,
    openPasskeySlot,
    openPassphraseSlot,
    type OpenedSlot,
    type SlotToWrap,
} from "#ui/vault/vault-keys";
import {
    currentRpId,
    derivePasskeyKek,
    isPasskeySupported,
    newPasskeySlot,
    usablePasskeySlots,
} from "#ui/vault/vault-passkeys";
import { DEFAULT_VAULT_LOCK_AFTER } from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/**
 * Shared by every create and unlock mutation of the dialog, so the dialog can tell that a
 * passkey prompt or key derivation is running without lifting each form's state.
 */
const vaultDialogMutationKey = ["vault-dialog"] as const;

/**
 * The lock choices the dialog offers, shortest first, with their labels. Exported so the
 * settings page names the active choice with the same words.
 */
export const LOCK_AFTER_OPTIONS = [
    { value: "15_minutes", label: "15 minutes" },
    { value: "1_hour", label: "1 hour" },
    { value: "24_hours", label: "24 hours" },
    { value: "1_week", label: "1 week" },
    { value: "never", label: "Until I lock it" },
] as const satisfies readonly { value: VaultLockAfter; label: string }[];

/**
 * The passkey prompt the dialog may be waiting on. Unlike key derivation, the prompt can be
 * given up safely, and it may never settle on its own: a password manager that draws its
 * prompt into the page can be blocked by its own other notifications, which the modal dialog
 * makes impossible to dismiss. So cancelling stays possible while only the prompt is pending.
 */
type PasskeyPrompt = {
    /** Whether a passkey prompt is pending, so cancelling would abort it. */
    isWaiting: boolean;
    /** Runs a passkey prompt that `abort` can cancel. */
    run: <T>(prompt: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    /** Aborts the pending passkey prompt, if any. */
    abort: () => void;
};

/**
 * Tracks the pending passkey prompt of the dialog. It lives in the dialog rather than in each
 * form, because the dialog's close button, Escape and backdrop cancel too.
 */
function usePasskeyPrompt(): PasskeyPrompt {
    const controllerRef = React.useRef<AbortController | null>(null);
    const [isWaiting, setIsWaiting] = React.useState(false);

    const run = React.useCallback(
        async <T,>(prompt: (signal: AbortSignal) => Promise<T>) => {
            const controller = new AbortController();

            vaultDebug("dialog passkey prompt run", {
                replacesPendingPrompt: controllerRef.current !== null,
            });

            controllerRef.current = controller;
            setIsWaiting(true);

            try {
                const result = await prompt(controller.signal);

                // A prompt that settles just as the user cancels must not go on to unlock
                // the vault for flows that have already failed.
                controller.signal.throwIfAborted();

                vaultDebug("dialog passkey prompt done");

                return result;
            } catch (error) {
                vaultDebug("dialog passkey prompt failed", {
                    aborted: controller.signal.aborted,
                    error: String(error),
                });

                throw error;
            } finally {
                if (controllerRef.current === controller) {
                    controllerRef.current = null;
                }

                setIsWaiting(false);
            }
        },
        [],
    );

    const abort = React.useCallback(() => {
        vaultDebug("dialog passkey prompt abort", {
            hadPendingPrompt: controllerRef.current !== null,
        });
        controllerRef.current?.abort();
    }, []);

    return { isWaiting, run, abort };
}

/** Reads the vault session from the router context with its current lock state. */
export function useVaultSession() {
    const { vault } = rootRouteApi.useRouteContext();

    const state = React.useSyncExternalStore(
        vault.subscribe,
        vault.getSnapshot,
    );

    return { session: vault, state };
}

/**
 * Says that keeping the key needs both halves, so the user does not take the stored key for
 * a usable one: this browser keeps it encrypted, and the server keeps the secret that opens
 * it for this login session only, until the vault locks.
 */
const KEPT_KEY_HINT =
    "The key is kept in this browser, encrypted with a secret that only the server holds for this login session. Both are needed to open it, and the server forgets its secret when the vault locks.";

/**
 * What the picked lock choice does. Every choice works the same way, so the server enforces
 * the limit even while no redoor tab is open.
 */
function lockAfterHint(lockAfter: VaultLockAfter): string {
    if (lockAfter === "never") {
        return `Stays unlocked until you lock it, sign out, your session ends or the server restarts. ${KEPT_KEY_HINT}`;
    }

    const option = LOCK_AFTER_OPTIONS.find(
        (candidate) => candidate.value === lockAfter,
    );

    return `Locks after ${option?.label ?? lockAfter} without use, when you sign out or your session ends, or when the server restarts. ${KEPT_KEY_HINT}`;
}

/** How long the vault stays unlocked without use. The default is the shortest choice. */
function LockOptions(props: {
    lockAfter: VaultLockAfter;
    disabled: boolean;
    onLockAfterChange: (lockAfter: VaultLockAfter) => void;
}) {
    const selectId = React.useId();
    const hintId = React.useId();

    return (
        <div className="mt-4 grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <label
                    htmlFor={selectId}
                    className="text-sm font-medium text-slate-300"
                >
                    Stay unlocked for
                </label>
                <Select
                    id={selectId}
                    value={props.lockAfter}
                    disabled={props.disabled}
                    aria-describedby={hintId}
                    onChange={(event) => {
                        const choice = LOCK_AFTER_OPTIONS.find(
                            (option) => option.value === event.target.value,
                        );

                        if (choice !== undefined) {
                            props.onLockAfterChange(choice.value);
                        }
                    }}
                    containerClassName="min-w-40"
                >
                    {LOCK_AFTER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </Select>
            </div>
            <p id={hintId} className="text-xs text-slate-500">
                {lockAfterHint(props.lockAfter)}
            </p>
        </div>
    );
}

/**
 * Creates the vault with a passkey, a passphrase or both. Every slot wraps the same key, so
 * either alone unlocks; without a passphrase the warning names what can go wrong.
 */
function CreateVaultForm(props: {
    passkeyPrompt: PasskeyPrompt;
    onCancel: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const passkeysSupported = isPasskeySupported();
    const hostname = currentRpId();

    const [label, setLabel] = React.useState(`Vault on ${hostname}`);
    const [usePasskey, setUsePasskey] = React.useState(false);
    const [passkeyLabel, setPasskeyLabel] = React.useState("");
    const [usePassphrase, setUsePassphrase] = React.useState(true);
    const [passphrase, setPassphrase] = React.useState("");
    const [confirmation, setConfirmation] = React.useState("");

    const [lockAfter, setLockAfter] = React.useState<VaultLockAfter>(
        DEFAULT_VAULT_LOCK_AFTER,
    );

    const [validation, setValidation] = React.useState<string | null>(null);
    const withPasskey = passkeysSupported && usePasskey;
    const withPassphrase = usePassphrase || !passkeysSupported;

    const create = useMutation({
        mutationKey: vaultDialogMutationKey,
        mutationFn: async () => {
            const {
                request,
                vault: unlocked,
                raw,
            } = await buildNewVault({
                label: label.trim(),
                // The passkey prompt comes first, while the click still counts as the user
                // gesture that some browsers require; Argon2id takes seconds.
                slots: async (vaultId) => {
                    const slots: SlotToWrap[] = [];

                    if (withPasskey) {
                        slots.push(
                            await props.passkeyPrompt.run((signal) =>
                                newPasskeySlot(
                                    vaultId,
                                    passkeyLabel.trim() || "Passkey",
                                    signal,
                                ),
                            ),
                        );
                    }

                    if (withPassphrase) {
                        slots.push({
                            id: null,
                            kek: await newPassphraseKek(passphrase),
                        });
                    }

                    return slots;
                },
            });

            try {
                await api.createVault(request);
                await vault.unlock(unlocked, lockAfter, raw);
            } finally {
                wipe(raw);
            }
        },
        // Also after a failure: the vault may exist even though keeping it unlocked failed,
        // and the dialog must then offer to unlock it instead of creating it again.
        onSettled: () =>
            queryClient.invalidateQueries({ queryKey: queryKeys.vault() }),
    });

    /** Checks the choices before the passkey prompt and the slow key derivation start. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const problem =
            !withPasskey && !withPassphrase
                ? "Choose a passkey, a passphrase or both"
                : withPassphrase
                  ? newPassphraseProblem(passphrase, confirmation)
                  : null;

        setValidation(problem);

        vaultDebug("create vault submitted", {
            withPasskey,
            withPassphrase,
            problem,
            alreadyPending: create.isPending,
        });

        if (problem === null) {
            create.mutate();
        }
    };

    const error =
        validation ??
        (create.error
            ? vaultErrorMessage(create.error, "Failed to create the vault")
            : null);

    return (
        <form noValidate onSubmit={submit} className="mt-4 grid gap-4">
            <p className="text-sm text-slate-400">
                The vault encrypts files ending in <code>.redoorencrypted</code>
                . Its key never leaves this browser; devices only store
                ciphertext. Without a registered passkey or the passphrase,
                encrypted files cannot be opened.
            </p>
            <TextField
                label="Vault name"
                value={label}
                placeholder="Vault on this server"
                description="Shown in other vaults' error messages about these files"
                required
                disabled={create.isPending}
                onChange={setLabel}
            />
            {passkeysSupported ? (
                <div className="grid gap-3">
                    <Checkbox
                        role="checkbox"
                        checked={usePasskey}
                        disabled={create.isPending}
                        onCheckedChange={setUsePasskey}
                        title={false}
                    >
                        Unlock with a passkey
                    </Checkbox>
                    {usePasskey ? (
                        <TextField
                            label="Passkey name"
                            value={passkeyLabel}
                            placeholder="Passkey"
                            description={`Works only on ${hostname}`}
                            disabled={create.isPending}
                            onChange={setPasskeyLabel}
                        />
                    ) : null}
                    <Checkbox
                        role="checkbox"
                        checked={usePassphrase}
                        disabled={create.isPending}
                        onCheckedChange={setUsePassphrase}
                        title={false}
                    >
                        Unlock with a passphrase
                    </Checkbox>
                </div>
            ) : null}
            {withPassphrase ? (
                <NewPassphraseFields
                    label="Passphrase"
                    repeatLabel="Repeat passphrase"
                    passphrase={passphrase}
                    repeated={confirmation}
                    disabled={create.isPending}
                    onChange={(next, repeated) => {
                        setPassphrase(next);
                        setConfirmation(repeated);
                    }}
                />
            ) : null}
            {withPasskey && !withPassphrase ? (
                <PasswordlessWarning hosts={[hostname]} />
            ) : null}
            <LockOptions
                lockAfter={lockAfter}
                disabled={create.isPending}
                onLockAfterChange={setLockAfter}
            />
            {error === null ? null : (
                <p role="alert" className="text-sm text-red-300">
                    {error}
                </p>
            )}
            <DialogActions stackOnMobile>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={props.onCancel}
                    disabled={
                        create.isPending && !props.passkeyPrompt.isWaiting
                    }
                >
                    Cancel
                </Button>
                <Button type="submit" isLoading={create.isPending}>
                    <LockKeyhole className="h-4 w-4" aria-hidden="true" />
                    {create.isPending ? "Creating…" : "Create vault"}
                </Button>
            </DialogActions>
        </form>
    );
}

/**
 * Unlocks with one prompt for every registered passkey of this hostname, or the passphrase
 * if the vault has one.
 */
function UnlockVaultForm(props: {
    summary: VaultSummary;
    passkeyPrompt: PasskeyPrompt;
    onCancel: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const [passphrase, setPassphrase] = React.useState("");

    const [lockAfter, setLockAfter] = React.useState<VaultLockAfter>(
        DEFAULT_VAULT_LOCK_AFTER,
    );

    // Logged because a remount drops the pending mutations, which could make the user
    // press the passkey button again while the first prompt is still open.
    React.useEffect(() => {
        vaultDebug("unlock form mounted");

        return () => vaultDebug("unlock form unmounted");
    }, []);

    // Loaded with the dialog, so the passkey prompt starts directly from the click: some
    // browsers require the user gesture that a fetch in between would consume.
    const materialQuery = useQuery({
        queryKey: [...queryKeys.vault(), "unlock-material"],
        queryFn: () => api.getVaultUnlockMaterial(),
        staleTime: 0,
        gcTime: 0,
    });

    const passkeys =
        materialQuery.data === undefined
            ? []
            : usablePasskeySlots(materialQuery.data);

    /** Installs the keys an opened slot unwrapped, then wipes its raw copy. */
    const finish = async (opened: OpenedSlot) => {
        const material = materialQuery.data;

        if (material === undefined) {
            throw new Error("The vault is still loading");
        }

        try {
            await vault.unlock(
                await openGenerations(material, opened.rawVaultKey),
                lockAfter,
                opened.rawVaultKey,
            );
        } finally {
            wipe(opened.rawVaultKey);
        }

        void api.markVaultSlotUsed(opened.slot.id).catch(() => undefined);
    };

    const withPassphrase = useMutation({
        mutationKey: vaultDialogMutationKey,
        mutationFn: async () => {
            const material =
                materialQuery.data ?? (await materialQuery.refetch()).data;

            if (material === undefined) {
                throw new Error("Could not load the vault");
            }

            await finish(await openPassphraseSlot(material, passphrase));
        },
    });

    const withPasskey = useMutation({
        mutationKey: vaultDialogMutationKey,
        mutationFn: async () => {
            const material = materialQuery.data;

            if (material === undefined) {
                throw new Error("The vault is still loading");
            }

            const { slot, kek } = await props.passkeyPrompt.run((signal) =>
                derivePasskeyKek(material, passkeys, signal),
            );

            await finish(await openPasskeySlot(material, slot, kek));
        },
    });

    const isBusy = withPassphrase.isPending || withPasskey.isPending;
    const failure = withPassphrase.error ?? withPasskey.error;

    const otherHostPasskeys = props.summary.slots.filter(
        (slot) => slot.type === "passkey" && slot.rp_id !== currentRpId(),
    );

    const hasPassphrase = props.summary.slots.some(
        (slot) => slot.type === "passphrase",
    );

    return (
        <form
            noValidate
            onSubmit={(event) => {
                event.preventDefault();

                vaultDebug("unlock form submitted", {
                    hasPassphrase,
                    isBusy,
                });

                if (hasPassphrase) {
                    withPasskey.reset();
                    withPassphrase.mutate();
                }
            }}
            className="mt-4 grid gap-4"
        >
            <p className="text-sm text-slate-400">{props.summary.label}</p>
            {passkeys.length > 0 && isPasskeySupported() ? (
                <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    tooltip="Unlock with any passkey registered for this vault"
                    isLoading={withPasskey.isPending}
                    disabled={isBusy}
                    onClick={(event) => {
                        vaultDebug("unlock with passkey clicked", {
                            isBusy,
                            materialLoaded: materialQuery.data !== undefined,
                            materialFetching: materialQuery.isFetching,
                            passkeys: passkeys.length,
                            detail: event.detail,
                            isTrusted: event.isTrusted,
                        });
                        withPassphrase.reset();
                        withPasskey.mutate();
                    }}
                >
                    <Fingerprint className="h-4 w-4" aria-hidden="true" />
                    Unlock with passkey
                </Button>
            ) : null}
            {otherHostPasskeys.length > 0 && passkeys.length === 0 ? (
                <p className="text-xs text-slate-500">
                    The registered passkeys belong to{" "}
                    {[
                        ...new Set(otherHostPasskeys.map((slot) => slot.rp_id)),
                    ].join(", ")}
                    , and you are on {currentRpId()}.{" "}
                    {hasPassphrase
                        ? "Use the passphrase here."
                        : "This vault has no passphrase, so open redoor there to unlock it."}
                </p>
            ) : null}
            {hasPassphrase ? (
                <Password
                    label="Passphrase"
                    value={passphrase}
                    autoComplete="current-password"
                    disabled={isBusy}
                    onChange={setPassphrase}
                />
            ) : null}
            <LockOptions
                lockAfter={lockAfter}
                disabled={isBusy}
                onLockAfterChange={setLockAfter}
            />
            {failure ? (
                <p role="alert" className="text-sm text-red-300">
                    {vaultErrorMessage(failure, "Failed to unlock the vault")}
                </p>
            ) : null}
            <DialogActions stackOnMobile>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={props.onCancel}
                    disabled={isBusy && !props.passkeyPrompt.isWaiting}
                >
                    Cancel
                </Button>
                {hasPassphrase ? (
                    <Button
                        type="submit"
                        isLoading={withPassphrase.isPending}
                        disabled={isBusy || passphrase === ""}
                    >
                        <LockKeyhole className="h-4 w-4" aria-hidden="true" />
                        {withPassphrase.isPending ? "Unlocking…" : "Unlock"}
                    </Button>
                ) : null}
            </DialogActions>
        </form>
    );
}

/**
 * The one place that creates or unlocks the vault. It opens whenever a flow waits in
 * `VaultSession.requestUnlock`, so the editor, uploads and downloads share it.
 */
export function VaultDialog() {
    const { api } = rootRouteApi.useRouteContext();
    const { session, state } = useVaultSession();
    const isOpen = state.pendingReason !== null;

    // While key derivation runs, Escape, the back gesture or a stray backdrop tap must not
    // cancel the waiting flows: the unlock would then succeed with nobody waiting for it, and
    // the flow would already have failed. A pending passkey prompt is aborted instead, so
    // cancelling stays possible while only the prompt is pending.
    const passkeyPrompt = usePasskeyPrompt();

    const isBusy =
        useIsMutating({ mutationKey: vaultDialogMutationKey }) > 0 &&
        !passkeyPrompt.isWaiting;

    const statusQuery = useQuery({
        ...vaultStatusQueryOptions(api),
        enabled: isOpen,
    });

    // Logged so a bug report shows when the dialog opened and closed around each prompt.
    React.useEffect(() => {
        vaultDebug(isOpen ? "vault dialog open" : "vault dialog closed", {
            reason: state.pendingReason,
        });
    }, [isOpen, state.pendingReason]);

    if (!isOpen) {
        return null;
    }

    const summary = statusQuery.data?.vault;

    const cancel = () => {
        vaultDebug("vault dialog cancel", {
            promptWaiting: passkeyPrompt.isWaiting,
            isBusy,
        });
        passkeyPrompt.abort();
        session.cancelPending();
    };

    return (
        <Dialog
            isOpen
            title={summary === null ? "Create vault" : "Unlock vault"}
            description={state.pendingReason}
            closeAriaLabel="Cancel"
            isBusy={isBusy}
            onClose={cancel}
        >
            {statusQuery.isError ? (
                <p role="alert" className="mt-4 text-sm text-red-300">
                    {vaultErrorMessage(
                        statusQuery.error,
                        "Could not load the vault",
                    )}
                </p>
            ) : summary === undefined ? (
                <p className="mt-4 text-sm text-slate-400">Loading vault…</p>
            ) : summary === null ? (
                <CreateVaultForm
                    passkeyPrompt={passkeyPrompt}
                    onCancel={cancel}
                />
            ) : (
                <UnlockVaultForm
                    summary={summary}
                    passkeyPrompt={passkeyPrompt}
                    onCancel={cancel}
                />
            )}
        </Dialog>
    );
}
