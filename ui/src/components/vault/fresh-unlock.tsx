import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Check, Fingerprint } from "lucide-react";

import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import { Button } from "#ui/components/button";
import { Password } from "#ui/components/password";
import { queryKeys } from "#ui/queries";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import { passphraseSlot, type FreshUnlockInput } from "#ui/vault/vault-keys";
import {
    currentRpId,
    derivePasskeyKek,
    isPasskeySupported,
    usablePasskeySlots,
} from "#ui/vault/vault-passkeys";

const rootRouteApi = getRouteApi("__root__");

/**
 * The vault's unlock material, loaded when a dialog opens. Passkey prompts start straight
 * from the click with it: some browsers require the user gesture that a fetch in between
 * would consume. Never cached, because wrapped keys change with every slot change.
 */
export function useUnlockMaterial() {
    const { api } = rootRouteApi.useRouteContext();

    return useQuery({
        queryKey: [...queryKeys.vault(), "unlock-material"],
        queryFn: () => api.getVaultUnlockMaterial(),
        staleTime: 0,
        gcTime: 0,
    });
}

/**
 * State of a fresh unlock: the typed passphrase and the passkeys confirmed by prompt. Only
 * the passkeys' non-extractable KEKs are kept; the raw vault key is unwrapped when the flow
 * runs and wiped right after, so it never sits in React state.
 */
export function useFreshUnlock() {
    const [passphrase, setPassphrase] = React.useState("");

    const [passkeys, setPasskeys] = React.useState<
        ReadonlyMap<string, CryptoKey>
    >(new Map());

    const input: FreshUnlockInput = { passphrase, passkeys };

    return {
        input,
        setPassphrase,
        /** Records a passkey the user just confirmed with a prompt. */
        confirmPasskey: (slotId: string, kek: CryptoKey) =>
            setPasskeys((current) => new Map(current).set(slotId, kek)),
        hasInput: passphrase !== "" || passkeys.size > 0,
    };
}

/** What `useFreshUnlock` returns, for components that render or read it. */
export type FreshUnlock = ReturnType<typeof useFreshUnlock>;

/** The unlock material a fresh unlock works on: the vault's or a backup's. */
type FreshUnlockMaterial = Pick<
    VaultUnlockMaterialResponse,
    "vault_id" | "slots"
>;

/**
 * Fields for a fresh unlock with any slot: one prompt for every passkey of this hostname,
 * or the passphrase. Flows that wrap the vault key again need it even while the vault is
 * unlocked, because the session only holds non-extractable keys.
 */
export function FreshUnlockFields(props: {
    unlock: FreshUnlock;
    material: FreshUnlockMaterial | undefined;
    disabled: boolean;
    /** Off where per-passkey confirmations already serve as the unlock (rotation). */
    showPasskeyButton: boolean;
    /** Off where the passphrase is being removed and cannot help. */
    showPassphrase: boolean;
    passphraseLabel: string;
    passphraseDescription?: string;
}) {
    const material = props.material;
    const passkeys = material === undefined ? [] : usablePasskeySlots(material);

    const prompt = useMutation({
        mutationFn: async () => {
            if (material === undefined) {
                throw new Error("The vault is still loading");
            }

            return derivePasskeyKek(material, passkeys);
        },
        onSuccess: ({ slot, kek }) => props.unlock.confirmPasskey(slot.id, kek),
    });

    if (material === undefined) {
        return <p className="text-sm text-slate-400">Loading vault…</p>;
    }

    const confirmed = passkeys.find((slot) =>
        props.unlock.input.passkeys.has(slot.id),
    );

    const offerPasskey =
        props.showPasskeyButton && passkeys.length > 0 && isPasskeySupported();

    const offerPassphrase =
        props.showPassphrase && passphraseSlot(material) !== null;

    const otherHosts = [
        ...new Set(
            material.slots.flatMap((slot) =>
                slot.type === "passkey" && slot.rp_id !== currentRpId()
                    ? [slot.rp_id]
                    : [],
            ),
        ),
    ];

    return (
        <div className="grid gap-4">
            {offerPasskey && confirmed !== undefined ? (
                <p className="inline-flex items-center gap-2 text-sm text-emerald-300">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Unlocked with {confirmed.label}
                </p>
            ) : null}
            {offerPasskey && confirmed === undefined ? (
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Confirm with any passkey registered for this hostname"
                    isLoading={prompt.isPending}
                    disabled={props.disabled}
                    onClick={() => prompt.mutate()}
                >
                    <Fingerprint className="h-4 w-4" aria-hidden="true" />
                    Unlock with passkey
                </Button>
            ) : null}
            {!offerPasskey && !offerPassphrase && props.showPasskeyButton ? (
                <p role="alert" className="text-sm text-amber-300">
                    {otherHosts.length > 0
                        ? `The passkeys belong to ${otherHosts.join(", ")}, and you are on ${currentRpId()}. Open redoor there to continue.`
                        : "No passkey or passphrase can unlock the vault in this browser."}
                </p>
            ) : null}
            {offerPassphrase ? (
                <Password
                    label={props.passphraseLabel}
                    value={props.unlock.input.passphrase}
                    autoComplete="current-password"
                    description={props.passphraseDescription}
                    disabled={props.disabled}
                    onChange={props.unlock.setPassphrase}
                />
            ) : null}
            {prompt.error ? (
                <p role="alert" className="text-sm text-red-300">
                    {vaultErrorMessage(prompt.error, "The passkey failed")}
                </p>
            ) : null}
        </div>
    );
}
