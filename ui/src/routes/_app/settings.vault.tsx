import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
    Download,
    Fingerprint,
    KeyRound,
    Lock,
    LockKeyhole,
    LockOpen,
    Pencil,
    RefreshCw,
    Trash2,
    Upload,
} from "lucide-react";

import type { VaultSummary } from "#bindings/VaultSummary";
import type { VaultSlotSummary } from "#bindings/VaultSlotSummary";
import { Button } from "#ui/components/button";
import { DetailCard } from "#ui/components/detail-card";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import { useVaultSession } from "#ui/components/vault-dialog";
import {
    RotateVaultDialog,
    type RotationIntent,
} from "#ui/components/vault/rotate-vault-dialog";
import {
    AddPassphraseDialog,
    AddPasskeyDialog,
    DestroyGenerationDialog,
    RenameVaultDialog,
    RestoreBackupDialog,
} from "#ui/components/vault/vault-dialogs";
import {
    VaultScan,
    type ScannedVaultFile,
} from "#ui/components/vault/vault-scan";
import { VaultSshKeys } from "#ui/components/vault/vault-ssh-keys";
import { queryKeys, vaultStatusQueryOptions } from "#ui/queries";
import { rewrapOlderSshKeys } from "#ui/vault/ssh-key-vault";
import { fingerprint } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import { isPasskeySupported } from "#ui/vault/vault-passkeys";
import { VaultUnlockCancelled } from "#ui/vault/vault-session";

export const Route = createFileRoute("/_app/settings/vault")({
    loader: async ({ context }) => {
        await context.queryClient.ensureQueryData(
            vaultStatusQueryOptions(context.api),
        );
    },
    component: VaultSettingsPage,
});

/** The dialog the page shows, one at a time. */
type OpenDialog =
    | { type: "rotate"; intent: RotationIntent }
    | { type: "add-passkey" }
    | { type: "add-passphrase" }
    | { type: "rename-vault" }
    | { type: "rename-slot"; slot: VaultSlotSummary }
    | { type: "destroy"; keyId: string }
    | { type: "restore" };

/** Formats a stored RFC 3339 date for the lists. */
function formatDate(value: string | null): string {
    return value === null ? "never" : new Date(value).toLocaleString();
}

/**
 * The vault's settings: lock state, unlock methods, key generations, backup and the scan
 * that finds vault files on devices.
 */
function VaultSettingsPage() {
    const { api, queryClient, vault } = Route.useRouteContext();
    const statusQuery = useQuery(vaultStatusQueryOptions(api));
    const [dialog, setDialog] = React.useState<OpenDialog | null>(null);

    const [scanned, setScanned] = React.useState<ScannedVaultFile[] | null>(
        null,
    );

    const [notice, setNotice] = React.useState<string | null>(null);
    const summary = statusQuery.data?.vault ?? null;
    const close = () => setDialog(null);

    /**
     * SSH keys are on the server at known paths, so unlike files on devices they are moved
     * to the new key right after a rotation, without a scan.
     */
    const afterRotation = async () => {
        const failed = await rewrapOlderSshKeys({ api, vault }).catch(
            () => null,
        );

        await queryClient.invalidateQueries({
            queryKey: queryKeys.vaultSshKeys(),
        });
        setNotice(
            failed === 0
                ? "Vault key rotated and SSH keys rewrapped. Download a new vault backup, then find vault files to rewrap."
                : "Vault key rotated, but some SSH keys still use the old key; rewrap them below. Download a new vault backup, then find vault files to rewrap.",
        );
    };

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <div className="mx-auto grid max-w-5xl gap-6">
                <header>
                    <h1 className="text-2xl font-semibold text-slate-100">
                        Vault
                    </h1>
                    <p className="mt-1 text-sm text-slate-400">
                        Encrypts files ending in <code>.redoorvault</code>.
                        Devices only store ciphertext, and the vault key never
                        leaves your browser.
                    </p>
                </header>
                {statusQuery.isError ? (
                    <p role="alert" className="text-red-300">
                        {vaultErrorMessage(
                            statusQuery.error,
                            "Could not load the vault",
                        )}
                    </p>
                ) : summary === null ? (
                    <NoVault onRestore={() => setDialog({ type: "restore" })} />
                ) : (
                    <>
                        <LockCard
                            summary={summary}
                            onRename={() => setDialog({ type: "rename-vault" })}
                        />
                        <SlotsCard
                            summary={summary}
                            onAddPasskey={() =>
                                setDialog({ type: "add-passkey" })
                            }
                            onAddPassphrase={() =>
                                setDialog({ type: "add-passphrase" })
                            }
                            onChangePassphrase={() =>
                                setDialog({
                                    type: "rotate",
                                    intent: { type: "change-passphrase" },
                                })
                            }
                            onRename={(slot) =>
                                setDialog({ type: "rename-slot", slot })
                            }
                            onRemove={(slot) =>
                                setDialog({
                                    type: "rotate",
                                    intent: { type: "remove-slot", slot },
                                })
                            }
                        />
                        <GenerationsCard
                            summary={summary}
                            onRotate={() =>
                                setDialog({
                                    type: "rotate",
                                    intent: { type: "rotate" },
                                })
                            }
                            onDestroy={(keyId) =>
                                setDialog({ type: "destroy", keyId })
                            }
                        />
                        <BackupCard
                            backupUrl={api.getVaultBackupUrl()}
                            onRestore={() => setDialog({ type: "restore" })}
                        />
                        <DetailCard
                            title="Vault files"
                            icon={
                                <KeyRound
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                        >
                            <VaultScan files={scanned} onFiles={setScanned} />
                        </DetailCard>
                        <DetailCard
                            title="SSH keys"
                            icon={
                                <LockKeyhole
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                        >
                            <VaultSshKeys />
                        </DetailCard>
                    </>
                )}
            </div>
            {dialog?.type === "rotate" ? (
                <RotateVaultDialog
                    intent={dialog.intent}
                    onClose={close}
                    onRotated={() => void afterRotation()}
                />
            ) : null}
            {dialog?.type === "add-passkey" ? (
                <AddPasskeyDialog onClose={close} />
            ) : null}
            {dialog?.type === "add-passphrase" ? (
                <AddPassphraseDialog onClose={close} />
            ) : null}
            {dialog?.type === "rename-vault" && summary !== null ? (
                <RenameVaultDialog
                    title="Rename vault"
                    initialLabel={summary.label}
                    onRename={(label, proof) =>
                        api.updateVault({ auth_proof: proof, label })
                    }
                    onClose={close}
                />
            ) : null}
            {dialog?.type === "rename-slot" ? (
                <RenameVaultDialog
                    title={`Rename ${dialog.slot.label}`}
                    initialLabel={dialog.slot.label}
                    onRename={(label, proof) =>
                        api.renameVaultSlot(dialog.slot.id, {
                            auth_proof: proof,
                            label,
                        })
                    }
                    onClose={close}
                />
            ) : null}
            {dialog?.type === "destroy" ? (
                <DestroyGenerationDialog
                    keyId={dialog.keyId}
                    scannedFiles={
                        scanned === null
                            ? null
                            : scanned.filter(
                                  (file) =>
                                      file.header?.header.key_id ===
                                      dialog.keyId,
                              ).length
                    }
                    onClose={close}
                />
            ) : null}
            {dialog?.type === "restore" ? (
                <RestoreBackupDialog
                    hasVault={summary !== null}
                    onClose={close}
                />
            ) : null}
            {notice === null ? null : (
                <Toast tone="success" onDismiss={() => setNotice(null)}>
                    {notice}
                </Toast>
            )}
        </div>
    );
}

/** Shown before a vault exists: creating one goes through the shared vault dialog. */
function NoVault(props: { onRestore: () => void }) {
    const { session } = useVaultSession();

    return (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-700 px-6 py-12 text-center">
            <LockKeyhole
                className="h-6 w-6 text-slate-400"
                aria-hidden="true"
            />
            <p className="mt-4 font-medium text-slate-200">No vault yet</p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
                <Button
                    type="button"
                    tooltip="Create a vault protected by a passkey, a passphrase or both"
                    onClick={() =>
                        void session
                            .requestUnlock("Create a vault to encrypt files")
                            .catch(() => undefined)
                    }
                >
                    Create vault
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Install a vault from a backup file"
                    onClick={props.onRestore}
                >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Restore from backup
                </Button>
            </div>
        </div>
    );
}

/** The vault's name, fingerprint and lock state with lock and unlock actions. */
function LockCard(props: { summary: VaultSummary; onRename: () => void }) {
    const { session, state } = useVaultSession();
    const [error, setError] = React.useState<string | null>(null);
    const unlocked = state.status === "unlocked";

    // The tab holds another generation than the server: it was rotated elsewhere.
    const stale =
        unlocked && state.currentKeyId !== props.summary.current_key_id;

    return (
        <DetailCard
            title={props.summary.label}
            icon={
                unlocked ? (
                    <LockOpen className="h-5 w-5" aria-hidden="true" />
                ) : (
                    <Lock className="h-5 w-5" aria-hidden="true" />
                )
            }
            actions={
                <IconButton
                    type="button"
                    label="Rename vault"
                    tooltip="Rename vault"
                    variant="ghost"
                    onClick={props.onRename}
                >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
            }
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-400">
                    <span aria-label="Vault status">
                        {stale
                            ? "Unlocked with an old key; unlock again"
                            : unlocked
                              ? state.persisted
                                  ? "Unlocked, kept on this device"
                                  : "Unlocked"
                              : "Locked"}
                    </span>
                    <span className="block text-xs text-slate-500">
                        Fingerprint {fingerprint(props.summary.vault_id)} ·
                        created {formatDate(props.summary.created_at)}
                    </span>
                </p>
                {unlocked ? (
                    <Button
                        type="button"
                        variant="secondary"
                        tooltip="Forget the vault key in every tab and on this device"
                        onClick={() => void session.lock()}
                    >
                        <Lock className="h-4 w-4" aria-hidden="true" />
                        Lock now
                    </Button>
                ) : (
                    <Button
                        type="button"
                        tooltip="Unlock the vault in this browser"
                        onClick={() => {
                            setError(null);
                            session
                                .requestUnlock("Unlock the vault")
                                .catch((failure: Error) => {
                                    if (
                                        !(
                                            failure instanceof
                                            VaultUnlockCancelled
                                        )
                                    ) {
                                        setError(failure.message);
                                    }
                                });
                        }}
                    >
                        <LockOpen className="h-4 w-4" aria-hidden="true" />
                        Unlock
                    </Button>
                )}
            </div>
            {error === null ? null : (
                <p role="alert" className="mt-2 text-sm text-red-300">
                    {error}
                </p>
            )}
        </DetailCard>
    );
}

/**
 * The passphrase and passkey slots. Any slot can be removed while another remains, because
 * every slot wraps the same key; the last one stays, or nothing could unlock the vault.
 */
function SlotsCard(props: {
    summary: VaultSummary;
    onAddPasskey: () => void;
    onAddPassphrase: () => void;
    onChangePassphrase: () => void;
    onRename: (slot: VaultSlotSummary) => void;
    onRemove: (slot: VaultSlotSummary) => void;
}) {
    const passphrase = props.summary.slots.find(
        (slot) => slot.type === "passphrase",
    );

    const canRemove = props.summary.slots.length > 1;

    return (
        <DetailCard
            title="Unlock methods"
            icon={<Fingerprint className="h-5 w-5" aria-hidden="true" />}
        >
            <ul className="grid gap-2">
                {props.summary.slots.map((slot) => (
                    <SlotRow
                        key={slot.id}
                        slot={slot}
                        canRemove={canRemove}
                        onRename={() => props.onRename(slot)}
                        onRemove={() => props.onRemove(slot)}
                    />
                ))}
            </ul>
            {passphrase === undefined ? (
                <p className="mt-3 text-xs text-amber-300">
                    No passphrase: only the passkeys unlock this vault, each on
                    its own hostname. Losing them loses every encrypted file.
                </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
                <Button
                    type="button"
                    variant="secondary"
                    tooltip={
                        isPasskeySupported()
                            ? "Register a passkey that can unlock the vault"
                            : "Passkeys need a secure (HTTPS) page and a supporting browser"
                    }
                    disabled={!isPasskeySupported()}
                    onClick={props.onAddPasskey}
                >
                    <Fingerprint className="h-4 w-4" aria-hidden="true" />
                    Add passkey
                </Button>
                {passphrase === undefined ? (
                    <Button
                        type="button"
                        variant="secondary"
                        tooltip="Add a passphrase that unlocks the vault on any hostname"
                        onClick={props.onAddPassphrase}
                    >
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        Add passphrase
                    </Button>
                ) : (
                    <>
                        <Button
                            type="button"
                            variant="secondary"
                            tooltip="Replace the vault passphrase"
                            onClick={props.onChangePassphrase}
                        >
                            Change passphrase
                        </Button>
                        {canRemove ? (
                            <Button
                                type="button"
                                variant="secondary"
                                tooltip="Unlock only with passkeys from now on"
                                onClick={() => props.onRemove(passphrase)}
                            >
                                <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                Remove passphrase
                            </Button>
                        ) : null}
                    </>
                )}
            </div>
        </DetailCard>
    );
}

/** One slot with its rename and, unless it is the last one, remove actions. */
function SlotRow(props: {
    slot: VaultSlotSummary;
    canRemove: boolean;
    onRename: () => void;
    onRemove: () => void;
}) {
    return (
        <li
            aria-label={`Unlock method ${props.slot.label}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 px-3 py-2"
        >
            <span className="min-w-0 text-sm text-slate-200">
                {props.slot.label}
                <span className="block text-xs text-slate-500">
                    {props.slot.type === "passkey"
                        ? `Passkey for ${props.slot.rp_id ?? "unknown host"}`
                        : "Passphrase"}{" "}
                    · added {formatDate(props.slot.created_at)} · last used{" "}
                    {formatDate(props.slot.last_used_at)}
                </span>
            </span>
            <span className="flex gap-1">
                <IconButton
                    type="button"
                    label={`Rename ${props.slot.label}`}
                    tooltip="Rename"
                    variant="ghost"
                    onClick={props.onRename}
                >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                {props.canRemove ? (
                    <IconButton
                        type="button"
                        label={`Remove ${props.slot.label}`}
                        tooltip="Remove"
                        variant="ghost"
                        onClick={props.onRemove}
                    >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                ) : null}
            </span>
        </li>
    );
}

/** The key generations, newest first. */
function GenerationsCard(props: {
    summary: VaultSummary;
    onRotate: () => void;
    onDestroy: (keyId: string) => void;
}) {
    return (
        <DetailCard
            title="Key generations"
            icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
            actions={
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip="Create a new key for all new writes; old files keep opening"
                    onClick={props.onRotate}
                >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Rotate vault key
                </Button>
            }
        >
            <ul className="grid gap-2">
                {props.summary.generations.map((generation) => (
                    <li
                        key={generation.key_id}
                        aria-label={`Key generation ${fingerprint(generation.key_id)}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 px-3 py-2 text-sm"
                    >
                        <span className="text-slate-200">
                            <span className="font-mono">
                                {fingerprint(generation.key_id)}
                            </span>
                            {generation.current ? (
                                <span className="ml-2 rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-300">
                                    Current
                                </span>
                            ) : null}
                            <span className="block text-xs text-slate-500">
                                Created {formatDate(generation.created_at)}
                            </span>
                        </span>
                        {generation.current ? null : (
                            <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                tooltip="Make files on this key permanently unreadable"
                                onClick={() =>
                                    props.onDestroy(generation.key_id)
                                }
                            >
                                Destroy
                            </Button>
                        )}
                    </li>
                ))}
                {props.summary.retired_keys.map((retired) => (
                    <li
                        key={retired.key_id}
                        className="rounded border border-dashed border-slate-800 px-3 py-2 text-sm text-slate-500"
                    >
                        <span className="font-mono">
                            {fingerprint(retired.key_id)}
                        </span>{" "}
                        destroyed {formatDate(retired.destroyed_at)}
                    </li>
                ))}
            </ul>
        </DetailCard>
    );
}

/** Backup download and restore. */
function BackupCard(props: { backupUrl: string; onRestore: () => void }) {
    return (
        <DetailCard
            title="Backup"
            icon={<Download className="h-5 w-5" aria-hidden="true" />}
        >
            <p className="text-sm text-slate-400">
                Losing the vault loses every encrypted file, whatever passkeys
                you have. The backup holds only wrapped keys, so it is safe to
                store anywhere. Download a new one after every rotation.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
                <Button
                    as="a"
                    href={props.backupUrl}
                    download
                    variant="secondary"
                    tooltip="Save vault.json with its wrapped keys"
                >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Download vault backup
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Replace the vault with a backup"
                    onClick={props.onRestore}
                >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Restore from backup
                </Button>
            </div>
        </DetailCard>
    );
}
