import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";

import type { VaultSshKey } from "#bindings/VaultSshKey";
import { Button } from "#ui/components/button";
import { queryKeys, vaultSshKeysQueryOptions } from "#ui/queries";
import { rewrapSshKey } from "#ui/vault/ssh-key-vault";
import { fingerprint } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";

const rootRouteApi = getRouteApi("__root__");

/** The groups the list shows, in order. */
const groups = [
    { key: "older", title: "On an older key" },
    { key: "current", title: "On the current key" },
    { key: "foreign_vault", title: "From another vault" },
    { key: "retired", title: "On a destroyed key" },
    { key: "unknown_key", title: "On an unknown key" },
    { key: "no_vault", title: "Without a vault" },
] as const;

/**
 * The managed SSH keys encrypted with the vault, grouped by key generation. They live on
 * the server, so the device scan does not find them; keys on an older generation can be
 * rewrapped here (a new header, same key), which a generation must have before it can be
 * destroyed. Keys of another vault, for example after restoring another vault's backup,
 * are fixed by setting the device's key up again.
 */
export function VaultSshKeys() {
    const { api, vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const keysQuery = useQuery(vaultSshKeysQueryOptions(api));

    const rewrap = useMutation({
        mutationFn: async (keys: VaultSshKey[]) => {
            const unlocked = await vault.requestUnlock(
                "Rewrapping SSH keys needs the vault key",
            );

            for (const key of keys) {
                await rewrapSshKey({ api, vault: unlocked, key });
            }
        },
        onSettled: () =>
            queryClient.invalidateQueries({
                queryKey: queryKeys.vaultSshKeys(),
            }),
    });

    const keys = keysQuery.data?.keys;

    return (
        <section aria-label="Vault SSH keys" className="grid gap-3">
            <p className="text-sm text-slate-400">
                Managed SSH keys of devices, stored on this server and encrypted
                with the vault.
            </p>
            {keysQuery.isError || rewrap.isError ? (
                <p role="alert" className="text-sm text-red-300">
                    {vaultErrorMessage(
                        keysQuery.error ?? rewrap.error,
                        "Could not update the SSH keys",
                    )}
                </p>
            ) : null}
            {keys === undefined ? null : keys.length === 0 ? (
                <p className="text-sm text-slate-400">
                    No SSH keys are encrypted with the vault.
                </p>
            ) : (
                groups.map((group) => {
                    const grouped = keys.filter(
                        (key) => key.key_status.status === group.key,
                    );

                    if (grouped.length === 0) {
                        return null;
                    }

                    return (
                        <div key={group.key} className="grid gap-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm font-semibold text-slate-200">
                                    {group.title} ({grouped.length})
                                </h3>
                                {group.key === "older" ? (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        tooltip="Move every SSH key in this list to the current vault key"
                                        isLoading={rewrap.isPending}
                                        disabled={rewrap.isPending}
                                        onClick={() => rewrap.mutate(grouped)}
                                    >
                                        <RefreshCw
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                        Rewrap SSH keys
                                    </Button>
                                ) : null}
                            </div>
                            <ul className="grid gap-1">
                                {grouped.map((key) => (
                                    <li
                                        key={key.device_id}
                                        aria-label={`SSH key of ${key.device_name ?? key.device_id}`}
                                        className="rounded border border-slate-800 px-3 py-2 text-sm"
                                    >
                                        <span className="block break-all text-slate-200">
                                            {key.device_name ?? key.device_id}
                                        </span>
                                        <span className="block text-xs text-slate-500">
                                            {key.key_status.status ===
                                            "foreign_vault"
                                                ? `${key.header.vault_label} (${fingerprint(key.header.vault_id)}); set the key up again`
                                                : `Key ${fingerprint(key.header.key_id)}`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })
            )}
        </section>
    );
}
