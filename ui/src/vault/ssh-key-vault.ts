/**
 * The browser's part of managed SSH keys encrypted with the vault.
 *
 * The server generates every key and never sends it to the browser. The browser only picks
 * the file key of a new key and wraps it for the `ssh-key` kind, and unwraps an existing
 * key's file key from its header when the server needs the key: to start the device (the
 * server then holds the key until the device stops) and for rotation, removal and device
 * deletion (used for that request only).
 */
import type { SshKeyVaultSeal } from "#bindings/SshKeyVaultSeal";
import type { VaultSshKey } from "#bindings/VaultSshKey";
import type { StartAgentResponse } from "#bindings/StartAgentResponse";
import type { Agent, ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    fileKeyForHeader,
    newSshKeySeal,
    rewrapKeys,
    type UnlockedVault,
} from "#ui/vault/vault-keys";
import type { VaultSession } from "#ui/vault/vault-session";

/**
 * The file key of the device's current SSH key when it is encrypted, unlocking the vault
 * first; `null` for a plaintext key, a device without a managed key, or a key this vault
 * cannot open (for example after restoring another vault's backup), so a removal still
 * deletes it locally and the key can be set up again.
 */
export async function currentSshKeyFileKey(options: {
    api: ApiClient;
    vault: VaultSession;
    agentId: string;
    reason: string;
}): Promise<string | null> {
    const status = await options.api.getSshKeyStatus(options.agentId);

    const keyStatus = status.key_status?.status;

    if (
        !status.encrypted ||
        status.vault_header === null ||
        (keyStatus !== "current" && keyStatus !== "older")
    ) {
        return null;
    }

    const unlocked = await options.vault.requestUnlock(options.reason);

    return fileKeyForHeader(unlocked, status.vault_header);
}

/**
 * Starts a device. When its SSH key is encrypted and the server does not hold it, the
 * server refuses with `ssh_key_locked`; the vault is then unlocked and the start repeated
 * with the key's file key. Trying first keeps an ordinary start at one request and works
 * while the server still holds the key from an earlier start.
 */
export async function startAgent(options: {
    agent: Agent;
    api: ApiClient;
    vault: VaultSession;
}): Promise<StartAgentResponse> {
    try {
        return await options.agent.start();
    } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "ssh_key_locked") {
            throw error;
        }
    }

    const fileKey = await currentSshKeyFileKey({
        api: options.api,
        vault: options.vault,
        agentId: options.agent.id,
        reason: `Start ${options.agent.name}`,
    });

    return options.agent.start(
        fileKey === null ? undefined : { ssh_key_file_key: fileKey },
    );
}

/**
 * What a new SSH key is encrypted with: the vault's seal when the account has a vault
 * (unlocking it first), or `null` for a plaintext key when it has none.
 */
export async function newSshKeySealIfVault(options: {
    api: ApiClient;
    vault: VaultSession;
    reason: string;
}): Promise<SshKeyVaultSeal | null> {
    const status = await options.api.getVault();

    if (status.vault === null) {
        return null;
    }

    return newSshKeySeal(await options.vault.requestUnlock(options.reason));
}

/** Moves one encrypted SSH key to the current vault generation; only its header changes. */
export async function rewrapSshKey(options: {
    api: ApiClient;
    vault: UnlockedVault;
    key: VaultSshKey;
}): Promise<void> {
    const keys = await rewrapKeys(options.vault, options.key.header);

    await options.api.rewrapSshKey(options.key.device_id, {
        file_key: keys.fileKey,
        key_id: keys.keyId,
        wrap: keys.wrap,
    });
}

/**
 * Moves every SSH key on an older generation to the current one, one after another, so an
 * old generation can be destroyed afterwards. Returns how many failed; the rest are done.
 */
export async function rewrapOlderSshKeys(options: {
    api: ApiClient;
    vault: VaultSession;
}): Promise<number> {
    const listed = await options.api.listVaultSshKeys();

    const older = listed.keys.filter(
        (key) => key.key_status.status === "older",
    );

    if (older.length === 0) {
        return 0;
    }

    const unlocked = await options.vault.requestUnlock(
        "Rewrapping SSH keys needs the vault key",
    );

    let failed = 0;

    for (const key of older) {
        await rewrapSshKey({ api: options.api, vault: unlocked, key }).catch(
            () => {
                failed += 1;
            },
        );
    }

    return failed;
}
