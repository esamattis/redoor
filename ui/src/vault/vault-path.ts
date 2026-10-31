/**
 * Path rules of `.redoorvault` files. Kept free of dependencies, so the editor and the
 * file browser can check names without loading the vault's crypto.
 */

/** The suffix that marks an encrypted file. */
export const VAULT_SUFFIX = ".redoorvault";

/**
 * Whether a path or name is a vault file: a name before the suffix. The agent never calls
 * vault ciphertext editable, so the file browser asks this to open such files in the
 * editor, which decrypts them.
 */
export function isVaultPath(path: string): boolean {
    const name = path.split("/").pop() ?? path;

    return name.endsWith(VAULT_SUFFIX) && name.length > VAULT_SUFFIX.length;
}

/** The name without the vault suffix, for highlighting and decrypted downloads. */
export function stripVaultSuffix(name: string): string {
    return isVaultPath(name) ? name.slice(0, -VAULT_SUFFIX.length) : name;
}

/**
 * Whether the editor opens a file: text the agent verified as editable, or a vault file,
 * whose ciphertext the agent never calls editable but the editor decrypts.
 */
export function opensInEditor(
    metadata: { editable: boolean; is_file: boolean; path: string } | null,
): boolean {
    return (
        metadata !== null &&
        (metadata.editable || (metadata.is_file && isVaultPath(metadata.path)))
    );
}
