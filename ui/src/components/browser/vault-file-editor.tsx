import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";

import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { vaultErrorCode, vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    vaultFileContentQueryOptions,
    type VaultFileContent,
} from "#ui/vault/vault-files";
import { newWriteKeys, rewrapKeys } from "#ui/vault/vault-keys";
import { VaultUnlockCancelled } from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/**
 * The editor's view of one encrypted file: its decrypted content while unlocked, the revision a
 * save must name, and the save itself.
 *
 * Saves go through the encrypted write endpoint with a new file key every time. A save
 * against a version that changed on the device is refused by the server and reported as a
 * conflict, which the user resolves by overwriting or discarding.
 */
export function useVaultFile(props: {
    agent: Agent;
    path: string;
    enabled: boolean;
}) {
    const { vault } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    const state = React.useSyncExternalStore(
        vault.subscribe,
        vault.getSnapshot,
    );

    const options = vaultFileContentQueryOptions({
        agent: props.agent,
        path: props.path,
        vault,
        keyId: props.enabled ? state.currentKeyId : null,
    });

    const query = useQuery(options);
    const [conflict, setConflict] = React.useState(false);
    const overwrite = React.useRef(false);

    /** Encrypts and writes `content`, returning the new revision. */
    const save = async (content: string): Promise<string> => {
        const unlocked = await vault.requestUnlock(
            "Saving an encrypted file needs the vault key",
        );

        const expectedRevision = overwrite.current
            ? (await props.agent.vaultHeader(props.path)).revision
            : query.data?.revision;

        if (expectedRevision === undefined) {
            throw new Error("The file has not been read yet");
        }

        try {
            const written = await props.agent.vaultSave(props.path, {
                content: new Blob([content]),
                keys: await newWriteKeys(unlocked),
                expectedRevision,
            });

            overwrite.current = false;
            setConflict(false);

            return written.revision ?? expectedRevision;
        } catch (error) {
            if (
                vaultErrorCode(error instanceof Error ? error : null) ===
                "vault_file_changed"
            ) {
                setConflict(true);
            }

            throw error;
        }
    };

    /** Records what a save wrote as the device version. */
    const adopt = (content: string, revision: string) => {
        queryClient.setQueryData(options.queryKey, {
            content,
            revision,
            keyStatus: { status: "current" },
        } satisfies VaultFileContent);
    };

    return {
        isLocked: props.enabled && state.status === "locked",
        keyStatus: query.data?.keyStatus ?? null,
        conflict,
        save,
        adopt,
        refetch: query.refetch,
        /** Lets the next save replace whatever the device holds now. */
        allowOverwrite: () => {
            overwrite.current = true;
        },
        unlock: () =>
            vault
                .requestUnlock("Opening an encrypted file needs the vault key")
                .then(() => undefined),
    };
}

export type VaultFileState = ReturnType<typeof useVaultFile>;

/** Shown instead of the editor while the vault is locked. */
export function VaultLockedPanel(props: {
    fileName: string;
    onUnlock: () => Promise<void>;
}) {
    const unlock = useMutation({ mutationFn: props.onUnlock });

    const failure =
        unlock.error && !(unlock.error instanceof VaultUnlockCancelled)
            ? unlock.error
            : null;

    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <LockKeyhole
                className="h-8 w-8 text-slate-400"
                aria-hidden="true"
            />
            <p className="text-sm text-slate-300">
                {props.fileName} is encrypted with your vault.
            </p>
            <Button
                type="button"
                tooltip="Unlock the vault to open this file"
                isLoading={unlock.isPending}
                onClick={() => unlock.mutate()}
            >
                Unlock vault
            </Button>
            {failure === null ? null : (
                <p role="alert" className="text-sm text-red-300">
                    {vaultErrorMessage(failure, "Failed to unlock")}
                </p>
            )}
        </div>
    );
}

/**
 * The banners of an encrypted file: an older key generation (offer a rewrap, which writes only a
 * new header) and a save that conflicted with a newer version on the device.
 */
export function VaultFileBanners(props: {
    agent: Agent;
    path: string;
    deviceName: string;
    vaultFile: VaultFileState;
    onOverwrite: () => void;
    onDiscard: (content: string) => void;
}) {
    const { vault } = rootRouteApi.useRouteContext();

    const rewrap = useMutation({
        mutationFn: async () => {
            const unlocked = await vault.requestUnlock(
                "Updating the file's encryption needs the vault key",
            );

            const header = await props.agent.vaultHeader(props.path);
            const keys = await rewrapKeys(unlocked, header.header);

            await props.agent.vaultRewrap(props.path, {
                file_key: keys.fileKey,
                key_id: keys.keyId,
                wrap: keys.wrap,
                expected_revision: header.revision,
            });
        },
        onSuccess: () => props.vaultFile.refetch(),
    });

    const discard = useMutation({
        mutationFn: async () => {
            const result = await props.vaultFile.refetch();

            if (result.data !== undefined) {
                props.onDiscard(result.data.content);
            }
        },
    });

    return (
        <>
            {props.vaultFile.keyStatus?.status === "older" ? (
                <div
                    role="status"
                    aria-label="Older vault key"
                    className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-200"
                >
                    <span>Encrypted with an older vault key.</span>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        tooltip="Move this file to the current vault key without changing its content"
                        isLoading={rewrap.isPending}
                        onClick={() => rewrap.mutate()}
                    >
                        Re-encrypt
                    </Button>
                    {rewrap.error ? (
                        <span role="alert" className="w-full text-red-300">
                            {vaultErrorMessage(
                                rewrap.error,
                                "Failed to update",
                            )}
                        </span>
                    ) : null}
                </div>
            ) : null}
            {props.vaultFile.conflict ? (
                <div
                    role="alert"
                    aria-label="File changed on device"
                    className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
                >
                    <span>
                        This file changed on {props.deviceName} after you opened
                        it, so your save was not written.
                    </span>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            tooltip="Save your version over the one on the device"
                            onClick={props.onOverwrite}
                        >
                            Overwrite
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            tooltip="Throw away your changes and load the device version"
                            isLoading={discard.isPending}
                            onClick={() => discard.mutate()}
                        >
                            Discard my changes
                        </Button>
                    </div>
                </div>
            ) : null}
        </>
    );
}
