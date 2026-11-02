import { expect, it, onTestFinished, vi } from "vitest";
import { ApiClient } from "#ui/api-client";

it.each([401, 500])(
    "restores session-expiry handling after logout fails with %i",
    async (status) => {
        const transport = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ error: "Logout failed" }, { status }),
            )
            .mockResolvedValueOnce(
                Response.json({ error: "Session expired" }, { status: 401 }),
            );

        vi.stubGlobal("fetch", transport);
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        const api = new ApiClient("http://redoor.test");
        const expired = vi.fn();
        api.setUnauthorizedHandler(expired);

        // An already expired logout must still redirect, while a server error remains recoverable.
        await expect(api.logout()).rejects.toMatchObject({ status });
        expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
        expired.mockClear();
        // A failed logout cannot permanently suppress expiry handling for later requests.
        await expect(api.getCurrentUser()).rejects.toMatchObject({
            status: 401,
        });
        expect(expired).toHaveBeenCalledOnce();
    },
);

it("restores session-expiry handling when a logged-out client signs in again", async () => {
    const transport = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ logged_out: true }))
        .mockResolvedValueOnce(
            Response.json({ error: "Session expired" }, { status: 401 }),
        )
        .mockResolvedValueOnce(Response.json({ username: "test-user" }))
        .mockResolvedValueOnce(
            Response.json({ error: "Session expired" }, { status: 401 }),
        );

    vi.stubGlobal("fetch", transport);
    onTestFinished(() => {
        vi.unstubAllGlobals();
    });
    const api = new ApiClient("http://redoor.test");
    const expired = vi.fn();
    api.setUnauthorizedHandler(expired);

    await api.logout();
    await expect(api.getCurrentUser()).rejects.toMatchObject({ status: 401 });
    // Delayed background failures cannot replace deliberate logout navigation.
    expect(expired).not.toHaveBeenCalled();
    await api.login("test-user", "test-password");
    await expect(api.getCurrentUser()).rejects.toMatchObject({ status: 401 });
    // Reusing the client for a new session must re-enable the normal expiry redirect.
    expect(expired).toHaveBeenCalledOnce();
});
