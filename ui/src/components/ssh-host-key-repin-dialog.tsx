import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { LoaderCircle, ShieldAlert } from "lucide-react";

import { Button } from "#ui/components/button";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { queryKeys, sshHostKeyQueryOptions } from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";

const rootRouteApi = getRouteApi("__root__");

/**
 * Re-pins a device's SSH host key after a change. Shows both fingerprints so the user decides
 * with the evidence in front of them; nothing is ever re-pinned automatically.
 */
export function SshHostKeyRepinDialog(props: {
    isOpen: boolean;
    agentId: string;
    deviceName: string;
    onClose: () => void;
    onPinned: (fingerprint: string) => void;
}) {
    // Mounting only while open makes every opening probe the device again.
    if (!props.isOpen) {
        return null;
    }

    return (
        <SshHostKeyRepinDialogContent
            agentId={props.agentId}
            deviceName={props.deviceName}
            onClose={props.onClose}
            onPinned={props.onPinned}
        />
    );
}

/** Owns the probe and the pin request for one opening of the re-pin dialog. */
function SshHostKeyRepinDialogContent(props: {
    agentId: string;
    deviceName: string;
    onClose: () => void;
    onPinned: (fingerprint: string) => void;
}) {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const hostKeyQuery = useQuery(sshHostKeyQueryOptions(api, props.agentId));
    const hostKey = hostKeyQuery.data;

    const pinMutation = useMutation({
        mutationFn: (fingerprint: string) =>
            api.pinSshHostKey(props.agentId, {
                host_key_fingerprint: fingerprint,
            }),
        onSuccess: async (result) => {
            await queryClient.invalidateQueries({
                queryKey: queryKeys.agentConfiguration(props.agentId),
            });
            props.onPinned(result.fingerprint);
        },
    });

    const unchanged =
        hostKey !== undefined &&
        hostKey.pinned_fingerprint === hostKey.fingerprint;

    return (
        <Dialog
            isOpen
            title="Re-pin host key"
            description={`Checks the host key ${props.deviceName} presents now against the key pinned for it.`}
            closeAriaLabel="Close host key dialog"
            isBusy={pinMutation.isPending}
            errorMessage={
                pinMutation.isError
                    ? getErrorMessage(
                          pinMutation.error,
                          "Failed to pin the host key",
                      )
                    : hostKeyQuery.isError
                      ? getErrorMessage(
                            hostKeyQuery.error,
                            "Failed to fetch the host key",
                        )
                      : null
            }
            onClose={props.onClose}
        >
            <div className="mt-4 space-y-3 text-sm text-slate-300">
                {hostKeyQuery.isPending ? (
                    <p role="status" className="flex items-center gap-2">
                        <LoaderCircle
                            className="h-4 w-4 animate-spin text-blue-400"
                            aria-hidden="true"
                        />
                        Fetching the device's host key...
                    </p>
                ) : null}
                {hostKey !== undefined && unchanged ? (
                    <>
                        <p role="status">
                            The host key is unchanged. The device still presents
                            the pinned key, so there is nothing to re-pin.
                        </p>
                        <CopyableCodeRow
                            label={`Pinned host key (${hostKey.key_type})`}
                            value={hostKey.fingerprint}
                            copyAriaLabel="Copy pinned host key fingerprint"
                        />
                    </>
                ) : null}
                {hostKey !== undefined && !unchanged ? (
                    <>
                        <p
                            role="alert"
                            className="rounded border border-amber-800 bg-amber-950/30 px-3 py-2 text-amber-300"
                        >
                            The device presents a different host key. Trust it
                            only if you know why it changed, for example after
                            reinstalling the device. Otherwise someone may be
                            impersonating it.
                        </p>
                        <CopyableCodeRow
                            label="Pinned host key"
                            value={hostKey.pinned_fingerprint ?? "None"}
                            copyAriaLabel="Copy pinned host key fingerprint"
                        />
                        <CopyableCodeRow
                            label={`Presented host key (${hostKey.key_type})`}
                            value={hostKey.fingerprint}
                            copyAriaLabel="Copy presented host key fingerprint"
                        />
                    </>
                ) : null}
            </div>
            <DialogActions stackOnMobile>
                <Button
                    type="button"
                    variant="secondary"
                    tooltip="Close without changing the pinned host key"
                    disabled={pinMutation.isPending}
                    onClick={props.onClose}
                >
                    {unchanged ? "Close" : "Cancel"}
                </Button>
                {hostKey !== undefined && !unchanged ? (
                    <Button
                        type="button"
                        variant="warning"
                        tooltip="Replace the pinned host key with the one the device presents now"
                        isLoading={pinMutation.isPending}
                        disabled={pinMutation.isPending}
                        onClick={() => pinMutation.mutate(hostKey.fingerprint)}
                    >
                        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                        {pinMutation.isPending
                            ? "Pinning..."
                            : "Trust new host key"}
                    </Button>
                ) : null}
                {hostKeyQuery.isError ? (
                    <Button
                        type="button"
                        tooltip="Connect to the device again to read its host key"
                        onClick={() => void hostKeyQuery.refetch()}
                    >
                        Try again
                    </Button>
                ) : null}
            </DialogActions>
        </Dialog>
    );
}
