/**
 * WebCrypto, HKDF, Argon2id and WebAuthn PRF helpers of the vault.
 *
 * The vault key (VK) only ever exists in the browser. It is kept as a non-extractable HKDF
 * `CryptoKey`, and every use goes through a subkey derived from it, so one key never serves
 * two algorithms:
 *
 * - file key wraps: AES-256-GCM under HKDF(VK, "redoor-vault v1 file-wrap"),
 * - chain wraps of older generations: AES-256-GCM under HKDF(VK, "redoor-vault v1 chain"),
 * - the proof of possession: HKDF(VK, "redoor-vault v1 auth"),
 * - the generation fingerprint: the first 16 bytes of HKDF(VK, "redoor-vault v1 key-id").
 *
 * Slots wrap the raw VK under a key-encryption key (KEK) from Argon2id (passphrase) or a
 * WebAuthn PRF output (passkey). Every wrap binds its context in the GCM associated data, so
 * a wrap moved to another vault, slot, generation or file fails to open.
 *
 * Header serialization and the file MAC live on the server only; this module never touches
 * file content. It runs in browsers and in Node (the integration tests).
 */
import { argon2id } from "hash-wasm";
import type { VaultKdfParams } from "#bindings/VaultKdfParams";
import type { VaultKeyWrap } from "#bindings/VaultKeyWrap";
import type { VaultObjectKind } from "#bindings/VaultObjectKind";

/** Argon2id defaults: 64 MiB and 3 passes still finish in a few seconds on phones. */
export const DEFAULT_KDF = { m_kib: 65536, t: 3, p: 1 } as const;

const encoder = new TextEncoder();

/** Encodes bytes as base64url without padding, the form every vault field uses. */
export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";

    for (const byte of view) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

/** Decodes base64url with or without padding. */
export function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

/** Fresh random bytes from the platform generator. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(length));
}

/** Lowercase hex, the form of vault, slot and key ids. */
function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

/** A random `vlt_` id. */
export function newVaultId(): string {
    return `vlt_${toHex(randomBytes(16))}`;
}

/** A random `slot_` id; the browser picks it because slot wraps bind it. */
export function newSlotId(): string {
    return `slot_${toHex(randomBytes(16))}`;
}

/** The short fingerprint the UI shows for a vault or key id. */
export function fingerprint(id: string): string {
    const hex = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;

    return hex.slice(0, 8);
}

/** Overwrites raw key bytes once they are no longer needed. */
export function wipe(bytes: Uint8Array): void {
    bytes.fill(0);
}

/**
 * Joins the parts of an associated-data string with NUL separators, so no two different
 * contexts can produce the same bytes.
 */
function associatedData(...parts: string[]): Uint8Array<ArrayBuffer> {
    return encoder.encode(parts.join("\0"));
}

/**
 * Imports raw vault key bytes as an HKDF key. Non-extractable by default: script can use it
 * while the page is open, but cannot read it out.
 */
export async function importVaultKey(
    raw: Uint8Array<ArrayBuffer>,
    extractable = false,
): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw, "HKDF", extractable, [
        "deriveKey",
        "deriveBits",
    ]);
}

/** HKDF-SHA256 output bits of a vault or PRF key. */
async function deriveBits(
    key: CryptoKey,
    info: string,
    length = 32,
): Promise<Uint8Array<ArrayBuffer>> {
    const bits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: encoder.encode(info),
        },
        key,
        length * 8,
    );

    return new Uint8Array(bits);
}

/** An AES-256-GCM subkey of the vault key. */
async function deriveAesKey(key: CryptoKey, info: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: encoder.encode(info),
        },
        key,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

/** The public fingerprint of a key generation: `kid_` and 16 bytes of HKDF output. */
export async function deriveKeyId(vaultKey: CryptoKey): Promise<string> {
    return `kid_${toHex(await deriveBits(vaultKey, "redoor-vault v1 key-id", 16))}`;
}

/**
 * The proof of possession every vault change sends. The server stores only its SHA-256,
 * so the proof reveals nothing about the vault key.
 */
export async function deriveAuthProof(vaultKey: CryptoKey): Promise<string> {
    return toBase64Url(await deriveBits(vaultKey, "redoor-vault v1 auth"));
}

/** The verifier `vault.json` stores for a proof. */
export async function authVerifier(proof: string): Promise<string> {
    return toBase64Url(
        await crypto.subtle.digest("SHA-256", fromBase64Url(proof)),
    );
}

/** AES-256-GCM encryption of a 32-byte key, as a vault wrap. */
async function wrapRaw(
    wrappingKey: CryptoKey,
    raw: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
): Promise<VaultKeyWrap> {
    const iv = randomBytes(12);

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData },
        wrappingKey,
        raw,
    );

    return { alg: "A256GCM", iv: toBase64Url(iv), ct: toBase64Url(ciphertext) };
}

/** Thrown when a wrap does not open: a wrong key, or wrap bytes or context changed. */
export class VaultUnwrapError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VaultUnwrapError";
    }
}

/** Opens an AES-256-GCM wrap into raw key bytes. */
async function unwrapRaw(
    wrappingKey: CryptoKey,
    wrap: VaultKeyWrap,
    binding: { additionalData: Uint8Array<ArrayBuffer>; failure: string },
): Promise<Uint8Array<ArrayBuffer>> {
    const { additionalData, failure } = binding;

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64Url(wrap.iv), additionalData },
            wrappingKey,
            fromBase64Url(wrap.ct),
        );

        return new Uint8Array(plaintext);
    } catch {
        throw new VaultUnwrapError(failure);
    }
}

/** Imports raw KEK bytes as an AES-GCM key. */
async function importKek(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
}

/** Argon2id parameters with a fresh salt. */
export function newKdfParams(): VaultKdfParams {
    return {
        alg: "argon2id",
        ...DEFAULT_KDF,
        salt: toBase64Url(randomBytes(16)),
    };
}

/** The passphrase slot's KEK. Runs Argon2id in WASM, which takes a moment on purpose. */
export async function passphraseKek(
    passphrase: string,
    kdf: VaultKdfParams,
): Promise<CryptoKey> {
    const output = await argon2id({
        password: passphrase.normalize("NFC"),
        salt: fromBase64Url(kdf.salt),
        parallelism: kdf.p,
        iterations: kdf.t,
        memorySize: kdf.m_kib,
        hashLength: 32,
        outputType: "binary",
    });

    const raw = new Uint8Array(output);

    try {
        return await importKek(raw);
    } finally {
        wipe(raw);
        wipe(output);
    }
}

/** The PRF input of every passkey of a vault: SHA-256("redoor-vault prf v1" ‖ vault_id). */
export async function prfSalt(
    vaultId: string,
): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(
        await crypto.subtle.digest(
            "SHA-256",
            encoder.encode(`redoor-vault prf v1${vaultId}`),
        ),
    );
}

/** A passkey slot's KEK: HKDF(PRF output, "redoor-vault v1 kek" ‖ slot id). */
export async function passkeyKek(
    prfOutput: ArrayBuffer | Uint8Array<ArrayBuffer>,
    slotId: string,
): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
        "raw",
        prfOutput,
        "HKDF",
        false,
        ["deriveBits"],
    );

    const raw = await deriveBits(base, `redoor-vault v1 kek${slotId}`);

    try {
        return await importKek(raw);
    } finally {
        wipe(raw);
    }
}

/** What a slot wrap is bound to. */
export type SlotContext = { vaultId: string; slotId: string; keyId: string };

/** Wraps raw vault key bytes for a slot. */
export async function wrapSlot(
    kek: CryptoKey,
    rawVaultKey: Uint8Array<ArrayBuffer>,
    context: SlotContext,
): Promise<VaultKeyWrap> {
    return wrapRaw(
        kek,
        rawVaultKey,
        associatedData(
            "redoor-vault v1 slot",
            context.vaultId,
            context.slotId,
            context.keyId,
        ),
    );
}

/** Opens a slot wrap into raw vault key bytes; the caller wipes them after importing. */
export async function unwrapSlot(
    kek: CryptoKey,
    wrap: VaultKeyWrap,
    context: SlotContext,
): Promise<Uint8Array<ArrayBuffer>> {
    return unwrapRaw(kek, wrap, {
        additionalData: associatedData(
            "redoor-vault v1 slot",
            context.vaultId,
            context.slotId,
            context.keyId,
        ),
        failure: "Wrong passphrase or passkey",
    });
}

/** What a chain wrap is bound to: the older generation and the newer one wrapping it. */
export type ChainContext = {
    vaultId: string;
    olderKeyId: string;
    newerKeyId: string;
};

/** Wraps an older generation's raw key under the next newer generation. */
export async function wrapChain(
    newerVaultKey: CryptoKey,
    rawOlderKey: Uint8Array<ArrayBuffer>,
    context: ChainContext,
): Promise<VaultKeyWrap> {
    return wrapRaw(
        await deriveAesKey(newerVaultKey, "redoor-vault v1 chain"),
        rawOlderKey,
        associatedData(
            "redoor-vault v1 chain",
            context.vaultId,
            context.olderKeyId,
            context.newerKeyId,
        ),
    );
}

/** Opens a chain wrap into the older generation's raw key bytes. */
export async function unwrapChain(
    newerVaultKey: CryptoKey,
    wrap: VaultKeyWrap,
    context: ChainContext,
): Promise<Uint8Array<ArrayBuffer>> {
    return unwrapRaw(
        await deriveAesKey(newerVaultKey, "redoor-vault v1 chain"),
        wrap,
        {
            additionalData: associatedData(
                "redoor-vault v1 chain",
                context.vaultId,
                context.olderKeyId,
                context.newerKeyId,
            ),
            failure: "The vault key chain is damaged",
        },
    );
}

/** What a file key wrap is bound to, matching the file header fields. */
export type FileContext = {
    vaultId: string;
    keyId: string;
    kind: VaultObjectKind;
};

/** The associated data of a file key wrap; changing these header fields breaks the wrap. */
function fileAssociatedData(context: FileContext): Uint8Array<ArrayBuffer> {
    return associatedData(
        "redoorvault v1 wrap",
        context.vaultId,
        context.keyId,
        context.kind,
    );
}

/** A fresh file key; every encryption gets a new one. */
export function newFileKey(): Uint8Array<ArrayBuffer> {
    return randomBytes(32);
}

/** Wraps a file key with a generation, for the file header. */
export async function wrapFileKey(
    vaultKey: CryptoKey,
    fileKey: Uint8Array<ArrayBuffer>,
    context: FileContext,
): Promise<VaultKeyWrap> {
    return wrapRaw(
        await deriveAesKey(vaultKey, "redoor-vault v1 file-wrap"),
        fileKey,
        fileAssociatedData(context),
    );
}

/** Opens a file header's key wrap. A failure means a tampered or corrupted header. */
export async function unwrapFileKey(
    vaultKey: CryptoKey,
    wrap: VaultKeyWrap,
    context: FileContext,
): Promise<Uint8Array<ArrayBuffer>> {
    return unwrapRaw(
        await deriveAesKey(vaultKey, "redoor-vault v1 file-wrap"),
        wrap,
        {
            additionalData: fileAssociatedData(context),
            failure: "The file header was tampered with or is corrupted",
        },
    );
}
