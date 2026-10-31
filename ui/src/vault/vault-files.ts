/**
 * Reading and writing `.redoorvault` files from the UI: path rules and the editor's content
 * query.
 *
 * Decrypted content is cached only while an editor shows it (`gcTime: 0`), and its query key
 * carries the unlocked generation, so locking or rotating drops it from the cache instead of
 * serving plaintext to a locked tab.
 */
import { queryOptions } from "@tanstack/react-query";
import type { Agent } from "#ui/api-client";
import type { VaultFileKeyStatus } from "#bindings/VaultFileKeyStatus";
import { queryKeys } from "#ui/queries";
import { fileKeyForHeader } from "#ui/vault/vault-keys";
import type { VaultSession } from "#ui/vault/vault-session";

/** Thrown by vault reads while the vault is locked. */
export class VaultLockedError extends Error {
    constructor() {
        super("The vault is locked");
        this.name = "VaultLockedError";
    }
}

/** What the editor needs from a vault file. */
export type VaultFileContent = {
    content: string;
    /** Sent back with a save, so it never overwrites a newer version. */
    revision: string;
    keyStatus: VaultFileKeyStatus;
};

/** The decrypted content of a vault file, while the vault is unlocked. */
export function vaultFileContentQueryOptions(options: {
    agent: Agent;
    path: string;
    vault: VaultSession;
    /** The unlocked generation, so a lock or rotation changes the key. */
    keyId: string | null;
}) {
    return queryOptions({
        queryKey: [
            ...queryKeys.all,
            "vault-file",
            options.agent.id,
            options.path,
            options.keyId,
        ] as const,
        queryFn: async (): Promise<VaultFileContent> => {
            const unlocked = options.vault.current();

            if (unlocked === null) {
                throw new VaultLockedError();
            }

            options.vault.touch();
            const header = await options.agent.vaultHeader(options.path);
            const fileKey = await fileKeyForHeader(unlocked, header.header);

            const { response, revision } = await options.agent.vaultRead(
                options.path,
                fileKey,
            );

            return {
                content: await response.text(),
                revision,
                keyStatus: header.key_status,
            };
        },
        enabled: options.keyId !== null,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        retry: false,
    });
}
