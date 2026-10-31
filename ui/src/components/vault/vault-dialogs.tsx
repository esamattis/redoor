import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Fingerprint, Upload } from "lucide-react";

import type { VaultDocument } from "#bindings/VaultDocument";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { FileInput, type FileInputHandle } from "#ui/components/file-input";
import { Password } from "#ui/components/password";
import { TextField } from "#ui/components/text-field";
import { queryKeys } from "#ui/queries";
import { newSlotId, wipe } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    addSlotInput,
    buildDestroy,
    currentProof,
    openPassphraseSlot,
    proofFromRaw,
} from "#ui/vault/vault-keys";
import { registerPasskey } from "#ui/vault/vault-passkeys";
import { parseVaultBackup } from "#ui/vault/vault-document";

const rootRouteApi = getRouteApi("__root__");

/** Refreshes every view of the vault after a change. */
function useInvalidateVault() {
    const queryClient = useQueryClient();

    return () => queryClient.invalidateQueries({ queryKey: queryKeys.vault() });
}

/**
 * Registers a passkey as a new slot. Wrapping the vault key for it needs the raw key, which
 * only a fresh unlock yields, so the passphrase is asked for even while unlocked.
 */
export function AddPasskeyDialog(props: { onClose: () => void }) {
    const { api } = rootRouteApi.useRouteContext();
    const invalidate = useInvalidateVault();
    const [label, setLabel] = React.useState("");
    const [passphrase, setPassphrase] = React.useState("");

    const add = useMutation({
        mutationFn: async () => {
            const material = await api.getVaultUnlockMaterial();
            const opened = await openPassphraseSlot(material, passphrase);

            try {
                const slotId = newSlotId();
                const name = label.trim() || "Passkey";

                const registered = await registerPasskey({
                    vaultId: material.vault_id,
                    slotId,
                    label: name,
                });

                await api.addVaultSlot({
                    auth_proof: await proofFromRaw(opened.rawVaultKey),
                    slot: await addSlotInput({
                        material,
                        rawVaultKey: opened.rawVaultKey,
                        slotId,
                        kek: {
                            type: "passkey",
                            label: name,
                            credentialId: registered.credentialId,
                            rpId: registered.rpId,
                            kek: registered.kek,
                        },
                    }),
                });
            } finally {
                wipe(opened.rawVaultKey);
            }
        },
        onSuccess: async () => {
            await invalidate();
            props.onClose();
        },
    });

    return (
        <Dialog
            isOpen
            title="Add passkey"
            description={`Passkeys only work on the hostname they are registered on: ${window.location.hostname}.`}
            closeAriaLabel="Cancel"
            isBusy={add.isPending}
            errorMessage={
                add.error
                    ? vaultErrorMessage(add.error, "Failed to add the passkey")
                    : null
            }
            onClose={props.onClose}
        >
            <form
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    add.mutate();
                }}
                className="mt-4 grid gap-4"
            >
                <TextField
                    label="Passkey name"
                    value={label}
                    placeholder="YubiKey 5C"
                    description="Helps you tell your passkeys apart"
                    disabled={add.isPending}
                    onChange={setLabel}
                />
                <Password
                    label="Vault passphrase"
                    value={passphrase}
                    autoComplete="current-password"
                    disabled={add.isPending}
                    onChange={setPassphrase}
                />
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={add.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        isLoading={add.isPending}
                        disabled={passphrase === ""}
                    >
                        <Fingerprint className="h-4 w-4" aria-hidden="true" />
                        Register passkey
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/** Renames the vault or one of its slots; both changes need the proof. */
export function RenameVaultDialog(props: {
    title: string;
    initialLabel: string;
    onRename: (label: string, proof: string) => Promise<object>;
    onClose: () => void;
}) {
    const { vault } = rootRouteApi.useRouteContext();
    const invalidate = useInvalidateVault();
    const [label, setLabel] = React.useState(props.initialLabel);

    const rename = useMutation({
        mutationFn: async () => {
            const unlocked = await vault.requestUnlock(
                "Renaming needs the vault key",
            );

            await props.onRename(label.trim(), await currentProof(unlocked));
        },
        onSuccess: async () => {
            await invalidate();
            props.onClose();
        },
    });

    return (
        <Dialog
            isOpen
            title={props.title}
            closeAriaLabel="Cancel"
            isBusy={rename.isPending}
            errorMessage={
                rename.error
                    ? vaultErrorMessage(rename.error, "Failed to rename")
                    : null
            }
            onClose={props.onClose}
        >
            <form
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    rename.mutate();
                }}
                className="mt-4"
            >
                <TextField
                    label="Name"
                    value={label}
                    placeholder={props.initialLabel}
                    description="1 to 100 characters"
                    required
                    autoFocus
                    disabled={rename.isPending}
                    onChange={setLabel}
                />
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={rename.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        isLoading={rename.isPending}
                        disabled={label.trim() === ""}
                    >
                        Rename
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}

/**
 * Destroys an older key generation after a warning that names how many scanned files still
 * use it; those files become permanently unreadable.
 */
export function DestroyGenerationDialog(props: {
    keyId: string;
    /** Files the last scan found on this generation, or null without a scan. */
    scannedFiles: number | null;
    onClose: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const invalidate = useInvalidateVault();

    const destroy = useMutation({
        mutationFn: async () => {
            const unlocked = await vault.requestUnlock(
                "Destroying a key generation needs the vault key",
            );

            const material = await api.getVaultUnlockMaterial();

            await api.destroyVaultKey(
                props.keyId,
                await buildDestroy({
                    material,
                    vault: unlocked,
                    keyId: props.keyId,
                }),
            );
        },
        onSuccess: async () => {
            await invalidate();
            props.onClose();
        },
    });

    return (
        <ConfirmationDialog
            isOpen
            title="Destroy key generation"
            description={
                <>
                    Files still encrypted with this generation become
                    permanently unreadable.{" "}
                    {props.scannedFiles === null
                        ? "Scan your devices first to find them."
                        : `The last scan found ${props.scannedFiles} such file${props.scannedFiles === 1 ? "" : "s"}.`}
                </>
            }
            confirmLabel="Destroy"
            busyLabel="Destroying…"
            isBusy={destroy.isPending}
            errorMessage={
                destroy.error
                    ? vaultErrorMessage(
                          destroy.error,
                          "Failed to destroy the generation",
                      )
                    : null
            }
            onClose={props.onClose}
            onConfirm={() => destroy.mutate()}
        />
    );
}

/**
 * Replaces the vault with a backup. The backup's passphrase proves it unlocks, and an
 * installed vault must be unlocked too, so a stolen session cannot swap the vault.
 */
export function RestoreBackupDialog(props: {
    hasVault: boolean;
    onClose: () => void;
}) {
    const { api, vault } = rootRouteApi.useRouteContext();
    const invalidate = useInvalidateVault();
    const fileInput = React.useRef<FileInputHandle>(null);
    const [backup, setBackup] = React.useState<VaultDocument | null>(null);
    const [fileError, setFileError] = React.useState<string | null>(null);
    const [passphrase, setPassphrase] = React.useState("");

    const restore = useMutation({
        mutationFn: async (document: VaultDocument) => {
            const currentKey = document.keys[0];

            if (currentKey === undefined) {
                throw new Error("The backup has no key generation");
            }

            const opened = await openPassphraseSlot(
                {
                    vault_id: document.vault_id,
                    current_key_id: currentKey.key_id,
                    slots: document.slots,
                    keys: document.keys,
                },
                passphrase,
            );

            try {
                const currentAuthProof = props.hasVault
                    ? await currentProof(
                          await vault.requestUnlock(
                              "Replacing the vault needs the installed vault's key",
                          ),
                      )
                    : null;

                await api.restoreVaultBackup({
                    backup: document,
                    backup_auth_proof: await proofFromRaw(opened.rawVaultKey),
                    current_auth_proof: currentAuthProof,
                });
            } finally {
                wipe(opened.rawVaultKey);
            }

            await vault.lock();
        },
        onSuccess: async () => {
            await invalidate();
            props.onClose();
        },
    });

    /** Reads the chosen file; nothing is sent until the passphrase is confirmed. */
    const choose = async (files: File[]) => {
        const file = files[0];

        if (file === undefined) {
            return;
        }

        const parsed = parseVaultBackup(await file.text());

        setBackup(parsed);
        setFileError(parsed === null ? "Not a vault backup" : null);
    };

    return (
        <Dialog
            isOpen
            title="Restore vault backup"
            description={
                props.hasVault
                    ? "The backup replaces the installed vault. Files encrypted with generations the backup does not know become unreadable."
                    : "The backup becomes this account's vault."
            }
            closeAriaLabel="Cancel"
            isBusy={restore.isPending}
            errorMessage={
                fileError ??
                (restore.error
                    ? vaultErrorMessage(
                          restore.error,
                          "Failed to restore the backup",
                      )
                    : null)
            }
            onClose={props.onClose}
        >
            <form
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();

                    if (backup !== null) {
                        restore.mutate(backup);
                    }
                }}
                className="mt-4 grid gap-4"
            >
                <FileInput
                    ref={fileInput}
                    label="Vault backup file"
                    onSelect={(files) => void choose(files)}
                />
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Pick a vault backup JSON file"
                    onClick={() => fileInput.current?.open()}
                    disabled={restore.isPending}
                >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    {backup === null ? "Choose backup file" : backup.label}
                </Button>
                <Password
                    label="The backup's passphrase"
                    value={passphrase}
                    autoComplete="current-password"
                    disabled={restore.isPending}
                    onChange={setPassphrase}
                />
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={restore.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="danger"
                        isLoading={restore.isPending}
                        disabled={backup === null || passphrase === ""}
                    >
                        Restore
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}
