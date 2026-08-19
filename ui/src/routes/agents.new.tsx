import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import {
    ManagedAgentForm,
    type ManagedAgentSubmitRequest,
} from "#ui/components/managed-agent-form";
import { agentsQueryOptions } from "#ui/queries";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/new")({
    component: NewManagedAgentPage,
});

/** Persists a new managed local or SSH agent and opens its newly registered tab. */
function NewManagedAgentPage() {
    const { api, queryClient } = Route.useRouteContext();
    const { serverInfo } = RootRoute.useLoaderData();
    const router = useRouter();
    const createMutation = useMutation({
        mutationFn: async (submission: ManagedAgentSubmitRequest) => {
            if (submission.kind === "local") {
                return api.createLocalAgent(submission.request);
            }
            return api.createSshAgent(submission.request);
        },
        onSuccess: async (response) => {
            await queryClient.invalidateQueries(agentsQueryOptions(api));
            await router.invalidate();
            await router.navigate({
                to: "/agents/$agentId",
                params: { agentId: response.agent.id },
            });
        },
    });
    const mutationError = createMutation.isError
        ? createMutation.error instanceof Error
            ? createMutation.error.message
            : "Failed to add managed agent"
        : null;

    return (
        <ManagedAgentForm
            mode="add"
            configPath={serverInfo.config_path}
            isSubmitting={createMutation.isPending}
            mutationError={mutationError}
            onSubmit={(request) => createMutation.mutate(request)}
            onChange={() => createMutation.reset()}
        />
    );
}
