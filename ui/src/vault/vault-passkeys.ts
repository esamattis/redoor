/**
 * WebAuthn passkeys as vault slots, through the PRF extension.
 *
 * Passkeys here only derive keys; they are not a login method, so the server verifies no
 * WebAuthn signatures and the challenge is random and unused. A successful AES-GCM unwrap of
 * the slot is the proof. The user handle is random and not tied to the login account.
 */
import type { VaultSlot } from "#bindings/VaultSlot";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import {
    fromBase64Url,
    passkeyKek,
    prfSalt,
    randomBytes,
    toBase64Url,
} from "#ui/vault/vault-crypto";

/** Thrown when an authenticator cannot derive keys (no PRF support). */
export class PasskeyPrfUnsupported extends Error {
    constructor() {
        super(
            "This passkey or browser does not support the PRF extension, which the vault needs to derive keys",
        );
        this.name = "PasskeyPrfUnsupported";
    }
}

/** Whether this browser offers WebAuthn at all. */
export function isPasskeySupported(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.PublicKeyCredential !== "undefined" &&
        window.isSecureContext
    );
}

/** The relying party id of this page: its hostname. */
export function currentRpId(): string {
    return window.location.hostname;
}

/** The PRF output of an assertion or creation, if the authenticator returned one. */
function prfOutput(credential: PublicKeyCredential): BufferSource | null {
    return credential.getClientExtensionResults().prf?.results?.first ?? null;
}

/** Copies any buffer source into a fresh `ArrayBuffer`. */
function toArrayBuffer(source: BufferSource): ArrayBuffer {
    const view =
        source instanceof ArrayBuffer
            ? new Uint8Array(source)
            : new Uint8Array(
                  source.buffer,
                  source.byteOffset,
                  source.byteLength,
              );

    return view.slice().buffer;
}

/** Requests an assertion from exactly the given credentials with a PRF evaluation. */
async function assert(
    credentialIds: string[],
    salt: Uint8Array<ArrayBuffer>,
): Promise<PublicKeyCredential> {
    const credential = await navigator.credentials.get({
        publicKey: {
            challenge: randomBytes(32),
            rpId: currentRpId(),
            userVerification: "required",
            allowCredentials: credentialIds.map((id) => ({
                type: "public-key",
                id: fromBase64Url(id),
            })),
            extensions: {
                prf: {
                    evalByCredential: Object.fromEntries(
                        credentialIds.map((id) => [id, { first: salt }]),
                    ),
                },
            },
        },
    });

    if (!(credential instanceof PublicKeyCredential)) {
        throw new Error("No passkey was used");
    }

    return credential;
}

/**
 * Registers a new passkey for a slot and derives its KEK. Some authenticators only return
 * PRF output on `get`, so a `get` follows the `create` when needed.
 */
export async function registerPasskey(options: {
    vaultId: string;
    slotId: string;
    label: string;
}): Promise<{ credentialId: string; rpId: string; kek: CryptoKey }> {
    const salt = await prfSalt(options.vaultId);

    const created = await navigator.credentials.create({
        publicKey: {
            challenge: randomBytes(32),
            rp: { name: "redoor vault", id: currentRpId() },
            user: {
                id: randomBytes(16),
                name: options.label,
                displayName: options.label,
            },
            pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: {
                userVerification: "required",
                residentKey: "preferred",
            },
            extensions: { prf: { eval: { first: salt } } },
        },
    });

    if (!(created instanceof PublicKeyCredential)) {
        throw new Error("No passkey was created");
    }

    const extension = created.getClientExtensionResults().prf;

    if (extension?.enabled !== true && extension?.results === undefined) {
        throw new PasskeyPrfUnsupported();
    }

    const credentialId = toBase64Url(created.rawId);
    let output = prfOutput(created);

    if (output === null) {
        output = prfOutput(await assert([credentialId], salt));
    }

    if (output === null) {
        throw new PasskeyPrfUnsupported();
    }

    return {
        credentialId,
        rpId: currentRpId(),
        kek: await passkeyKek(toArrayBuffer(output), options.slotId),
    };
}

/** Passkey slots registered for this page's hostname. */
export function usablePasskeySlots(
    material: Pick<VaultUnlockMaterialResponse, "slots">,
): VaultSlot[] {
    return material.slots.filter(
        (slot) => slot.type === "passkey" && slot.rp_id === currentRpId(),
    );
}

/**
 * Asks for one of the given passkey slots in a single prompt and returns the slot the user
 * picked with its KEK.
 */
export async function derivePasskeyKek(
    material: Pick<VaultUnlockMaterialResponse, "vault_id">,
    slots: VaultSlot[],
): Promise<{ slot: VaultSlot; kek: CryptoKey }> {
    const ids = slots.flatMap((slot) =>
        slot.type === "passkey" ? [slot.credential_id] : [],
    );

    if (ids.length === 0) {
        throw new Error(
            `No passkey is registered for ${currentRpId()}; use the passphrase`,
        );
    }

    const credential = await assert(ids, await prfSalt(material.vault_id));
    const usedId = toBase64Url(credential.rawId);

    const slot = slots.find(
        (entry) => entry.type === "passkey" && entry.credential_id === usedId,
    );

    const output = prfOutput(credential);

    if (!slot) {
        throw new Error("The passkey used is not registered for this vault");
    }

    if (output === null) {
        throw new PasskeyPrfUnsupported();
    }

    return { slot, kek: await passkeyKek(toArrayBuffer(output), slot.id) };
}
