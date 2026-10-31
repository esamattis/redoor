/**
 * Parses a vault backup file. The file comes from the user's disk, so it is checked before
 * any field is used; the server validates the details again when it is restored.
 */
import { z } from "zod";
import type { VaultDocument } from "#bindings/VaultDocument";

const wrapSchema = z.object({
    alg: z.string(),
    iv: z.string(),
    ct: z.string(),
});

const slotBase = {
    id: z.string(),
    label: z.string(),
    wrap: wrapSchema,
    created_at: z.string(),
    last_used_at: z.string().nullable(),
};

const slotSchema = z.discriminatedUnion("type", [
    z.object({
        ...slotBase,
        type: z.literal("passphrase"),
        kdf: z.object({
            alg: z.string(),
            m_kib: z.number(),
            t: z.number(),
            p: z.number(),
            salt: z.string(),
        }),
    }),
    z.object({
        ...slotBase,
        type: z.literal("passkey"),
        credential_id: z.string(),
        rp_id: z.string(),
    }),
]);

export const vaultDocumentSchema = z.object({
    version: z.number(),
    vault_id: z.string(),
    label: z.string(),
    created_at: z.string(),
    auth_verifier: z.string(),
    keys: z.array(
        z.object({
            key_id: z.string(),
            created_at: z.string(),
            current: z.boolean(),
            wrapped_by: z.string().nullable(),
            wrap: wrapSchema.nullable(),
        }),
    ),
    retired_keys: z.array(
        z.object({
            key_id: z.string(),
            created_at: z.string(),
            destroyed_at: z.string(),
        }),
    ),
    slots: z.array(slotSchema),
}) satisfies z.ZodType<VaultDocument>;

/** Parses backup file text, or returns null when it is not a vault backup. */
export function parseVaultBackup(text: string): VaultDocument | null {
    try {
        const parsed = vaultDocumentSchema.safeParse(JSON.parse(text));

        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
