import { ApiClient } from "#ui/api-client";

import { WEB_BASE_URL } from "./helpers";

/**
 * Waits until the agents every spec browses are connected. Each test signs in on its own
 * (see `fixtures.ts`), so no shared session is created here.
 */
export default async function globalSetup(): Promise<void> {
    const apiClient = new ApiClient(WEB_BASE_URL);
    await apiClient.login("test-user", "test-password");
    await apiClient.waitForConnectedAgentNames(
        ["agent1_src", "agent2_custom"],
        120_000,
    );
}
