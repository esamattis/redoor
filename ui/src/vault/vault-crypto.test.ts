import { describe, expect, test } from "vitest";

import {
    importVaultKey,
    newFileKey,
    randomBytes,
    toBase64Url,
    unwrapFileKey,
    unwrapForDevice,
    wrapFileKey,
    wrapForDevice,
} from "#ui/vault/vault-crypto";

const VAULT_ID = "vlt_0123456789abcdef0123456789abcdef";

const KEY_ID = "kid_0123456789abcdef0123456789abcdef";

describe("file key wraps", () => {
    test("bind the object kind, so a user file's key cannot open an SSH key", async () => {
        const vaultKey = await importVaultKey(randomBytes(32));
        const fileKey = newFileKey();

        const wrap = await wrapFileKey(vaultKey, fileKey, {
            vaultId: VAULT_ID,
            keyId: KEY_ID,
            kind: "file",
        });

        // The same kind opens the wrap and returns the same key.
        expect(
            await unwrapFileKey(vaultKey, wrap, {
                vaultId: VAULT_ID,
                keyId: KEY_ID,
                kind: "file",
            }),
        ).toEqual(fileKey);
        // A header that claims to be an SSH key cannot use a file's wrap, so a server or
        // device cannot relabel a file key as an SSH key's.
        await expect(
            unwrapFileKey(vaultKey, wrap, {
                vaultId: VAULT_ID,
                keyId: KEY_ID,
                kind: "ssh-key",
            }),
        ).rejects.toThrow();
    });
});

describe("device wraps", () => {
    test("bind the vault, generation and device entry", async () => {
        const secret = toBase64Url(randomBytes(32));
        const rawVaultKey = randomBytes(32);
        const context = { vaultId: VAULT_ID, keyId: KEY_ID, deviceId: "dev-a" };
        const wrap = await wrapForDevice(secret, rawVaultKey, context);

        // The same secret and context give back the raw key.
        expect(await unwrapForDevice(secret, wrap, context)).toEqual(
            rawVaultKey,
        );
        // A wrap copied onto another server entry does not open, so a secret handed out for
        // one entry cannot open another entry's key.
        await expect(
            unwrapForDevice(secret, wrap, { ...context, deviceId: "dev-b" }),
        ).rejects.toThrow();
        // Nor does it open as another generation.
        await expect(
            unwrapForDevice(secret, wrap, { ...context, keyId: "kid_other" }),
        ).rejects.toThrow();
        // Another secret, such as one created after the old entry expired, opens nothing.
        await expect(
            unwrapForDevice(toBase64Url(randomBytes(32)), wrap, context),
        ).rejects.toThrow();
    });
});
