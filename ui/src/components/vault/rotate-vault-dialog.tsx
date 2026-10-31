import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Check, Fingerprint, RefreshCw } from "lucide-react";

import type { VaultSlot } from "#bindings/VaultSlot";
import type { ApiClient } from "#ui/api-client";
import type { VaultSession } from "#ui/vault/vault-session";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import { queryKeys } from "#ui/queries";
import { wipe } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    addSlotInput,
    buildRotation,
    newPassphraseKek,
    openGenerations,
    openPassphraseSlot,
    passphraseProblem,
    proofFromRaw,
    type SlotKek,
} from "#ui/vault/vault-keys";
import { derivePasskeyKek, currentRpId } from "#ui/vault/vault-passkeys";

const rootRouteApi = getRouteApi("__root__");

/** What the dialog changes besides the key. */
export type RotationIntent =
    | { type: "rotate" }
    | { type: "remove-slot"; slot: { id: string; label: string } }
    | { type: "change-passphrase" };

/** The title of each intent. */
function title(intent: RotationIntent): string {
    switch (intent.type) {
        case "rotate":
            return "Rotate vault key";
        case "remove-slot":
            return `Remove ${intent.slot.label}`;
        case "change-passphrase":
            return "Change passphrase";
    }
}

/**
 * Applies the dialog's change: a rotation that keeps the passphrase (or a new one) and every
 * confirmed passkey, or, without rotation, the slot change alone. Returns whether the key
 * was rotated.
 */
async function applyVaultChange(options: {
    api: ApiClient;
    vault: VaultSession;
    passphrase: string;
    newPassphrase: string | null;
    rotate: boolean;
    removedId: string | null;
    keptPasskeys: VaultSlot[];
    confirmed: Map<string, CryptoKey>;
}): Promise<boolean> {
    const material = await options.api.getVaultUnlockMaterial();

    const opened = await openPassphraseSlot(material, options.passphrase);

    try {
        const nextPassphrase =
            options.newPassphrase !== null
                ? await newPassphraseKek(options.newPassphrase)
                : null;

        if (!options.rotate) {
            const proof = await proofFromRaw(opened.rawVaultKey);

            if (nextPassphrase !== null) {
                // Without rotation the new passphrase slot wraps the same key and
                // replaces the old slot.
                await options.api.addVaultSlot({
                    auth_proof: proof,
                    slot: await addSlotInput({
                        material,
                        rawVaultKey: opened.rawVaultKey,
                        kek: nextPassphrase,
                    }),
                });
                await options.api.removeVaultSlot(opened.slot.id, {
                    auth_proof: proof,
                });
            } else if (options.removedId !== null) {
                await options.api.removeVaultSlot(options.removedId, {
                    auth_proof: proof,
                });
            }

            return false;
        }

        const current = await openGenerations(material, opened.rawVaultKey);

        const passphraseSlot: { id: string | null; kek: SlotKek } =
            nextPassphrase === null
                ? { id: opened.slot.id, kek: opened.kek }
                : { id: null, kek: nextPassphrase };

        const passkeySlots = options.keptPasskeys.flatMap((slot) => {
            const kek = options.confirmed.get(slot.id);

            return slot.type === "passkey" && kek !== undefined
                ? [
                      {
                          id: slot.id,
                          kek: {
                              type: "passkey" as const,
                              label: slot.label,
                              credentialId: slot.credential_id,
                              rpId: slot.rp_id,
                              kek,
                          },
                      },
                  ]
                : [];
        });

        const { request, rawNext } = await buildRotation({
            material,
            vault: current,
            rawPrevious: opened.rawVaultKey,
            slots: [passphraseSlot, ...passkeySlots],
        });

        try {
            await options.api.rotateVault(request);

            const next = await options.api.getVaultUnlockMaterial();
            await options.vault.rotated(await openGenerations(next, rawNext));
        } finally {
            wipe(rawNext);
        }

        return true;
    } finally {
        wipe(opened.rawVaultKey);
    }
}

/**
 * Rotates the vault key, optionally removing a slot or changing the passphrase on the way.
 *
 * Wrapping the new key for a slot needs that slot's own key, and one unlock only yields the
 * key of the slot that was used. So the user types the passphrase and confirms every kept
 * passkey one by one; a passkey that is not confirmed is removed, after a confirmation that
 * names it. Removing a slot or changing the passphrase can skip the rotation, which keeps
 * old backups of `vault.json` usable with the removed slot or old passphrase.
 */
export function RotateVaultDialog(props: {
    intent: RotationIntent;
    onClose: () => void;
    /** Called after a rotation, so the page can ask for a new backup. */
    onRotated: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const [passphrase, setPassphrase] = React.useState("");
    const [newPassphrase, setNewPassphrase] = React.useState("");
    const [repeated, setRepeated] = React.useState("");
    const [rotate, setRotate] = React.useState(true);

    const [confirmed, setConfirmed] = React.useState(
        new Map<string, CryptoKey>(),
    );

    const [acceptRemoval, setAcceptRemoval] = React.useState(false);
    const [validation, setValidation] = React.useState<string | null>(null);

    const materialQuery = useQuery({
        queryKey: [...queryKeys.vault(), "unlock-material"],
        queryFn: () => api.getVaultUnlockMaterial(),
        staleTime: 0,
        gcTime: 0,
    });

    const removedId =
        props.intent.type === "remove-slot" ? props.intent.slot.id : null;

    const keptPasskeys = (materialQuery.data?.slots ?? []).filter(
        (slot) => slot.type === "passkey" && slot.id !== removedId,
    );

    const unconfirmed = keptPasskeys.filter((slot) => !confirmed.has(slot.id));
    const canSkipRotation = props.intent.type !== "rotate";
    const isRotating = rotate || !canSkipRotation;
    const changesPassphrase = props.intent.type === "change-passphrase";

    const confirm = useMutation({
        mutationFn: async (slot: VaultSlot) => {
            const material = materialQuery.data;

            if (material === undefined) {
                throw new Error("The vault is still loading");
            }

            const { kek } = await derivePasskeyKek(material, [slot]);

            return { slot, kek };
        },
        onSuccess: ({ slot, kek }) =>
            setConfirmed((current) => new Map(current).set(slot.id, kek)),
    });

    const submit = useMutation({
        mutationFn: () =>
            applyVaultChange({
                api,
                vault,
                passphrase,
                newPassphrase: changesPassphrase ? newPassphrase : null,
                rotate: isRotating,
                removedId,
                keptPasskeys,
                confirmed,
            }),
        onSuccess: async (rotated) => {
            await queryClient.invalidateQueries({
                queryKey: queryKeys.vault(),
            });

            if (rotated) {
                props.onRotated();
            }

            props.onClose();
        },
    });

    /** Checks the inputs before the slow key derivations start. */
    const start = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const problem =
            passphrase === ""
                ? "Type the current passphrase"
                : changesPassphrase
                  ? (passphraseProblem(newPassphrase) ??
                    (newPassphrase === repeated
                        ? null
                        : "The new passphrases differ"))
                  : isRotating && unconfirmed.length > 0 && !acceptRemoval
                    ? "Confirm every passkey you keep, or accept removing the others"
                    : null;

        setValidation(problem);

        if (problem === null) {
            submit.mutate();
        }
    };

    const isBusy = submit.isPending || confirm.isPending;
    const failure = submit.error ?? confirm.error;

    const error =
        validation ??
        (failure ? vaultErrorMessage(failure, "The change failed") : null);

    return (
        <Dialog
            isOpen
            title={title(props.intent)}
            closeAriaLabel="Cancel"
            isBusy={submit.isPending}
            onClose={props.onClose}
        >
            <form noValidate onSubmit={start} className="mt-4 grid gap-4">
                {canSkipRotation ? (
                    <div>
                        <Checkbox
                            role="checkbox"
                            checked={rotate}
                            disabled={isBusy}
                            onCheckedChange={setRotate}
                            title={false}
                        >
                            Rotate vault key
                        </Checkbox>
                        <p className="mt-1 text-xs text-slate-500">
                            Without a rotation, an older backup of the vault
                            still opens with the{" "}
                            {changesPassphrase
                                ? "old passphrase"
                                : "removed slot"}
                            .
                        </p>
                    </div>
                ) : (
                    <p className="text-sm text-slate-400">
                        New files use a new key; old files keep opening through
                        the key chain. Rotate after losing a device that kept
                        the vault unlocked, or if someone may have seen your
                        passphrase.
                    </p>
                )}
                <Password
                    label="Current passphrase"
                    value={passphrase}
                    autoComplete="current-password"
                    disabled={isBusy}
                    onChange={setPassphrase}
                />
                {changesPassphrase ? (
                    <>
                        <Password
                            label="New passphrase"
                            value={newPassphrase}
                            autoComplete="new-password"
                            description="At least 12 characters"
                            disabled={isBusy}
                            onChange={setNewPassphrase}
                        />
                        <Password
                            label="Repeat new passphrase"
                            value={repeated}
                            autoComplete="new-password"
                            disabled={isBusy}
                            onChange={setRepeated}
                        />
                    </>
                ) : null}
                {isRotating && keptPasskeys.length > 0 ? (
                    <PasskeyConfirmList
                        passkeys={keptPasskeys}
                        confirmed={confirmed}
                        acceptRemoval={acceptRemoval}
                        disabled={isBusy}
                        onConfirm={(slot) => confirm.mutate(slot)}
                        onAcceptRemovalChange={setAcceptRemoval}
                    />
                ) : null}
                {error === null ? null : (
                    <p role="alert" className="text-sm text-red-300">
                        {error}
                    </p>
                )}
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={isBusy}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={submit.isPending}>
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        {isRotating ? "Rotate" : "Apply"}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/**
 * The kept passkeys, each confirmed with its own prompt, and the consent to remove the ones
 * that were not.
 */
function PasskeyConfirmList(props: {
    passkeys: VaultSlot[];
    confirmed: Map<string, CryptoKey>;
    acceptRemoval: boolean;
    disabled: boolean;
    onConfirm: (slot: VaultSlot) => void;
    onAcceptRemovalChange: (accept: boolean) => void;
}) {
    const unconfirmed = props.passkeys.filter(
        (slot) => !props.confirmed.has(slot.id),
    );

    return (
        <div className="grid gap-2">
            <p className="text-sm font-medium text-slate-300">
                Confirm the passkeys to keep
            </p>
            {props.passkeys.map((slot) => (
                <PasskeyConfirmRow
                    key={slot.id}
                    slot={slot}
                    isConfirmed={props.confirmed.has(slot.id)}
                    disabled={props.disabled}
                    onConfirm={() => props.onConfirm(slot)}
                />
            ))}
            {unconfirmed.length > 0 ? (
                <Checkbox
                    role="checkbox"
                    checked={props.acceptRemoval}
                    disabled={props.disabled}
                    onCheckedChange={props.onAcceptRemovalChange}
                    title={false}
                >
                    Remove {unconfirmed.map((slot) => slot.label).join(", ")}{" "}
                    (they can be added again later)
                </Checkbox>
            ) : null}
        </div>
    );
}

/** One kept passkey with its confirmation button. */
function PasskeyConfirmRow(props: {
    slot: VaultSlot;
    isConfirmed: boolean;
    disabled: boolean;
    onConfirm: () => void;
}) {
    const otherHost =
        props.slot.type === "passkey" && props.slot.rp_id !== currentRpId()
            ? props.slot.rp_id
            : null;

    return (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-700 px-3 py-2">
            <span className="text-sm text-slate-200">
                {props.slot.label}
                {otherHost === null ? null : (
                    <span className="block text-xs text-slate-500">
                        Registered for {otherHost}; it cannot be confirmed here
                    </span>
                )}
            </span>
            {props.isConfirmed ? (
                <span className="inline-flex items-center gap-1 text-sm text-emerald-300">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Confirmed
                </span>
            ) : (
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip={`Use ${props.slot.label} to keep it`}
                    disabled={props.disabled || otherHost !== null}
                    onClick={props.onConfirm}
                >
                    <Fingerprint className="h-4 w-4" aria-hidden="true" />
                    Confirm
                </Button>
            )}
        </div>
    );
}
