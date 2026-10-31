import { describe, expect, test } from "vitest";

import {
    importVaultKey,
    newFileKey,
    randomBytes,
    unwrapFileKey,
    wrapFileKey,
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
