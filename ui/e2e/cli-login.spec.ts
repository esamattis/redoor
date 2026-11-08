import { z } from "zod";

import type { CliTokenDefaults } from "#bindings/CliTokenDefaults";
import { ApiClient } from "#ui/api-client";
import { expect, test } from "./fixtures";
import { ageSignIn, signInAgain, WEB_BASE_URL } from "./helpers";

/** What the CLI keeps from starting a login; the user code is what it prints. */
const startedSchema = z.object({
    id: z.string(),
    poll_secret: z.string(),
    user_code: z.string(),
    approval_path: z.string(),
});

type StartedCliLogin = z.infer<typeof startedSchema>;

/** One answer of the CLI's long poll. */
const waitAnswerSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({ status: z.literal("denied") }),
    z.object({
        status: z.literal("approved"),
        token: z.string(),
        metadata: z.object({
            id: z.string(),
            name: z.string(),
            permissions: z.array(z.string()),
            devices: z.unknown(),
            expires_at: z.string().nullable(),
        }),
    }),
]);

/** Starts a login the way `redoor remote login` does, without a session. */
async function startCliLogin(
    hostName: string,
    token: CliTokenDefaults,
): Promise<StartedCliLogin> {
    const response = await fetch(`${WEB_BASE_URL}/api/v1/cli-logins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_name: hostName, token }),
    });

    expect(response.status).toBe(200);

    return startedSchema.parse(await response.json());
}

/** Polls the way the CLI does; answers at once when the browser already decided. */
async function waitForAnswer(started: StartedCliLogin) {
    const response = await fetch(
        `${WEB_BASE_URL}/api/v1/cli-logins/${started.id}/wait`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ poll_secret: started.poll_secret }),
        },
    );

    expect(response.status).toBe(200);

    return waitAnswerSchema.parse(await response.json());
}

/** A signed-in API client for cleanup, with a session of its own. */
async function signedInApi(): Promise<ApiClient> {
    const api = new ApiClient(WEB_BASE_URL);
    await api.login("test-user", "test-password");

    return api;
}

test.describe("CLI login approval", () => {
    let cleanups: Array<(api: ApiClient) => Promise<void>> = [];

    test.afterEach(async () => {
        if (cleanups.length === 0) return;

        const api = await signedInApi();

        // Each step tolerates what the test already finished, such as a denied request.
        for (const cleanup of cleanups) {
            await cleanup(api).catch(() => undefined);
        }

        cleanups = [];
        await api.logout();
    });

    /**
     * Denies the request after the test unless it was answered, so a failed test does not
     * hold one of the five pending requests the server allows per address.
     */
    function denyAfterTest(started: StartedCliLogin): void {
        cleanups.push(async (api) => {
            await api.denyCliLogin(started.id);
        });
    }

    test("approves with the CLI's defaults after a fresh sign-in", async ({
        page,
    }) => {
        const suffix = Date.now();
        const tokenName = `Playwright CLI login ${suffix}`;
        const hostName = `playwright-host-${suffix}`;

        const started = await startCliLogin(hostName, {
            name: tokenName,
            permissions: ["files:read"],
            // The CLI names devices as the user typed them; one does not exist here.
            devices: {
                kind: "only",
                device_ids: ["agent1_src", "no-such-device"],
            },
            lifetime: "30d",
        });

        denyAfterTest(started);

        // The CLI prints the approval page as a path on the server it was given.
        expect(started.approval_path).toBe(`/cli-login/${started.id}`);
        await page.goto(`${WEB_BASE_URL}${started.approval_path}`);

        const form = page.getByRole("form", { name: "Approve CLI login" });

        // The page names the machine that asked, so the user can tell it is their own.
        await expect(form.getByLabel("Host", { exact: true })).toHaveText(
            hostName,
        );
        await expect(form.getByRole("note")).toContainText(
            `Only approve if you just ran redoor remote login on ${hostName} yourself`,
        );
        // The form starts from what the CLI asked for.
        await expect(form.getByLabel("Token name")).toHaveValue(tokenName);
        await expect(
            form.getByRole("checkbox", { name: /Read files/ }),
        ).toBeChecked();
        await expect(
            form.getByRole("checkbox", { name: /Write files/ }),
        ).not.toBeChecked();
        await expect(form.getByLabel("Token expiry")).toHaveValue("30d");
        // A device named by the CLI is matched by name ...
        await expect(
            form.getByRole("radio", { name: /Selected devices/ }),
        ).toBeChecked();
        await expect(
            form
                .getByRole("group", { name: "Selected devices" })
                .getByRole("checkbox", { name: "agent1_src", exact: true }),
        ).toBeChecked();
        // ... and one this server does not know is reported instead of silently dropped.
        await expect(form.getByText(/no-such-device/)).toBeVisible();

        await form.getByRole("checkbox", { name: /Write files/ }).click();
        await form.getByLabel("Token expiry").selectOption("90d");

        // The code counts in lower case and without the dash, as typed from a terminal.
        const typedCode = started.user_code.replace("-", "").toLowerCase();

        await form.getByLabel("Code from the terminal").fill(typedCode);

        const approve = form.getByRole("button", { name: "Approve" });

        // Approving hands out a token, so a sign-in older than a minute goes through the
        // login page first.
        await ageSignIn(page);
        await approve.click();
        await signInAgain(page);

        // The form, including the typed code, lives in the URL and survives the round trip.
        await expect(page).toHaveURL(new RegExp(`/cli-login/${started.id}\\?`));
        await expect(form.getByLabel("Token name")).toHaveValue(tokenName);
        await expect(
            form.getByRole("checkbox", { name: /Write files/ }),
        ).toBeChecked();
        await expect(form.getByLabel("Token expiry")).toHaveValue("90d");
        await expect(form.getByLabel("Code from the terminal")).toHaveValue(
            typedCode,
        );
        await approve.click();

        // The page says the CLI is done, since the secret goes to the CLI only.
        await expect(
            page.getByRole("status").filter({
                hasText: "You can close this tab; the CLI has its token.",
            }),
        ).toBeVisible();

        const answer = await waitForAnswer(started);

        if (answer.status !== "approved") {
            throw new Error(
                `The CLI got "${answer.status}" instead of a token`,
            );
        }

        cleanups.push(async (api) => {
            await api.deleteAccessToken(answer.metadata.id);
        });

        const api = await signedInApi();

        const agent1 = (await api.listAgents()).find(
            (agent) => agent.name === "agent1_src",
        );

        await api.logout();

        // The CLI receives a working token with exactly what the form submitted.
        expect(answer.token).toMatch(/^redoor_at_/);
        expect(answer.metadata.name).toBe(tokenName);
        expect(new Set(answer.metadata.permissions)).toEqual(
            new Set(["files:read", "files:write"]),
        );
        expect(answer.metadata.devices).toEqual({
            kind: "only",
            device_ids: [agent1?.id],
        });

        const expiresInDays =
            (Date.parse(answer.metadata.expires_at ?? "") - Date.now()) /
            86_400_000;

        // The changed 90 day expiry was used, not the CLI's 30 days.
        expect(expiresInDays).toBeGreaterThan(89);
        expect(expiresInDays).toBeLessThanOrEqual(90);

        const me = await fetch(`${WEB_BASE_URL}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${answer.token}` },
        });

        // The token the CLI received authenticates as itself.
        expect(me.status).toBe(200);
        expect((await me.json()).name).toBe(tokenName);
    });

    test("denies a request the user does not recognise", async ({ page }) => {
        const hostName = `playwright-deny-${Date.now()}`;

        const started = await startCliLogin(hostName, {
            name: "Unrecognised CLI login",
            permissions: ["files:read"],
            devices: { kind: "all" },
            lifetime: "30d",
        });

        denyAfterTest(started);
        await page.goto(`${WEB_BASE_URL}${started.approval_path}`);

        const form = page.getByRole("form", { name: "Approve CLI login" });

        await expect(form.getByLabel("Host", { exact: true })).toHaveText(
            hostName,
        );
        // Denying needs neither the code nor a fresh sign-in, since it hands out nothing.
        await form.getByRole("button", { name: "Deny" }).click();
        await expect(
            page.getByRole("status").filter({
                hasText: "The CLI was told and stopped waiting.",
            }),
        ).toBeVisible();

        // The waiting CLI learns the request was turned down.
        expect(await waitForAnswer(started)).toEqual({ status: "denied" });
    });
});
