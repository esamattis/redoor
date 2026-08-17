import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Button } from "#ui/components/button";

import type { CreateSshAgentRequest } from "#ui/api-client";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { ManagedAgentForm } from "#ui/components/managed-agent-form";
import { Tooltip } from "#ui/components/tooltip";
import { agentsQueryOptions } from "#ui/queries";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/$agentId/edit")({
    loader: async ({ context, params, parentMatchPromise }) => {
        const parentMatch = await parentMatchPromise;
        if (!parentMatch.loaderData) {
            throw redirect({ to: "/agents" });
        }
        const agent = parentMatch.loaderData.agent;
        if (!agent?.configurationEditable) {
            throw redirect({ to: "/agents" });
        }
        return {
            configuration: await context.api.getSshAgentConfiguration(
                params.agentId,
            ),
        };
    },
    component: EditManagedAgentPage,
});

/** Updates or permanently removes one stopped managed SSH agent. */
function EditManagedAgentPage() {
    const { api, queryClient } = Route.useRouteContext();
    const { agentId } = Route.useParams();
    const { configuration } = Route.useLoaderData();
    const { agents, serverInfo } = RootRoute.useLoaderData();
    const agent = agents.find((entry) => entry.id === agentId);
    const router = useRouter();
    const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);
    const isRunning = agent?.status !== "stopped";
    const updateMutation = useMutation({
        mutationFn: (request: CreateSshAgentRequest) =>
            api.updateSshAgent(agentId, request),
        onSuccess: async (response) => {
            await queryClient.invalidateQueries(agentsQueryOptions(api));
            await router.invalidate();
            await router.navigate({
                to: "/agents/$agentId/edit",
                params: { agentId: response.agent.id },
            });
        },
    });
    const deleteMutation = useMutation({
        mutationFn: () => api.deleteManagedAgent(agentId),
        onSuccess: async () => {
            await queryClient.invalidateQueries(agentsQueryOptions(api));
            await router.invalidate();
            await router.navigate({ to: "/agents" });
        },
    });
    const mutationError = updateMutation.isError
        ? updateMutation.error instanceof Error
            ? updateMutation.error.message
            : "Failed to update managed agent"
        : null;
    const isBusy = updateMutation.isPending || deleteMutation.isPending;
    return (
        <>
            <ManagedAgentForm
                key={agentId}
                mode="edit"
                configuration={configuration}
                configPath={serverInfo.config_path}
                isSubmitting={updateMutation.isPending}
                isDisabled={isBusy}
                submitLabel={isRunning ? "Stop and Save" : "Save managed agent"}
                submittingLabel={
                    isRunning ? "Stopping and saving..." : "Saving agent..."
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
                          : "Save the managed SSH configuration"
                }
                mutationError={mutationError}
                onSubmit={(request) => updateMutation.mutate(request)}
                onChange={() => updateMutation.reset()}
            >
                <div className="border-t border-red-950 pt-6">
                    <Tooltip
                        content={
                            isBusy
                                ? "Wait for the current save or delete to finish"
                                : isRunning
                                  ? "Stop the agent if it is running, then permanently delete it"
                                  : "Permanently delete this managed agent"
                        }
                    >
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => setIsDeleteOpen(true)}
                            disabled={isBusy}
                            className="rounded-md disabled:opacity-60"
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Delete managed agent
                        </Button>
                    </Tooltip>
                </div>
            </ManagedAgentForm>
            <ConfirmationDialog
                isOpen={isDeleteOpen}
                title={`Delete ${agentId}?`}
                description="This stops the agent if it is running, then permanently removes the managed entry from the TOML configuration."
                confirmLabel="Delete managed agent"
                busyLabel="Deleting agent..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? deleteMutation.error instanceof Error
                            ? deleteMutation.error.message
                            : "Failed to delete managed agent"
                        : null
                }
                onClose={() => {
                    if (!deleteMutation.isPending) setIsDeleteOpen(false);
                }}
                onConfirm={() => deleteMutation.mutate()}
            />
        </>
    );
}
