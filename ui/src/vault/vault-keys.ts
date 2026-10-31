/**
 * Vault operations built from the crypto primitives: creating a vault, unlocking a slot,
 * walking the generation chain, and building the requests for file writes, rotation and
 * destroying a generation.
 *
 * Nothing here holds state or touches React, so the UI and the integration tests share it.
 * Raw vault key bytes only appear where a flow needs to wrap the key again (creation, adding
 * a slot, rotation); callers wipe them as soon as the flow ends.
 */
import type { CreateVaultRequest } from "#bindings/CreateVaultRequest";
import type { VaultFileHeader } from "#bindings/VaultFileHeader";
import type { VaultKdfParams } from "#bindings/VaultKdfParams";
import type { VaultKeyEntry } from "#bindings/VaultKeyEntry";
import type { VaultSlot } from "#bindings/VaultSlot";
import type { VaultSlotInput } from "#bindings/VaultSlotInput";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import type { RotateVaultRequest } from "#bindings/RotateVaultRequest";
import type { DestroyVaultKeyRequest } from "#bindings/DestroyVaultKeyRequest";
import type { VaultWriteKeys } from "#ui/api-client";
import {
    authVerifier,
    deriveAuthProof,
    deriveKeyId,
    fromBase64Url,
    importVaultKey,
    newFileKey,
    newKdfParams,
    newSlotId,
    newVaultId,
    passphraseKek,
    randomBytes,
    toBase64Url,
    unwrapChain,
    unwrapFileKey,
    unwrapSlot,
    wipe,
    wrapChain,
    wrapFileKey,
    wrapSlot,
} from "#ui/vault/vault-crypto";

/** The minimum passphrase length; a leaked `vault.json` allows offline guessing. */
export const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Checks a new passphrase. Length matters most against offline guessing, so the rule is
 * simple: long enough, and not one repeated character.
 */
export function passphraseProblem(passphrase: string): string | null {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`;
    }

    if (new Set(passphrase).size < 4) {
        return "Use more different characters";
    }

    return null;
}

/** An unlocked vault: non-extractable keys of every reachable generation. */
export type UnlockedVault = {
    vaultId: string;
    currentKeyId: string;
    /** Every generation the chain reaches, keyed by key id. */
    keys: Map<string, CryptoKey>;
};

/** A slot's key-encryption key, with what the slot needs to be written again. */
export type SlotKek =
    | { type: "passphrase"; label: string; kdf: VaultKdfParams; kek: CryptoKey }
    | {
          type: "passkey";
          label: string;
          credentialId: string;
          rpId: string;
          kek: CryptoKey;
      };

/** Wraps raw vault key bytes for a slot and returns the slot as the server takes it. */
async function slotInput(
    slot: SlotKek,
    rawVaultKey: Uint8Array<ArrayBuffer>,
    context: { vaultId: string; slotId: string; keyId: string },
): Promise<VaultSlotInput> {
    const slotId = context.slotId;
    const wrap = await wrapSlot(slot.kek, rawVaultKey, context);

    if (slot.type === "passphrase") {
        return {
            id: slotId,
            label: slot.label,
            type: "passphrase",
            kdf: slot.kdf,
            wrap,
        };
    }

    return {
        id: slotId,
        label: slot.label,
        type: "passkey",
        credential_id: slot.credentialId,
        rp_id: slot.rpId,
        wrap,
    };
}

/** A new passphrase slot's KEK with fresh Argon2id parameters. */
export async function newPassphraseKek(
    passphrase: string,
    label = "Passphrase",
): Promise<SlotKek> {
    const kdf = newKdfParams();

    return {
        type: "passphrase",
        label,
        kdf,
        kek: await passphraseKek(passphrase, kdf),
    };
}

/**
 * Builds a new vault: a random vault id and vault key, every slot wrapping it, and the
 * proof verifier. The passkey KEKs need the vault id for their PRF salt, so the caller
 * derives them through `prepare`.
 */
export async function buildNewVault(options: {
    label: string;
    passphrase: SlotKek;
    passkeys?: (vaultId: string) => Promise<SlotKek[]>;
}): Promise<{ request: CreateVaultRequest; vault: UnlockedVault }> {
    const vaultId = newVaultId();
    const raw = randomBytes(32);

    try {
        const vaultKey = await importVaultKey(raw);
        const keyId = await deriveKeyId(vaultKey);
        const passkeys = (await options.passkeys?.(vaultId)) ?? [];
        const slots: VaultSlotInput[] = [];

        for (const slot of [options.passphrase, ...passkeys]) {
            slots.push(
                await slotInput(slot, raw, {
                    vaultId,
                    slotId: newSlotId(),
                    keyId,
                }),
            );
        }

        return {
            request: {
                vault_id: vaultId,
                label: options.label,
                key_id: keyId,
                auth_verifier: await authVerifier(
                    await deriveAuthProof(vaultKey),
                ),
                slots,
            },
            vault: {
                vaultId,
                currentKeyId: keyId,
                keys: new Map([[keyId, vaultKey]]),
            },
        };
    } finally {
        wipe(raw);
    }
}

/** The passphrase slot of a vault; every vault has one. */
export function passphraseSlot(
    material: VaultUnlockMaterialResponse,
): VaultSlot {
    const slot = material.slots.find((entry) => entry.type === "passphrase");

    if (!slot) {
        throw new Error("The vault has no passphrase slot");
    }

    return slot;
}

/** The result of opening one slot. The raw key is for flows that wrap it again. */
export type OpenedSlot = {
    slot: VaultSlot;
    kek: SlotKek;
    rawVaultKey: Uint8Array<ArrayBuffer>;
};

/** Opens the passphrase slot. Throws `VaultUnwrapError` for a wrong passphrase. */
export async function openPassphraseSlot(
    material: VaultUnlockMaterialResponse,
    passphrase: string,
): Promise<OpenedSlot> {
    const slot = passphraseSlot(material);

    if (slot.type !== "passphrase") {
        throw new Error("Unexpected slot type");
    }

    const kek = await passphraseKek(passphrase, slot.kdf);

    const rawVaultKey = await unwrapSlot(kek, slot.wrap, {
        vaultId: material.vault_id,
        slotId: slot.id,
        keyId: material.current_key_id,
    });

    return {
        slot,
        kek: { type: "passphrase", label: slot.label, kdf: slot.kdf, kek },
        rawVaultKey,
    };
}

/** Opens a passkey slot with the KEK its PRF output derived. */
export async function openPasskeySlot(
    material: VaultUnlockMaterialResponse,
    slot: VaultSlot,
    kek: CryptoKey,
): Promise<OpenedSlot> {
    if (slot.type !== "passkey") {
        throw new Error("Not a passkey slot");
    }

    const rawVaultKey = await unwrapSlot(kek, slot.wrap, {
        vaultId: material.vault_id,
        slotId: slot.id,
        keyId: material.current_key_id,
    });

    return {
        slot,
        kek: {
            type: "passkey",
            label: slot.label,
            credentialId: slot.credential_id,
            rpId: slot.rp_id,
            kek,
        },
        rawVaultKey,
    };
}

/**
 * Imports the current key without extraction and unwraps every older generation through
 * the chain, so files on any reachable generation open.
 */
export async function openGenerations(
    material: VaultUnlockMaterialResponse,
    rawCurrent: Uint8Array<ArrayBuffer>,
): Promise<UnlockedVault> {
    const keys = new Map<string, CryptoKey>();
    const [current, ...older] = material.keys;

    if (!current) {
        throw new Error("The vault has no key generation");
    }

    let newer = await importVaultKey(rawCurrent);
    keys.set(current.key_id, newer);

    let newerId = current.key_id;

    for (const entry of older) {
        if (!entry.wrap) {
            break;
        }

        const raw = await unwrapChain(newer, entry.wrap, {
            vaultId: material.vault_id,
            olderKeyId: entry.key_id,
            newerKeyId: newerId,
        });

        try {
            newer = await importVaultKey(raw);
        } finally {
            wipe(raw);
        }

        keys.set(entry.key_id, newer);
        newerId = entry.key_id;
    }

    return { vaultId: material.vault_id, currentKeyId: current.key_id, keys };
}

/** The proof of possession of the current generation. */
export async function currentProof(vault: UnlockedVault): Promise<string> {
    const key = vault.keys.get(vault.currentKeyId);

    if (!key) {
        throw new Error("The current vault key is not unlocked");
    }

    return deriveAuthProof(key);
}

/** Unwraps a file's key from its header. Throws `VaultUnwrapError` if it was tampered with. */
export async function fileKeyForHeader(
    vault: UnlockedVault,
    header: VaultFileHeader,
): Promise<string> {
    const key = vault.keys.get(header.key_id);

    if (!key || header.vault_id !== vault.vaultId) {
        throw new Error(
            "This file is not encrypted with an unlocked vault key",
        );
    }

    const fileKey = await unwrapFileKey(key, header.wrap, {
        vaultId: header.vault_id,
        keyId: header.key_id,
        kind: header.kind,
    });

    try {
        return toBase64Url(fileKey);
    } finally {
        wipe(fileKey);
    }
}

/** A new file key wrapped with the current generation, for one write. */
export async function newWriteKeys(
    vault: UnlockedVault,
): Promise<VaultWriteKeys> {
    const key = vault.keys.get(vault.currentKeyId);

    if (!key) {
        throw new Error("The current vault key is not unlocked");
    }

    const fileKey = newFileKey();

    try {
        return {
            fileKey: toBase64Url(fileKey),
            keyId: vault.currentKeyId,
            wrap: await wrapFileKey(key, fileKey, {
                vaultId: vault.vaultId,
                keyId: vault.currentKeyId,
                kind: "file",
            }),
        };
    } finally {
        wipe(fileKey);
    }
}

/** The same file key wrapped with the current generation, for a header-only rewrap. */
export async function rewrapKeys(
    vault: UnlockedVault,
    header: VaultFileHeader,
): Promise<VaultWriteKeys> {
    const key = vault.keys.get(vault.currentKeyId);

    if (!key) {
        throw new Error("The current vault key is not unlocked");
    }

    const fileKey = await fileKeyForHeader(vault, header);

    return {
        fileKey,
        keyId: vault.currentKeyId,
        wrap: await wrapFileKey(key, fromBase64Url(fileKey), {
            vaultId: vault.vaultId,
            keyId: vault.currentKeyId,
            kind: header.kind,
        }),
    };
}

/**
 * Builds a rotation: a new vault key, the previous one chained under it, and every kept
 * slot wrapping the new key. `rawPrevious` is the current key from a fresh unlock.
 */
export async function buildRotation(options: {
    material: VaultUnlockMaterialResponse;
    vault: UnlockedVault;
    rawPrevious: Uint8Array<ArrayBuffer>;
    /** The kept slots by id; a new passphrase gets a new id. */
    slots: { id: string | null; kek: SlotKek }[];
}): Promise<{ request: RotateVaultRequest; rawNext: Uint8Array<ArrayBuffer> }> {
    const rawNext = randomBytes(32);
    const next = await importVaultKey(rawNext);
    const keyId = await deriveKeyId(next);
    const vaultId = options.material.vault_id;
    const slots: VaultSlotInput[] = [];

    for (const slot of options.slots) {
        slots.push(
            await slotInput(slot.kek, rawNext, {
                vaultId,
                slotId: slot.id ?? newSlotId(),
                keyId,
            }),
        );
    }

    return {
        request: {
            auth_proof: await currentProof(options.vault),
            new_key_id: keyId,
            new_auth_verifier: await authVerifier(await deriveAuthProof(next)),
            previous_key_wrap: await wrapChain(next, options.rawPrevious, {
                vaultId,
                olderKeyId: options.material.current_key_id,
                newerKeyId: keyId,
            }),
            slots,
        },
        rawNext,
    };
}

/**
 * Builds the request that destroys `keyId`: the next older generation, reachable only
 * through it, is wrapped again under the next newer one.
 */
export async function buildDestroy(options: {
    material: VaultUnlockMaterialResponse;
    vault: UnlockedVault;
    keyId: string;
}): Promise<DestroyVaultKeyRequest> {
    const keys: VaultKeyEntry[] = options.material.keys;
    const index = keys.findIndex((entry) => entry.key_id === options.keyId);
    const newer = keys[index - 1];
    const older = keys[index + 1];
    const proof = await currentProof(options.vault);

    if (index <= 0 || !newer) {
        throw new Error("Only older key generations can be destroyed");
    }

    if (!older?.wrap) {
        return { auth_proof: proof, relink: null };
    }

    const destroyedKey = options.vault.keys.get(options.keyId);
    const newerKey = options.vault.keys.get(newer.key_id);

    if (!destroyedKey || !newerKey) {
        throw new Error("The key chain is not unlocked");
    }

    const rawOlder = await unwrapChain(destroyedKey, older.wrap, {
        vaultId: options.material.vault_id,
        olderKeyId: older.key_id,
        newerKeyId: options.keyId,
    });

    try {
        return {
            auth_proof: proof,
            relink: await wrapChain(newerKey, rawOlder, {
                vaultId: options.material.vault_id,
                olderKeyId: older.key_id,
                newerKeyId: newer.key_id,
            }),
        };
    } finally {
        wipe(rawOlder);
    }
}

/** The slot input of an existing slot with a new wrap of the current key. */
export async function addSlotInput(options: {
    material: VaultUnlockMaterialResponse;
    rawVaultKey: Uint8Array<ArrayBuffer>;
    kek: SlotKek;
}): Promise<VaultSlotInput> {
    return slotInput(options.kek, options.rawVaultKey, {
        vaultId: options.material.vault_id,
        slotId: newSlotId(),
        keyId: options.material.current_key_id,
    });
}
