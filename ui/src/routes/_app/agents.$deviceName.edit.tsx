import * as React from "react";
import { deviceRoute } from "#ui/browser-route";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Button } from "#ui/components/button";

import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import {
    ManagedAgentForm,
    type ManagedAgentKind,
    type ManagedAgentSubmitRequest,
} from "#ui/components/managed-agent-form";
import { SshKeySection } from "#ui/components/ssh-key-section";
import { Toast } from "#ui/components/toast";
import {
    agentConfigurationQueryOptions,
    agentsQueryOptions,
    fetchQueryUncancelled,
    loadDeviceRouteAgent,
    queryKeys,
    serverInfoQueryOptions,
} from "#ui/queries";
import { useRouteAgent } from "#ui/use-active-agent";
import { currentSshKeyFileKey } from "#ui/vault/ssh-key-vault";
import { vaultErrorMessage } from "#ui/vault/vault-errors";

export const Route = createFileRoute("/_app/agents/$deviceName/edit")({
    loader: async ({ context, parentMatchPromise }) => {
        const agent = await loadDeviceRouteAgent(context, parentMatchPromise);

        if (!agent.configurationEditable) {
            throw redirect({ to: "/agents" });
        }

        const kind: ManagedAgentKind =
            agent.sshTarget === null ? "local" : "ssh";

        // The form's initial values must reflect the TOML as it is now, not an earlier visit.
        await fetchQueryUncancelled(context.queryClient, {
            ...agentConfigurationQueryOptions(context.api, agent.id, kind),
            staleTime: 0,
        });

        return { kind };
    },
    component: EditManagedAgentPage,
});

/** Updates or permanently removes one stopped managed local or SSH agent. */
function EditManagedAgentPage() {
    const { api, queryClient, vault } = Route.useRouteContext();
    const { kind } = Route.useLoaderData();
    const { data: serverInfo } = useSuspenseQuery(serverInfoQueryOptions(api));
    // The id stays the same across a rename, so this page keeps editing the same device
    // while its URL still carries the old name.
    const agent = useRouteAgent();

    const { data: configuration } = useSuspenseQuery(
        agentConfigurationQueryOptions(api, agent.id, kind),
    );

    const router = useRouter();
    const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

    const [keyLeftBehind, setKeyLeftBehind] = React.useState<string | null>(
        null,
    );

    const isRunning = agent.status !== "stopped";

    /**
     * The file key of the device's encrypted SSH key, so the server can log in with it to
     * remove the key's line from the device; `null` when the device has no encrypted key.
     */
    const sshKeyFileKey = (reason: string) =>
        configuration.kind === "ssh" && configuration.value.has_managed_ssh_key
            ? currentSshKeyFileKey({ api, vault, agentId: agent.id, reason })
            : Promise.resolve(null);

    const updateMutation = useMutation({
        mutationFn: async (submission: ManagedAgentSubmitRequest) => {
            // The edit is about to drop the key; remove its line from the device first, while
            // the key can still log in to do it. The local key is deleted even when the
            // device is unreachable, so the save goes ahead and the user is told instead.
            if (
                submission.kind === "ssh" &&
                submission.sshKey.action === "remove-first"
            ) {
                const fileKey = await sshKeyFileKey(
                    `Remove the SSH key of ${agent.name}`,
                );

                const removal = await api.removeSshKey(
                    agent.id,
                    fileKey === null
                        ? undefined
                        : { current_file_key: fileKey },
                );

                if (!removal.removed_from_device) {
                    setKeyLeftBehind(
                        `The SSH key was deleted from this server, but its line was left in the device's authorized_keys${removal.device_error ? `: ${removal.device_error}` : "."}`,
                    );
                }
            }

            const response =
                submission.kind === "local"
                    ? await api.updateLocalAgent(agent.id, submission.request)
                    : await api.updateSshAgent(agent.id, submission.request);

            await Promise.all([
                queryClient.invalidateQueries(agentsQueryOptions(api)),
                queryClient.invalidateQueries({
                    queryKey: queryKeys.agentConfiguration(agent.id),
                }),
            ]);

            // The URL carries the name, so a rename would leave this tab on a name that no
            // longer exists. Replacing the history entry keeps Back from returning to it.
            if (response.agent.name !== agent.name) {
                await router.navigate({
                    ...deviceRoute(response.agent, "/agents/$deviceName/edit"),
                    replace: true,
                });
            }

            return response;
        },
        // A failed save may follow a successful key removal, so the form must not keep
        // offering a key that no longer exists.
        onError: () =>
            queryClient.invalidateQueries({
                queryKey: queryKeys.agentConfiguration(agent.id),
            }),
    });

    const deleteMutation = useMutation({
        mutationFn: async () => {
            const fileKey = await sshKeyFileKey(`Delete ${agent.name}`);

            return api.deleteManagedAgent(
                agent.id,
                configuration.kind,
                fileKey === null ? undefined : { current_file_key: fileKey },
            );
        },
        onSuccess: async () => {
            // Leave first: once the refreshed inventory drops the device, this page would
            // briefly report it as not found.
            await router.navigate({ to: "/agents" });
            await queryClient.invalidateQueries(agentsQueryOptions(api));
        },
    });

    const mutationError = updateMutation.isError
        ? vaultErrorMessage(updateMutation.error, "Failed to update device")
        : null;

    const isBusy = updateMutation.isPending || deleteMutation.isPending;
    const kindLabel = configuration.kind === "local" ? "local" : "SSH";

    return (
        <>
            <ManagedAgentForm
                key={agent.id}
                mode="edit"
                configuration={configuration}
                beforeForm={
                    configuration.kind === "ssh" ? (
                        <SshKeySection
                            agentId={agent.id}
                            deviceName={agent.name}
                            configuration={configuration.value}
                        />
                    ) : null
                }
                configPath={serverInfo.config_path}
                isSubmitting={updateMutation.isPending}
                isDisabled={isBusy}
                submitLabel={isRunning ? "Stop agent and save" : "Save device"}
                submittingLabel={
                    isRunning ? "Stopping and saving..." : "Saving device..."
                }
                submitDescription={
                    isRunning
                        ? "The agent must stop before its managed configuration can be changed. Saving will stop it automatically."
                        : undefined
                }
                submitTooltip={
                    isBusy
                        ? "Wait for the current save or delete to finish"
                        : isRunning
                          ? "Stop the agent and save the new configuration"
                          : `Save the managed ${kindLabel} configuration`
                }
                mutationError={mutationError}
                onSubmit={(request) => updateMutation.mutate(request)}
                onChange={() => updateMutation.reset()}
            >
                <div className="border-t border-red-950 pt-6">
                    <Button
                        tooltip={
                            isBusy
                                ? "Wait for the current save or delete to finish"
                                : isRunning
                                  ? "Stop the agent and remove this device from Redoor"
                                  : "Remove this device from Redoor"
                        }
                        type="button"
                        variant="danger"
                        onClick={() => setIsDeleteOpen(true)}
                        disabled={isBusy}
                        className="rounded-md disabled:opacity-60"
                    >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Remove device
                    </Button>
                </div>
            </ManagedAgentForm>
            <ConfirmationDialog
                isOpen={isDeleteOpen}
                title={`Remove ${agent.name} from Redoor?`}
                description="Stops its agent and removes the device from the TOML configuration. Files on the device are not deleted."
                confirmLabel="Remove device"
                busyLabel="Removing device..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? vaultErrorMessage(
                              deleteMutation.error,
                              "Failed to remove device",
                          )
                        : null
                }
                onClose={() => {
                    if (!deleteMutation.isPending) setIsDeleteOpen(false);
                }}
                onConfirm={() => deleteMutation.mutate()}
            />
            {keyLeftBehind ? (
                <Toast tone="error" onDismiss={() => setKeyLeftBehind(null)}>
                    {keyLeftBehind}
                </Toast>
            ) : null}
        </>
    );
}
