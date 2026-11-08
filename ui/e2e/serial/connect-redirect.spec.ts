// Serial: adds and removes a local device in the shared device list.
import { expect, test, type APIRequestContext } from "../fixtures";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import { WEB_BASE_URL } from "../helpers";

const RACE_LOCAL_AGENT = `playwright-local-race-${process.pid}`;

/** Finds the device by name because the UI creates it and the test never sees its id. */
async function findAgent(
    request: APIRequestContext,
): Promise<AgentInfoResponse | undefined> {
    const response = await request.get(`${WEB_BASE_URL}/api/v1/agents`);
    expect(response.ok()).toBe(true);
    const body: AgentListResponse = await response.json();

    return body.agents.find((entry) => entry.name === RACE_LOCAL_AGENT);
}

test.describe("Connect redirect", () => {
    // Playwright has no onTestFinished; afterEach is its per-test cleanup hook. The device is
    // removed even when the test fails so later suites do not see it in the inventory.
    test.afterEach(async ({ request }) => {
        const agent = await findAgent(request);

        if (!agent) return;

        if (agent.status !== "stopped") {
            const shutdownResponse = await request.post(
                `${WEB_BASE_URL}/api/v1/agents/${agent.id}/shutdown`,
            );

            // Deleting a local entry requires the agent to be stopped first.
            expect(shutdownResponse.ok()).toBe(true);

            await expect
                .poll(async () => (await findAgent(request))?.status, {
                    timeout: 20_000,
                })
                .toBe("stopped");
        }

        const deleteResponse = await request.delete(
            `${WEB_BASE_URL}/api/v1/local-agents/${agent.id}`,
        );

        // A leftover entry would stay in config.toml for the rest of the run.
        expect(deleteResponse.ok()).toBe(true);
    });

    test("keeps the edit page when the redirect would land after it was chosen", async ({
        page,
    }) => {
        // The redirect to the file browser waits for the device details, and the router keeps
        // the device page rendered while the edit loader fetches the configuration. Holding
        // both responses forces the order that made the redirect replace the edit page.
        let releaseDetails = () => {};

        const detailsReleased = new Promise<void>((resolve) => {
            releaseDetails = resolve;
        });

        let releaseConfiguration = () => {};

        const configurationReleased = new Promise<void>((resolve) => {
            releaseConfiguration = resolve;
        });

        await page.route(/\/api\/v1\/agents\/[^/?]+$/, async (route) => {
            if (route.request().method() !== "GET") return route.fallback();

            await detailsReleased;
            await route.fallback();
        });

        await page.route(
            /\/api\/v1\/local-agents\/[^/]+\/configuration$/,
            async (route) => {
                await configurationReleased;
                await route.fallback();
            },
        );

        await page.goto(`${WEB_BASE_URL}/agents/new`);
        await page.getByRole("radio", { name: "Local process" }).check();
        await page.getByLabel("Device name").fill(RACE_LOCAL_AGENT);
        await page.getByLabel("Home directory").fill("/tmp");
        await page.getByRole("button", { name: "Add device" }).click();
        await page
            .getByRole("button", { name: "Connect", exact: true })
            .click();

        await expect(
            page.getByRole("link", { name: `${RACE_LOCAL_AGENT}, connected` }),
        ).toHaveAttribute("aria-current", "page", { timeout: 30_000 });

        // The details must still be loading so the redirect has not been decided yet.
        await expect(
            page.getByRole("status").filter({
                hasText: "Loading device details...",
            }),
        ).toBeVisible();

        await page
            .getByRole("link", { name: `Edit ${RACE_LOCAL_AGENT}` })
            .click();
        releaseDetails();

        // The details render on the old page while the edit loader is still waiting, which
        // is the moment the redirect used to fire.
        await expect(
            page.getByRole("heading", { name: "Device name" }),
        ).toBeVisible();
        releaseConfiguration();

        // The page the user chose must win over the redirect that arrived after the choice.
        await expect(
            page.getByRole("heading", { name: "Edit device" }),
        ).toBeVisible();
        // The URL must stay on the edit page rather than move on to the file browser.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${RACE_LOCAL_AGENT}/edit$`),
        );
    });
});
