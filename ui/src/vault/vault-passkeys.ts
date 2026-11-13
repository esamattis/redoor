/**
 * WebAuthn passkeys as vault slots, through the PRF extension.
 *
 * Passkeys here only derive keys; they are not a login method, so the server verifies no
 * WebAuthn signatures and the challenge is random and unused. A successful AES-GCM unwrap of
 * the slot is the proof. The user handle is random and not tied to the login account.
 */
import type { VaultSlot } from "#bindings/VaultSlot";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import type { SlotKek } from "#ui/vault/vault-keys";
import {
    fromBase64Url,
    newSlotId,
    passkeyKek,
    prfSalt,
    randomBytes,
    toBase64Url,
} from "#ui/vault/vault-crypto";
import { modalDialogStack } from "#ui/components/dialog";
import {
    callerStack,
    nextPasskeyPromptId,
    vaultDebug,
    type VaultDebugValue,
} from "#ui/vault/vault-debug";

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

/**
 * Runs one browser passkey prompt with console logging of its start, end and failure. A
 * password manager sometimes shows a prompt twice, and the numbered lines with caller
 * stacks show whether redoor asked twice or the prompt repeated by itself.
 *
 * Dialog modality is suspended for the prompt, because password managers such as 1Password
 * inject their prompt into `<body>`, where a modal dialog would cover it and make it inert.
 */
async function loggedPrompt<T>(
    options: {
        kind: "get" | "create";
        details: Record<string, VaultDebugValue>;
        signal: AbortSignal | undefined;
    },
    prompt: () => Promise<T>,
): Promise<T> {
    const { kind, details, signal } = options;
    const id = nextPasskeyPromptId();
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    const onAbort = () =>
        vaultDebug(`passkey prompt #${id} (${kind}) abort requested`, {
            elapsedMs: elapsed(),
        });

    signal?.addEventListener("abort", onAbort, { once: true });

    vaultDebug(`passkey prompt #${id} (${kind}) start`, {
        ...details,
        rpId: currentRpId(),
        hasSignal: signal !== undefined,
        alreadyAborted: signal?.aborted ?? false,
        userActivation: navigator.userActivation?.isActive,
        stack: callerStack(),
    });

    const restoreModality = modalDialogStack.suspendModality();
    vaultDebug(`passkey prompt #${id} (${kind}) suspended dialog modality`);

    try {
        const result = await prompt();

        vaultDebug(`passkey prompt #${id} (${kind}) settled`, {
            elapsedMs: elapsed(),
            isCredential: result instanceof PublicKeyCredential,
            credentialId:
                result instanceof PublicKeyCredential
                    ? toBase64Url(result.rawId)
                    : null,
            authenticatorAttachment:
                result instanceof PublicKeyCredential
                    ? result.authenticatorAttachment
                    : null,
            prfEnabled:
                result instanceof PublicKeyCredential
                    ? result.getClientExtensionResults().prf?.enabled
                    : null,
            prfHasOutput:
                result instanceof PublicKeyCredential
                    ? prfOutput(result) !== null
                    : null,
        });

        return result;
    } catch (error) {
        vaultDebug(`passkey prompt #${id} (${kind}) failed`, {
            elapsedMs: elapsed(),
            aborted: signal?.aborted ?? false,
            // DOMException names tell a refused prompt from an aborted one.
            error: String(error),
        });

        throw error;
    } finally {
        signal?.removeEventListener("abort", onAbort);
        restoreModality();
        vaultDebug(`passkey prompt #${id} (${kind}) restored dialog modality`);
    }
}

/**
 * Requests an assertion from exactly the given credentials with a PRF evaluation. The signal
 * lets the user give up on a prompt that never settles, such as one a password manager
 * cannot show.
 */
async function assert(
    credentialIds: string[],
    salt: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
): Promise<PublicKeyCredential> {
    const credential = await loggedPrompt(
        { kind: "get", details: { credentialIds }, signal },
        () =>
            navigator.credentials.get({
                signal,
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
                                credentialIds.map((id) => [
                                    id,
                                    { first: salt },
                                ]),
                            ),
                        },
                    },
                },
            }),
    );

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
    signal?: AbortSignal;
}): Promise<{ credentialId: string; rpId: string; kek: CryptoKey }> {
    const salt = await prfSalt(options.vaultId);

    const created = await loggedPrompt(
        {
            kind: "create",
            details: { slotId: options.slotId },
            signal: options.signal,
        },
        () =>
            navigator.credentials.create({
                signal: options.signal,
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
            }),
    );

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
        // Logged because this second prompt is expected, not a duplicate.
        vaultDebug(
            "passkey created without PRF output, asking again with get",
            {
                credentialId,
            },
        );

        output = prfOutput(await assert([credentialId], salt, options.signal));
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
    signal?: AbortSignal,
): Promise<{ slot: VaultSlot; kek: CryptoKey }> {
    const ids = slots.flatMap((slot) =>
        slot.type === "passkey" ? [slot.credential_id] : [],
    );

    if (ids.length === 0) {
        throw new Error(
            `No passkey is registered for ${currentRpId()}; use the passphrase`,
        );
    }

    const credential = await assert(
        ids,
        await prfSalt(material.vault_id),
        signal,
    );

    const usedId = toBase64Url(credential.rawId);

    const slot = slots.find(
        (entry) => entry.type === "passkey" && entry.credential_id === usedId,
    );

    const output = prfOutput(credential);

    vaultDebug("passkey matched to slot", {
        usedId,
        slotId: slot?.id ?? null,
        hasPrfOutput: output !== null,
    });

    if (!slot) {
        throw new Error("The passkey used is not registered for this vault");
    }

    if (output === null) {
        throw new PasskeyPrfUnsupported();
    }

    return { slot, kek: await passkeyKek(toArrayBuffer(output), slot.id) };
}

/**
 * Registers a passkey for a new slot of the given vault, ready to wrap the vault key. The
 * slot id is chosen here because the passkey's KEK binds it.
 */
export async function newPasskeySlot(
    vaultId: string,
    label: string,
    signal?: AbortSignal,
): Promise<{ id: string; kek: SlotKek }> {
    const slotId = newSlotId();

    const registered = await registerPasskey({
        vaultId,
        slotId,
        label,
        signal,
    });

    return {
        id: slotId,
        kek: {
            type: "passkey",
            label,
            credentialId: registered.credentialId,
            rpId: registered.rpId,
            kek: registered.kek,
        },
    };
}
