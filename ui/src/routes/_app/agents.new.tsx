import * as React from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { deviceRoute } from "#ui/browser-route";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import { ManagedAgentForm } from "#ui/components/managed-agent-form";
import type { ManagedAgentSubmitRequest } from "#ui/components/managed-agent-form";
import { SshKeySetupDialog } from "#ui/components/ssh-key-setup-dialog";
import { agentsQueryOptions, serverInfoQueryOptions } from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";

export const Route = createFileRoute("/_app/agents/new")({
    component: NewManagedAgentPage,
});

/**
 * A just-created SSH device waiting for its dedicated key. The typed password lives only
 * here, in memory, until the key setup dialog sends it once; it never enters the config.
 */
type PendingKeySetup = { agent: AgentInfoResponse; password: string | null };

/** Persists a new managed local or SSH agent and opens its newly registered tab. */
function NewManagedAgentPage() {
    const { api, queryClient } = Route.useRouteContext();
    const { data: serverInfo } = useSuspenseQuery(serverInfoQueryOptions(api));
    const router = useRouter();

    const [pendingKeySetup, setPendingKeySetup] =
        React.useState<PendingKeySetup | null>(null);

    /** Opens the new device's page, where it can be connected. */
    const openDevice = (agent: AgentInfoResponse) =>
        router.navigate({
            ...deviceRoute(agent, "/agents/$deviceName"),
        });

    const createMutation = useMutation({
        mutationFn: async (submission: ManagedAgentSubmitRequest) => {
            const response =
                submission.kind === "local"
                    ? await api.createLocalAgent(submission.request)
                    : await api.createSshAgent(submission.request);

            return { response, submission };
        },
        onSuccess: async (result) => {
            await queryClient.invalidateQueries(agentsQueryOptions(api));

            if (
                result.submission.kind === "ssh" &&
                result.submission.sshKey.action === "enroll"
            ) {
                // The device exists now; the key is set up in a second step so the user
                // confirms the host key before the password is sent anywhere.
                setPendingKeySetup({
                    agent: result.response.agent,
                    password: result.submission.sshKey.password,
                });

                return;
            }

            await openDevice(result.response.agent);
        },
    });

    const mutationError = createMutation.isError
        ? getErrorMessage(createMutation.error, "Failed to add device")
        : null;

    return (
        <>
            <ManagedAgentForm
                mode="add"
                configPath={serverInfo.config_path}
                isSubmitting={createMutation.isPending}
                isDisabled={pendingKeySetup !== null}
                mutationError={mutationError}
                onSubmit={(request) => createMutation.mutate(request)}
                onChange={() => createMutation.reset()}
            />
            {pendingKeySetup ? (
                <SshKeySetupDialog
                    isOpen
                    agentId={pendingKeySetup.agent.id}
                    deviceName={pendingKeySetup.agent.name}
                    mode="setup"
                    hasPinnedHostKey={false}
                    initialPassword={pendingKeySetup.password ?? undefined}
                    doneLabel="Open device"
                    onClose={() => {
                        // The device was added either way. A cancelled or failed setup can
                        // be retried from the device's configuration page.
                        const agent = pendingKeySetup.agent;
                        setPendingKeySetup(null);
                        void openDevice(agent);
                    }}
                />
            ) : null}
        </>
    );
}
