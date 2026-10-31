/**
 * User-facing wording of vault failures. The server sends a code for each one, so the UI
 * chooses its own message instead of parsing text; the server's message is kept where it
 * carries details (the other vault's name, the destroy date).
 */
import type { ApiErrorCode } from "#bindings/ApiErrorCode";
import { ApiError } from "#ui/api-transport";
import { getErrorMessage } from "#ui/utils/error";
import { VaultUnwrapError } from "#ui/vault/vault-crypto";
import { PasskeyPrfUnsupported } from "#ui/vault/vault-passkeys";

/** Fixed messages for codes whose server text adds nothing. */
const messages: Partial<Record<ApiErrorCode, string>> = {
    vault_not_found: "No vault has been created yet.",
    vault_exists: "A vault already exists. Reload the page to unlock it.",
    vault_last_slot:
        "A vault keeps at least one unlock method. Add another one before removing this one.",
    vault_proof_invalid:
        "The vault key in this tab is out of date. Unlock the vault again.",
    not_a_vault_file: "Not a redoor vault file, or the file is corrupted.",
    vault_format_unsupported:
        "This vault file was created by a newer redoor. Upgrade the server to open it.",
    vault_header_corrupted: "The vault file header is corrupted.",
    vault_header_tampered:
        "The vault file header was tampered with, or the file key is wrong.",
    vault_payload_corrupted:
        "The vault file is corrupted or truncated, so its content cannot be trusted.",
    stale_vault_key:
        "The vault key was rotated in another tab or browser. Unlock the vault again.",
    vault_file_changed: "The file changed on the device since it was opened.",
    agent_upgrade_required:
        "This device's agent is too old to write vault files. Upgrade the agent first.",
    ssh_key_locked:
        "This device's SSH key is encrypted with the vault. Unlock the vault to use it.",
    vault_required:
        "This account has a vault, so new SSH keys are encrypted with it. Unlock the vault and try again.",
};

/** The vault error code of a failure, if it has one. */
export function vaultErrorCode(error: Error | null): ApiErrorCode | null {
    return error instanceof ApiError ? error.code : null;
}

/** A message for any failure of a vault flow. */
export function vaultErrorMessage(
    error: Error | null,
    fallback: string,
): string {
    if (error instanceof VaultUnwrapError) {
        return error.message;
    }

    if (error instanceof PasskeyPrfUnsupported) {
        return error.message;
    }

    if (error instanceof DOMException && error.name === "NotAllowedError") {
        return "The passkey prompt was cancelled or timed out.";
    }

    const code = vaultErrorCode(error);
    const message = code === null ? undefined : messages[code];

    return message ?? getErrorMessage(error, fallback);
}
