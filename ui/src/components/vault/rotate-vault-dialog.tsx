import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Check, Fingerprint, RefreshCw } from "lucide-react";

import type { VaultSlot } from "#bindings/VaultSlot";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import type { ApiClient } from "#ui/api-client";
import type { VaultSession } from "#ui/vault/vault-session";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import {
    FreshUnlockFields,
    useFreshUnlock,
    useUnlockMaterial,
    type FreshUnlock,
} from "#ui/components/vault/fresh-unlock";
import {
    NewPassphraseFields,
    PasswordlessWarning,
    newPassphraseProblem,
} from "#ui/components/vault/new-passphrase-fields";
import { queryKeys } from "#ui/queries";
import { wipe } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    addSlotInput,
    buildRotation,
    newPassphraseKek,
    openFreshSlots,
    openGenerations,
    passphraseSlot,
    proofFromRaw,
    wipeOpened,
    type FreshUnlockInput,
    type OpenedSlot,
    type SlotToWrap,
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
 * The slots a rotation keeps when confirmed: every slot except the removed one and, when
 * the passphrase changes, the old passphrase, which a new slot replaces.
 */
function keepCandidates(
    material: Pick<VaultUnlockMaterialResponse, "slots">,
    removedId: string | null,
    replacesPassphrase: boolean,
): VaultSlot[] {
    const replaced = replacesPassphrase ? passphraseSlot(material)?.id : null;

    return material.slots.filter(
        (slot) => slot.id !== removedId && slot.id !== replaced,
    );
}

/**
 * The opened slots a rotation wraps the new key for. Only slots the user just opened are
 * kept, because wrapping needs each slot's own KEK.
 */
function keptSlots(
    candidates: VaultSlot[],
    opened: OpenedSlot[],
): SlotToWrap[] {
    const ids = new Set(candidates.map((slot) => slot.id));

    return opened.flatMap((entry) =>
        ids.has(entry.slot.id) ? [{ id: entry.slot.id, kek: entry.kek }] : [],
    );
}

/**
 * Applies a slot change without rotation: the slot change alone, with the proof from the
 * fresh unlock. A new passphrase slot wraps the same key and replaces the old one.
 */
async function applyWithoutRotation(options: {
    api: ApiClient;
    material: VaultUnlockMaterialResponse;
    rawVaultKey: Uint8Array<ArrayBuffer>;
    newPassphrase: SlotToWrap | null;
    removedId: string | null;
}): Promise<void> {
    const proof = await proofFromRaw(options.rawVaultKey);
    const previous = passphraseSlot(options.material);

    if (options.newPassphrase !== null) {
        await options.api.addVaultSlot({
            auth_proof: proof,
            slot: await addSlotInput({
                material: options.material,
                rawVaultKey: options.rawVaultKey,
                kek: options.newPassphrase.kek,
            }),
        });

        if (previous !== null) {
            await options.api.removeVaultSlot(previous.id, {
                auth_proof: proof,
            });
        }
    } else if (options.removedId !== null) {
        await options.api.removeVaultSlot(options.removedId, {
            auth_proof: proof,
        });
    }
}

/**
 * Applies the dialog's change: a rotation that keeps every slot opened by the fresh unlock
 * (plus a new passphrase), or, without rotation, the slot change alone. Returns whether the
 * key was rotated.
 */
async function applyVaultChange(options: {
    api: ApiClient;
    vault: VaultSession;
    unlock: FreshUnlockInput;
    newPassphrase: string | null;
    rotate: boolean;
    removedId: string | null;
}): Promise<boolean> {
    const material = await options.api.getVaultUnlockMaterial();
    const opened = await openFreshSlots(material, options.unlock);
    const rawPrevious = opened[0].rawVaultKey;

    try {
        const newPassphrase: SlotToWrap | null =
            options.newPassphrase === null
                ? null
                : {
                      id: null,
                      kek: await newPassphraseKek(options.newPassphrase),
                  };

        if (!options.rotate) {
            await applyWithoutRotation({
                api: options.api,
                material,
                rawVaultKey: rawPrevious,
                newPassphrase,
                removedId: options.removedId,
            });

            return false;
        }

        const slots = [
            ...keptSlots(
                keepCandidates(
                    material,
                    options.removedId,
                    newPassphrase !== null,
                ),
                opened,
            ),
            ...(newPassphrase === null ? [] : [newPassphrase]),
        ];

        if (slots.length === 0) {
            throw new Error(
                "Keep at least one unlock method: confirm a passkey or type the passphrase",
            );
        }

        const { request, rawNext } = await buildRotation({
            material,
            vault: await openGenerations(material, rawPrevious),
            rawPrevious,
            slots,
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
        wipeOpened(opened);
    }
}

/**
 * Whether a kept slot was confirmed: a passkey by its prompt, the passphrase by typing it.
 * Only the first passphrase slot can be opened, so any other one counts as unconfirmed.
 */
function isConfirmed(
    slot: VaultSlot,
    unlock: FreshUnlockInput,
    passphraseId: string | null,
): boolean {
    return slot.type === "passkey"
        ? unlock.passkeys.has(slot.id)
        : slot.id === passphraseId && unlock.passphrase !== "";
}

/**
 * What the form needs to know about a change before it runs: which slots would be removed
 * without consent, and whether the vault would end up without a passphrase.
 */
function planChange(options: {
    material: VaultUnlockMaterialResponse | undefined;
    intent: RotationIntent;
    unlock: FreshUnlock;
    isRotating: boolean;
}) {
    const material = options.material ?? { slots: [] };

    const removedId =
        options.intent.type === "remove-slot" ? options.intent.slot.id : null;

    const changesPassphrase = options.intent.type === "change-passphrase";
    const passphrase = passphraseSlot(material);
    const candidates = keepCandidates(material, removedId, changesPassphrase);

    const unconfirmed = options.isRotating
        ? candidates.filter(
              (slot) =>
                  !isConfirmed(
                      slot,
                      options.unlock.input,
                      passphrase?.id ?? null,
                  ),
          )
        : [];

    const removesPassphrase =
        passphrase !== null &&
        (passphrase.id === removedId ||
            unconfirmed.some((slot) => slot.id === passphrase.id));

    return {
        removedId,
        changesPassphrase,
        keptPasskeys: candidates.filter((slot) => slot.type === "passkey"),
        unconfirmed,
        keptCount:
            candidates.length -
            unconfirmed.length +
            (changesPassphrase ? 1 : 0),
        removesPassphrase,
        /** Typing the passphrase only helps if it is kept, or without a rotation. */
        showPassphrase:
            passphrase !== null &&
            !(options.isRotating && passphrase.id === removedId),
        remainingHosts: [
            ...new Set(
                candidates.flatMap((slot) =>
                    slot.type === "passkey" ? [slot.rp_id] : [],
                ),
            ),
        ],
    };
}

/**
 * Rotates the vault key, optionally removing a slot or changing the passphrase on the way.
 *
 * Wrapping the new key for a slot needs that slot's own key, and one unlock only yields the
 * key of the slot that was used. So the user confirms every kept passkey with its own prompt
 * and types the passphrase to keep it; any one of them is also the fresh unlock, so a vault
 * with a single passkey rotates with one prompt. A slot that is not confirmed is removed,
 * after a confirmation that names it. Removing a slot or changing the passphrase can skip
 * the rotation, which keeps old backups of `vault.json` usable with the removed slot or old
 * passphrase.
 */
export function RotateVaultDialog(props: {
    intent: RotationIntent;
    onClose: () => void;
    /** Called after a rotation, so the page can ask for a new backup. */
    onRotated: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const unlock = useFreshUnlock();
    const [newPassphrase, setNewPassphrase] = React.useState("");
    const [repeated, setRepeated] = React.useState("");
    const [rotate, setRotate] = React.useState(true);
    const [acceptRemoval, setAcceptRemoval] = React.useState(false);
    const [validation, setValidation] = React.useState<string | null>(null);
    const materialQuery = useUnlockMaterial();
    const canSkipRotation = props.intent.type !== "rotate";
    const isRotating = rotate || !canSkipRotation;

    const plan = planChange({
        material: materialQuery.data,
        intent: props.intent,
        unlock,
        isRotating,
    });

    const confirm = useMutation({
        mutationFn: async (slot: VaultSlot) => {
            const material = materialQuery.data;

            if (material === undefined) {
                throw new Error("The vault is still loading");
            }

            return derivePasskeyKek(material, [slot]);
        },
        onSuccess: ({ slot, kek }) => unlock.confirmPasskey(slot.id, kek),
    });

    const submit = useMutation({
        mutationFn: () =>
            applyVaultChange({
                api,
                vault,
                unlock: unlock.input,
                newPassphrase: plan.changesPassphrase ? newPassphrase : null,
                rotate: isRotating,
                removedId: plan.removedId,
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

        const passphraseIssue = plan.changesPassphrase
            ? newPassphraseProblem(newPassphrase, repeated)
            : null;

        const problem = !unlock.hasInput
            ? plan.showPassphrase
                ? "Confirm with a passkey or type the current passphrase"
                : "Confirm a passkey to keep"
            : passphraseIssue !== null
              ? passphraseIssue
              : isRotating && plan.keptCount === 0
                ? "Keep at least one unlock method"
                : plan.unconfirmed.length > 0 && !acceptRemoval
                  ? "Confirm every unlock method you keep, or accept removing the others"
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
                <RotationChoice
                    canSkip={canSkipRotation}
                    rotate={rotate}
                    disabled={isBusy}
                    subject={
                        plan.changesPassphrase
                            ? "old passphrase"
                            : "removed slot"
                    }
                    onChange={setRotate}
                />
                <FreshUnlockFields
                    unlock={unlock}
                    material={materialQuery.data}
                    disabled={isBusy}
                    showPasskeyButton={!isRotating}
                    showPassphrase={plan.showPassphrase}
                    passphraseLabel="Current passphrase"
                    passphraseDescription={
                        isRotating && !plan.changesPassphrase
                            ? "Keeps the passphrase. Without it, the passphrase is removed."
                            : undefined
                    }
                />
                {plan.changesPassphrase ? (
                    <NewPassphraseFields
                        label="New passphrase"
                        repeatLabel="Repeat new passphrase"
                        passphrase={newPassphrase}
                        repeated={repeated}
                        disabled={isBusy}
                        onChange={(next, again) => {
                            setNewPassphrase(next);
                            setRepeated(again);
                        }}
                    />
                ) : null}
                {isRotating && plan.keptPasskeys.length > 0 ? (
                    <PasskeyConfirmList
                        passkeys={plan.keptPasskeys}
                        confirmed={unlock.input.passkeys}
                        disabled={isBusy}
                        onConfirm={(slot) => confirm.mutate(slot)}
                    />
                ) : null}
                {plan.unconfirmed.length > 0 ? (
                    <Checkbox
                        role="checkbox"
                        checked={acceptRemoval}
                        disabled={isBusy}
                        onCheckedChange={setAcceptRemoval}
                        title={false}
                    >
                        Remove{" "}
                        {plan.unconfirmed.map((slot) => slot.label).join(", ")}{" "}
                        (they can be added again later)
                    </Checkbox>
                ) : null}
                {plan.removesPassphrase ? (
                    <PasswordlessWarning hosts={plan.remainingHosts} />
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
 * The "Rotate vault key" choice where rotation is optional, or the explanation of a manual
 * rotation where it is the point of the dialog.
 */
function RotationChoice(props: {
    canSkip: boolean;
    rotate: boolean;
    disabled: boolean;
    /** What an older backup still opens with when the rotation is skipped. */
    subject: string;
    onChange: (rotate: boolean) => void;
}) {
    if (!props.canSkip) {
        return (
            <p className="text-sm text-slate-400">
                New files use a new key; old files keep opening through the key
                chain. Rotate after losing a device that kept the vault
                unlocked, or if someone may have seen your passphrase.
            </p>
        );
    }

    return (
        <div>
            <Checkbox
                role="checkbox"
                checked={props.rotate}
                disabled={props.disabled}
                onCheckedChange={props.onChange}
                title={false}
            >
                Rotate vault key
            </Checkbox>
            <p className="mt-1 text-xs text-slate-500">
                Without a rotation, an older backup of the vault still opens
                with the {props.subject}.
            </p>
        </div>
    );
}

/** The kept passkeys, each confirmed with its own prompt. */
function PasskeyConfirmList(props: {
    passkeys: VaultSlot[];
    confirmed: ReadonlyMap<string, CryptoKey>;
    disabled: boolean;
    onConfirm: (slot: VaultSlot) => void;
}) {
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
