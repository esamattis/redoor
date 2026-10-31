import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Fingerprint, LockKeyhole } from "lucide-react";

import type { VaultSummary } from "#bindings/VaultSummary";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import { TextField } from "#ui/components/text-field";
import { queryKeys, vaultStatusQueryOptions } from "#ui/queries";
import { wipe } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    buildNewVault,
    newPassphraseKek,
    openGenerations,
    openPasskeySlot,
    openPassphraseSlot,
    passphraseProblem,
    type OpenedSlot,
} from "#ui/vault/vault-keys";
import {
    derivePasskeyKek,
    isPasskeySupported,
    usablePasskeySlots,
} from "#ui/vault/vault-passkeys";

const rootRouteApi = getRouteApi("__root__");

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
 * The "Keep unlocked on this device" choice. Off by default, and worded plainly: the key
 * stays non-extractable, which only stops script from exporting it.
 */
function KeepUnlockedOption(props: {
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
}) {
    const descriptionId = React.useId();

    return (
        <div className="mt-4">
            <Checkbox
                role="checkbox"
                checked={props.checked}
                disabled={props.disabled}
                onCheckedChange={props.onChange}
                aria-describedby={descriptionId}
                title={false}
            >
                Keep unlocked on this device
            </Checkbox>
            <p id={descriptionId} className="mt-1 text-xs text-slate-500">
                The vault stays unlocked across reloads and browser restarts,
                with no automatic lock, until you lock it. Anyone who can use or
                copy this browser profile can open your vault files until then.
            </p>
        </div>
    );
}

/** Creates the vault: a passphrase is required, passkeys can be added in the settings. */
function CreateVaultForm(props: { onCancel: () => void }) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    const [label, setLabel] = React.useState(
        `Vault on ${window.location.hostname}`,
    );

    const [passphrase, setPassphrase] = React.useState("");
    const [confirmation, setConfirmation] = React.useState("");
    const [keep, setKeep] = React.useState(false);
    const [validation, setValidation] = React.useState<string | null>(null);

    const create = useMutation({
        mutationFn: async () => {
            const { request, vault: unlocked } = await buildNewVault({
                label: label.trim(),
                passphrase: await newPassphraseKek(passphrase),
            });

            await api.createVault(request);
            await vault.unlock(unlocked, keep);
        },
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: queryKeys.vault() }),
    });

    /** Checks the passphrase before the slow key derivation starts. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const problem =
            passphraseProblem(passphrase) ??
            (passphrase === confirmation ? null : "The passphrases differ");

        setValidation(problem);

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
                The vault encrypts files ending in <code>.redoorvault</code>.
                Its key never leaves this browser; devices only store
                ciphertext. Keep the passphrase safe: without it, or a
                registered passkey, encrypted files cannot be opened.
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
            <Password
                label="Passphrase"
                value={passphrase}
                autoComplete="new-password"
                required
                description="At least 12 characters. A leaked vault file allows offline guessing."
                disabled={create.isPending}
                onChange={setPassphrase}
            />
            <Password
                label="Repeat passphrase"
                value={confirmation}
                autoComplete="new-password"
                required
                disabled={create.isPending}
                onChange={setConfirmation}
            />
            <KeepUnlockedOption
                checked={keep}
                disabled={create.isPending}
                onChange={setKeep}
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
                    disabled={create.isPending}
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

/** Unlocks with one prompt for every registered passkey of this hostname, or the passphrase. */
function UnlockVaultForm(props: {
    summary: VaultSummary;
    onCancel: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const [passphrase, setPassphrase] = React.useState("");
    const [keep, setKeep] = React.useState(false);

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
                keep,
            );
        } finally {
            wipe(opened.rawVaultKey);
        }

        void api.markVaultSlotUsed(opened.slot.id).catch(() => undefined);
    };

    const withPassphrase = useMutation({
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
        mutationFn: async () => {
            const material = materialQuery.data;

            if (material === undefined) {
                throw new Error("The vault is still loading");
            }

            const { slot, kek } = await derivePasskeyKek(material, passkeys);

            await finish(await openPasskeySlot(material, slot, kek));
        },
    });

    const isBusy = withPassphrase.isPending || withPasskey.isPending;
    const failure = withPassphrase.error ?? withPasskey.error;

    const otherHostPasskeys = props.summary.slots.filter(
        (slot) =>
            slot.type === "passkey" && slot.rp_id !== window.location.hostname,
    );

    return (
        <form
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                withPasskey.reset();
                withPassphrase.mutate();
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
                    onClick={() => {
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
                    , and you are on {window.location.hostname}. Use the
                    passphrase here.
                </p>
            ) : null}
            <Password
                label="Passphrase"
                value={passphrase}
                autoComplete="current-password"
                disabled={isBusy}
                onChange={setPassphrase}
            />
            <KeepUnlockedOption
                checked={keep}
                disabled={isBusy}
                onChange={setKeep}
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
                    disabled={isBusy}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    isLoading={withPassphrase.isPending}
                    disabled={isBusy || passphrase === ""}
                >
                    <LockKeyhole className="h-4 w-4" aria-hidden="true" />
                    {withPassphrase.isPending ? "Unlocking…" : "Unlock"}
                </Button>
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

    const statusQuery = useQuery({
        ...vaultStatusQueryOptions(api),
        enabled: isOpen,
    });

    if (!isOpen) {
        return null;
    }

    const summary = statusQuery.data?.vault;
    const cancel = () => session.cancelPending();

    return (
        <Dialog
            isOpen
            title={summary === null ? "Create vault" : "Unlock vault"}
            description={state.pendingReason}
            closeAriaLabel="Cancel"
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
                <CreateVaultForm onCancel={cancel} />
            ) : (
                <UnlockVaultForm summary={summary} onCancel={cancel} />
            )}
        </Dialog>
    );
}
