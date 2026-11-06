import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadSystemdRoute } from "#ui/systemd-queries";

export const Route = createFileRoute("/_app/agents/$deviceName/systemd/")({
    /**
     * Opens the manager the agent can actually manage: a root agent manages the system, any
     * other agent only its own user's manager, where its actions work. Replacing the entry
     * keeps Back from landing here and bouncing forward again.
     */
    loader: async ({ context, params, parentMatchPromise }) => {
        const { overview } = await loadSystemdRoute(
            context,
            parentMatchPromise,
        );

        // The layout explains a device that cannot be asked, so there is nothing to open.
        if (overview === null) {
            return;
        }

        if (overview.is_root) {
            throw redirect({
                to: "/agents/$deviceName/systemd/system",
                params: { deviceName: params.deviceName },
                replace: true,
            });
        }

        throw redirect({
            to: "/agents/$deviceName/systemd/user/$user",
            params: { deviceName: params.deviceName, user: overview.username },
            replace: true,
        });
    },
});
