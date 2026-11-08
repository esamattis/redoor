// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    waitFor,
} from "@testing-library/react";
import { expect, onTestFinished, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRouteWithContext,
    createRouter,
    RouterContextProvider,
} from "@tanstack/react-router";

import { ApiClient } from "#ui/api-client";
import type { CurrentUserResponse } from "#bindings/CurrentUserResponse";
import { SessionActivity } from "./session-activity";

/** A signed-in browser session that ends in an hour. */
const CURRENT_USER: CurrentUserResponse = {
    name: "test-user",
    method: "password",
    token_id: null,
    session: {
        expires_at: "2026-11-08T12:00:00Z",
        expires_in_seconds: 3600,
    },
};

/** An API client whose three session requests answer without a server. */
function sessionApi() {
    const client = new ApiClient("http://redoor.test");

    return {
        client,
        getCurrentUser: vi
            .spyOn(client, "getCurrentUser")
            .mockResolvedValue(CURRENT_USER),
        recordSessionActivity: vi
            .spyOn(client, "recordSessionActivity")
            .mockResolvedValue({
                expires_at: "2026-11-08T12:00:00Z",
                expires_in_seconds: 3600,
            }),
        rotateSession: vi
            .spyOn(client, "rotateSession")
            .mockResolvedValue({ rotated: true }),
    };
}

/** Renders the component with real query and router providers around the stubbed API. */
async function renderSessionActivity(api: ReturnType<typeof sessionApi>) {
    const queryClient = new QueryClient();

    const rootRoute = createRootRouteWithContext<{ api: ApiClient }>()();

    const router = createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ["/"] }),
        context: { api: api.client },
    });

    onTestFinished(() => {
        cleanup();
        queryClient.clear();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
    await router.load();

    render(
        <QueryClientProvider client={queryClient}>
            <RouterContextProvider router={router}>
                <SessionActivity />
            </RouterContextProvider>
        </QueryClientProvider>,
    );

    // The component reads the session once on mount.
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalledTimes(1));
}

test("confirms the new cookie right after reporting activity", async () => {
    const api = sessionApi();
    await renderSessionActivity(api);

    fireEvent.pointerDown(document);

    // Activity may rotate the cookie secret ...
    await waitFor(() =>
        expect(api.recordSessionActivity).toHaveBeenCalledOnce(),
    );
    // ... so a request carrying the new cookie follows at once, inside the grace period.
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalledTimes(2));
});

test("rotates an idle tab's cookie every five minutes and confirms it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = sessionApi();
    await renderSessionActivity(api);

    await act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
    // Nothing rotates before the interval is up.
    expect(api.rotateSession).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTime(1));
    // An open tab rotates without any user activity ...
    await waitFor(() => expect(api.rotateSession).toHaveBeenCalledOnce());
    // ... which does not count as activity ...
    expect(api.recordSessionActivity).not.toHaveBeenCalled();
    // ... and is confirmed by a request with the new cookie.
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalledTimes(2));
});
