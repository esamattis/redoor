// Serial: adds and removes a local device in the shared device list.
import { expect, test, type APIRequestContext } from "../fixtures";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { CreateLocalAgentResponse } from "#bindings/CreateLocalAgentResponse";
import type { ManagedLocalAgentConfigurationResponse } from "#bindings/ManagedLocalAgentConfigurationResponse";
import { WEB_BASE_URL } from "../helpers";

const ENV_LOCAL_AGENT = `playwright-terminal-env-${process.pid}`;

/** Finds the test device, or `undefined` once it is gone. */
async function findAgent(
    request: APIRequestContext,
): Promise<AgentInfoResponse | undefined> {
    const response = await request.get(`${WEB_BASE_URL}/api/v1/agents`);
    expect(response.ok()).toBe(true);
    const body: AgentListResponse = await response.json();

    return body.agents.find((entry) => entry.name === ENV_LOCAL_AGENT);
}

/** Reads the saved variables back from the server, not from the page. */
async function savedEnv(
    request: APIRequestContext,
    agentId: string,
): Promise<{ [name in string]?: string }> {
    const response = await request.get(
        `${WEB_BASE_URL}/api/v1/local-agents/${agentId}/configuration`,
    );

    expect(response.ok()).toBe(true);
    const body: ManagedLocalAgentConfigurationResponse = await response.json();

    return body.terminal_env;
}

test.describe("Terminal environment", () => {
    // Playwright has no onTestFinished; afterEach is its per-test cleanup hook. The device is
    // removed even when the test fails so later suites do not see it in the inventory.
    test.afterEach(async ({ request }) => {
        const agent = await findAgent(request);

        if (!agent) return;

        const deleteResponse = await request.delete(
            `${WEB_BASE_URL}/api/v1/local-agents/${agent.id}`,
        );

        // A leftover entry would stay in config.toml for the rest of the run.
        expect(deleteResponse.ok()).toBe(true);
    });

    test("adds, saves and removes a terminal variable on the edit page", async ({
        page,
    }) => {
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/local-agents`,
            { data: { name: ENV_LOCAL_AGENT, home: "/tmp" } },
        );

        expect(createResponse.ok()).toBe(true);
        const { agent }: CreateLocalAgentResponse = await createResponse.json();

        await page.goto(`${WEB_BASE_URL}/agents/${ENV_LOCAL_AGENT}/edit`);

        const section = page.getByRole("region", {
            name: "Terminal environment",
        });

        // A new device starts without variables of its own.
        await expect(section.getByText("No variables yet.")).toBeVisible();

        await section.getByRole("button", { name: "Add variable" }).click();
        await section.getByLabel("Name of variable 1").fill("EDITOR");
        await section.getByLabel("Value of variable 1").fill("vim -u NONE");

        const saved = page.waitForResponse(
            (response) =>
                response.url().endsWith(`/agents/${agent.id}/terminal-env`) &&
                response.request().method() === "PUT",
        );

        await section.getByRole("button", { name: "Save variables" }).click();
        // The write must succeed before the reload, which would otherwise abort it.
        expect((await saved).ok()).toBe(true);
        // The server stored exactly what was typed.
        expect(await savedEnv(page.request, agent.id)).toEqual({
            EDITOR: "vim -u NONE",
        });

        await page.reload();

        const reloaded = page.getByRole("region", {
            name: "Terminal environment",
        });

        // The edit page shows the saved variable again after a reload.
        await expect(reloaded.getByLabel("Name of variable 1")).toHaveValue(
            "EDITOR",
        );
        await expect(reloaded.getByLabel("Value of variable 1")).toHaveValue(
            "vim -u NONE",
        );

        await reloaded
            .getByRole("button", { name: "Remove variable 1" })
            .click();

        const cleared = page.waitForResponse(
            (response) =>
                response.url().endsWith(`/agents/${agent.id}/terminal-env`) &&
                response.request().method() === "PUT",
        );

        await reloaded.getByRole("button", { name: "Save variables" }).click();
        expect((await cleared).ok()).toBe(true);
        // Removing the row and saving deletes the variable on the server.
        expect(await savedEnv(page.request, agent.id)).toEqual({});
    });

    test("refuses a duplicate name before saving", async ({ page }) => {
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/local-agents`,
            { data: { name: ENV_LOCAL_AGENT, home: "/tmp" } },
        );

        expect(createResponse.ok()).toBe(true);

        await page.goto(`${WEB_BASE_URL}/agents/${ENV_LOCAL_AGENT}/edit`);

        const section = page.getByRole("region", {
            name: "Terminal environment",
        });

        await expect(section.getByText("No variables yet.")).toBeVisible();
        await section.getByRole("button", { name: "Add variable" }).click();
        await section.getByRole("button", { name: "Add variable" }).click();
        await section.getByLabel("Name of variable 1").fill("A");
        await section.getByLabel("Name of variable 2").fill("A");
        await section.getByRole("button", { name: "Save variables" }).click();

        // A map keeps only one value per name, so the form says which name repeats.
        await expect(section.getByRole("alert")).toHaveText(
            "A is listed more than once.",
        );
    });
});
