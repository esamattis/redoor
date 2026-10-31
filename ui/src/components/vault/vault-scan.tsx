import React from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";

import type { Agent } from "#ui/api-client";
import type { VaultFileHeaderResponse } from "#bindings/VaultFileHeaderResponse";
import { Button } from "#ui/components/button";
import { useAgents } from "#ui/use-agents";
import { fingerprint } from "#ui/vault/vault-crypto";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import {
    fileKeyForHeader,
    newWriteKeys,
    rewrapKeys,
} from "#ui/vault/vault-keys";

const rootRouteApi = getRouteApi("__root__");

/** How long each device may search. */
const SEARCH_SECONDS = 20;

/** One `.redoorencrypted` file a scan found, with its header or why it could not be read. */
export type ScannedVaultFile = {
    agent: Agent;
    path: string;
    header: VaultFileHeaderResponse | null;
    error: string | null;
};

/** The groups a scan shows, in order. */
const groups = [
    { key: "older", title: "On an older key" },
    { key: "current", title: "On the current key" },
    { key: "foreign_vault", title: "From another vault" },
    { key: "retired", title: "On a destroyed key" },
    { key: "unknown_key", title: "On an unknown key" },
    { key: "no_vault", title: "Without a vault" },
    { key: "error", title: "Unreadable" },
] as const;

/** The group a scanned file belongs to. */
function groupOf(file: ScannedVaultFile): (typeof groups)[number]["key"] {
    return file.header?.key_status.status ?? "error";
}

/** Searches one device from its default directory and reads every header found. */
async function scanAgent(agent: Agent): Promise<ScannedVaultFile[]> {
    const root = agent.cwd ?? "/";

    const found = await agent.searchFiles(root, ".redoorencrypted", {
        timeoutSeconds: SEARCH_SECONDS,
        includeHidden: true,
        respectGitignore: false,
    });

    const paths = found.results
        .filter(
            (entry) =>
                entry.type === "file" &&
                entry.name.endsWith(".redoorencrypted"),
        )
        .map((entry) => entry.path);

    return Promise.all(
        paths.map(async (path) => {
            try {
                return {
                    agent,
                    path,
                    header: await agent.vaultHeader(path),
                    error: null,
                };
            } catch (error) {
                return {
                    agent,
                    path,
                    header: null,
                    error: vaultErrorMessage(
                        error instanceof Error ? error : null,
                        "Could not read the header",
                    ),
                };
            }
        }),
    );
}

/**
 * Finds encrypted files on the connected devices with the file search, reads only their headers
 * (which works while locked) and groups them by vault and key generation. Files on an older
 * generation can be rewrapped (a new header, same payload); any file of this vault can be
 * re-encrypted with a new file key, for files a compromised server may have seen.
 */
export function VaultScan(props: {
    files: ScannedVaultFile[] | null;
    onFiles: (files: ScannedVaultFile[]) => void;
}) {
    const { vault } = rootRouteApi.useRouteContext();
    const agents = useAgents().filter((agent) => agent.status === "connected");
    const [busyPath, setBusyPath] = React.useState<string | null>(null);

    const scan = useMutation({
        mutationFn: async () =>
            (await Promise.all(agents.map((agent) => scanAgent(agent)))).flat(),
        onSuccess: props.onFiles,
    });

    const update = useMutation({
        mutationFn: async (request: {
            file: ScannedVaultFile;
            mode: "rewrap" | "reencrypt";
        }) => {
            const { file } = request;
            const header = file.header;

            if (header === null) {
                return;
            }

            setBusyPath(`${file.agent.id}:${file.path}`);

            const unlocked = await vault.requestUnlock(
                "Updating encrypted files needs the vault key",
            );

            if (request.mode === "rewrap") {
                const keys = await rewrapKeys(unlocked, header.header);

                await file.agent.vaultRewrap(file.path, {
                    file_key: keys.fileKey,
                    key_id: keys.keyId,
                    wrap: keys.wrap,
                    expected_revision: header.revision,
                });
            } else {
                const keys = await newWriteKeys(unlocked);

                await file.agent.vaultReencrypt(file.path, {
                    file_key: await fileKeyForHeader(unlocked, header.header),
                    new_file_key: keys.fileKey,
                    key_id: keys.keyId,
                    wrap: keys.wrap,
                    expected_revision: header.revision,
                });
            }
        },
        onSettled: () => setBusyPath(null),
        onSuccess: async (_, request) => {
            const refreshed = await request.file.agent
                .vaultHeader(request.file.path)
                .catch(() => null);

            props.onFiles(
                (props.files ?? []).map((entry) =>
                    entry === request.file
                        ? { ...entry, header: refreshed }
                        : entry,
                ),
            );
        },
    });

    /** Rewraps every older file one after another, so a conflict stops only that file. */
    const rewrapAll = async (files: ScannedVaultFile[]) => {
        for (const file of files) {
            await update
                .mutateAsync({ file, mode: "rewrap" })
                .catch(() => undefined);
        }
    };

    return (
        <section aria-label="Encrypted files" className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-400">
                    Searches the default directory of every connected device (
                    {agents.length}) for <code>*.redoorencrypted</code>.
                </p>
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Search the connected devices for encrypted files"
                    isLoading={scan.isPending}
                    disabled={agents.length === 0}
                    onClick={() => scan.mutate()}
                >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    Find encrypted files
                </Button>
            </div>
            {scan.error || update.error ? (
                <p role="alert" className="text-sm text-red-300">
                    {vaultErrorMessage(
                        scan.error ?? update.error,
                        "The scan failed",
                    )}
                </p>
            ) : null}
            {props.files === null ? null : props.files.length === 0 ? (
                <p className="text-sm text-slate-400">
                    No encrypted files found.
                </p>
            ) : (
                groups.map((group) => {
                    const files = props.files?.filter(
                        (file) => groupOf(file) === group.key,
                    );

                    if (!files || files.length === 0) {
                        return null;
                    }

                    return (
                        <div key={group.key} className="grid gap-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm font-semibold text-slate-200">
                                    {group.title} ({files.length})
                                </h3>
                                {group.key === "older" ? (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        tooltip="Move every file in this list to the current key"
                                        disabled={update.isPending}
                                        onClick={() => void rewrapAll(files)}
                                    >
                                        <RefreshCw
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                        Rewrap all
                                    </Button>
                                ) : null}
                            </div>
                            <ul className="grid gap-1">
                                {files.map((file) => (
                                    <ScannedFileRow
                                        key={`${file.agent.id}:${file.path}`}
                                        file={file}
                                        isBusy={
                                            busyPath ===
                                            `${file.agent.id}:${file.path}`
                                        }
                                        disabled={update.isPending}
                                        onRewrap={() =>
                                            update.mutate({
                                                file,
                                                mode: "rewrap",
                                            })
                                        }
                                        onReencrypt={() =>
                                            update.mutate({
                                                file,
                                                mode: "reencrypt",
                                            })
                                        }
                                    />
                                ))}
                            </ul>
                        </div>
                    );
                })
            )}
        </section>
    );
}

/** One file of a scan with its actions. */
function ScannedFileRow(props: {
    file: ScannedVaultFile;
    isBusy: boolean;
    disabled: boolean;
    onRewrap: () => void;
    onReencrypt: () => void;
}) {
    const status = props.file.header?.key_status.status;
    const ours = status === "current" || status === "older";

    return (
        <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 px-3 py-2">
            <span className="min-w-0 text-sm">
                <span className="text-slate-400">
                    {props.file.agent.name}:{" "}
                </span>
                <span className="break-all font-mono text-slate-200">
                    {props.file.path}
                </span>
                {props.file.header === null ? (
                    <span className="block text-xs text-red-300">
                        {props.file.error}
                    </span>
                ) : status === "foreign_vault" ? (
                    <span className="block text-xs text-slate-500">
                        {props.file.header.header.vault_label} (
                        {fingerprint(props.file.header.header.vault_id)})
                    </span>
                ) : (
                    <span className="block text-xs text-slate-500">
                        Key {fingerprint(props.file.header.header.key_id)}
                    </span>
                )}
            </span>
            {ours ? (
                <span className="flex gap-2">
                    {status === "older" ? (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            tooltip="Write a new header with the current key; the content stays as it is"
                            isLoading={props.isBusy}
                            disabled={props.disabled}
                            onClick={props.onRewrap}
                        >
                            Rewrap
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        tooltip="Encrypt the content again with a new file key"
                        disabled={props.disabled}
                        onClick={props.onReencrypt}
                    >
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        Re-encrypt
                    </Button>
                </span>
            ) : null}
        </li>
    );
}
