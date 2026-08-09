import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import { WEB_BASE_URL } from "./helpers";

const VALID_AGENT = "lazy_managed";
const FAILING_AGENT = "failing_managed";
const SERVER_LOG = path.resolve("log/playwright-redoor.log");

/** Reads one lifecycle snapshot through the same authenticated API as the UI. */
async function getAgent(
    request: APIRequestContext,
    name: string,
): Promise<AgentInfoResponse> {
    const response = await request.get(`${WEB_BASE_URL}/api/v1/agents`);
    expect(response.ok()).toBe(true);
    const body: AgentListResponse = await response.json();
    const agent = body.agents.find((entry) => entry.name === name);
    if (!agent) throw new Error(`Agent ${name} missing from inventory`);
    return agent;
}

test.describe.serial("Agent management", () => {
    test.afterEach(async ({ request }) => {
        for (const name of [VALID_AGENT, FAILING_AGENT]) {
            const agent = await getAgent(request, name);
            if (agent.status !== "stopped") {
                const response = await request.post(
                    `${WEB_BASE_URL}/api/v1/agents/${name}/shutdown`,
                );
                // Per-test cleanup must leave both managed children stopped for later suites.
                expect(response.ok()).toBe(true);
            }
        }
    });

    test("shows managed inventory before lazy startup", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);
        await expect(
            page.getByRole("heading", { name: "Agents", exact: true }),
        ).toBeVisible();

        const externalOne = page.getByRole("row", { name: "Agent agent1_src" });
        const externalTwo = page.getByRole("row", {
            name: "Agent agent2_custom",
        });
        // Shell-owned external agents remain visible and connected but observation-only.
        await expect(externalOne).toContainText("External", {
            timeout: 30_000,
        });
        await expect(externalOne).toContainText("connected");
        await expect(
            externalOne.getByRole("button", {
                name: "Start",
                exact: true,
            }),
        ).toHaveCount(0);
        await expect(externalTwo).toContainText("connected", {
            timeout: 30_000,
        });

        const valid = page.getByRole("row", { name: `Agent ${VALID_AGENT}` });
        const failing = page.getByRole("row", {
            name: `Agent ${FAILING_AGENT}`,
        });
        // TOML entries are registered as stopped and expose lifecycle controls before processes exist.
        await expect(valid).toContainText("Managed (TOML)");
        await expect(valid).toContainText("stopped");
        await valid
            .getByRole("button", { name: `Open actions for ${VALID_AGENT}` })
            .click();
        await expect(
            page
                .getByRole("dialog", { name: `${VALID_AGENT} actions` })
                .getByRole("button", { name: "Start", exact: true }),
        ).toBeVisible();
        await page
            .getByRole("dialog", { name: `${VALID_AGENT} actions` })
            .getByRole("button", { name: "Close agent actions" })
            .click();
        await expect(failing).toContainText("stopped");

        const log = await fs.readFile(SERVER_LOG, "utf8");
        // Absence of registration proves the valid managed child was not launched at server startup.
        expect(log).not.toContain(`Agent registered: agent_id=${VALID_AGENT}`);
    });

    test("shows optimistic starting state before the start request completes", async ({
        page,
    }) => {
        let releaseStart: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        let markContinued: (() => void) | undefined;
        const continued = new Promise<void>((resolve) => {
            markContinued = resolve;
        });
        await page.route(
            `**/api/v1/agents/${VALID_AGENT}/start`,
            async (route) => {
                await gate;
                await route.continue();
                markContinued?.();
            },
        );
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("tab", { name: `${VALID_AGENT}, stopped` })
            .click();

        // Immediate navigation guarantees users see progress even when local registration is fast.
        await expect(
            page.getByRole("heading", { name: `Starting ${VALID_AGENT}` }),
        ).toBeVisible();
        if (!releaseStart) {
            throw new Error("Start route was not intercepted");
        }
        releaseStart();
        await continued;
        await page.unroute(`**/api/v1/agents/${VALID_AGENT}/start`);

        await expect
            .poll(
                async () => (await getAgent(page.request, VALID_AGENT)).status,
                {
                    timeout: 20_000,
                },
            )
            .toBe("connected");
        // Successful startup redirects to file browsing while preserving the active agent tab.
        await expect(
            page.getByRole("tab", { name: `${VALID_AGENT}, connected` }),
        ).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    });

    test("shuts down and restarts from the management row", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);
        const row = page.getByRole("row", { name: `Agent ${VALID_AGENT}` });
        await row
            .getByRole("button", { name: `Open actions for ${VALID_AGENT}` })
            .click();
        await page
            .getByRole("dialog", { name: `${VALID_AGENT} actions` })
            .getByRole("button", { name: "Start", exact: true })
            .click();
        await expect
            .poll(
                async () => (await getAgent(page.request, VALID_AGENT)).status,
                { timeout: 20_000 },
            )
            .toBe("connected");
        await row
            .getByRole("button", { name: `Open actions for ${VALID_AGENT}` })
            .click();
        await page
            .getByRole("dialog", { name: `${VALID_AGENT} actions` })
            .getByRole("button", { name: "Shutdown" })
            .click();
        const dialog = page.getByRole("dialog", {
            name: `Shut down ${VALID_AGENT}?`,
        });
        await dialog
            .getByRole("button", { name: "Shutdown", exact: true })
            .click();

        // Shutdown retains the row and switches duration into server-observed last-seen recency.
        await expect(row).toContainText("stopped", { timeout: 15_000 });
        await expect(row).toContainText(/Last seen .* ago/);
        await row
            .getByRole("button", { name: `Open actions for ${VALID_AGENT}` })
            .click();
        await page
            .getByRole("dialog", { name: `${VALID_AGENT} actions` })
            .getByRole("button", { name: "Start", exact: true })
            .click();
        await expect
            .poll(
                async () => (await getAgent(page.request, VALID_AGENT)).status,
                {
                    timeout: 20_000,
                },
            )
            .toBe("connected");
        // Restart returns the same stable managed id to connected state.
        await expect(row).toContainText("connected");
    });

    test("surfaces failing managed connection issues without blocking the UI", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);
        const row = page.getByRole("row", { name: `Agent ${FAILING_AGENT}` });
        await row
            .getByRole("button", { name: `Open actions for ${FAILING_AGENT}` })
            .click();
        await page
            .getByRole("dialog", { name: `${FAILING_AGENT} actions` })
            .getByRole("button", { name: "Start", exact: true })
            .click();

        await expect
            .poll(
                async () =>
                    (await getAgent(page.request, FAILING_AGENT))
                        .connection_issue,
                {
                    timeout: 20_000,
                },
            )
            .not.toBeNull();
        // The actionable supervisor issue remains inline while desired-running retries continue.
        await expect(row.getByRole("alert")).not.toBeEmpty();
        // An unrelated navigation remains responsive while the failing child cycles.
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("link", { name: "Server home" }).click();
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
    });
});
