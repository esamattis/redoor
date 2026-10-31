import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Download } from "lucide-react";

import type { Agent } from "#ui/api-client";
import { ActionMenuButton } from "#ui/components/action-menu";
import { Toast } from "#ui/components/toast";
import { vaultErrorMessage } from "#ui/vault/vault-errors";
import { fileKeyForHeader } from "#ui/vault/vault-keys";
import { VaultUnlockCancelled } from "#ui/vault/vault-session";

const rootRouteApi = getRouteApi("__root__");

/** How long the hidden frame of a download stays, so the browser can take the response over. */
const FRAME_LIFETIME_MS = 5 * 60 * 1000;

/**
 * Starts a decrypted download as a form `POST` into a hidden frame. A form navigation lets
 * the browser save the `Content-Disposition: attachment` response straight to disk as a
 * stream, which `fetch` cannot do, and the file key travels in the form body, never in the
 * URL. The frame keeps an error response from replacing the page.
 */
function postDecryptedDownload(agent: Agent, path: string, fileKey: string) {
    const name = `redoor-vault-download-${crypto.randomUUID()}`;
    const frame = document.createElement("iframe");
    frame.name = name;
    frame.hidden = true;
    document.body.append(frame);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = agent.getVaultDownloadUrl();
    form.target = name;
    form.hidden = true;

    const fields: [string, string][] = [
        ["path", path],
        ["file_key", fileKey],
    ];

    for (const [field, value] of fields) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = field;
        input.value = value;
        form.append(input);
    }

    document.body.append(form);
    form.submit();
    form.remove();
    window.setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
}

/**
 * Starts decrypted downloads of one vault file and owns their error feedback, so the menu
 * that starts one can close without losing the message. The plain "Download" keeps saving
 * the ciphertext. The header is read first, so format and vault errors show here instead of
 * failing silently in the hidden frame.
 */
export function useDecryptedDownload(agent: Agent, path: string) {
    const { vault } = rootRouteApi.useRouteContext();

    const download = useMutation({
        mutationFn: async () => {
            const unlocked = await vault.requestUnlock(
                "Downloading a decrypted copy needs the vault key",
            );

            const header = await agent.vaultHeader(path);

            postDecryptedDownload(
                agent,
                path,
                await fileKeyForHeader(unlocked, header.header),
            );
        },
    });

    const failure =
        download.error && !(download.error instanceof VaultUnlockCancelled)
            ? download.error
            : null;

    return {
        start: () => download.mutate(),
        toast:
            failure === null ? null : (
                <Toast
                    tone="error"
                    icon={<Download className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss download error"
                    onDismiss={() => download.reset()}
                >
                    {vaultErrorMessage(failure, "The download failed")}
                </Toast>
            ),
    };
}

/** The menu entry that starts a decrypted download. */
export function DecryptedDownloadMenuButton(props: { onClick: () => void }) {
    return (
        <ActionMenuButton onClick={props.onClick}>
            <Download className="h-4 w-4 text-slate-400" />
            Download decrypted
        </ActionMenuButton>
    );
}
