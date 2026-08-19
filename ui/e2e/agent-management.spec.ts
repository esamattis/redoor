import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import { WEB_BASE_URL } from "./helpers";

const VALID_AGENT = "lazy_managed";
const FAILING_AGENT = "failing_managed";
const CREATED_SSH_AGENT = `playwright-ssh-test-${process.pid}`;
const CREATED_SSH_PASSWORD_AGENT = `playwright-ssh-password-${process.pid}`;
const CREATED_SSH_MISSING_PASSWORD_AGENT = `playwright-ssh-missing-password-${process.pid}`;
const CREATED_SSH_MODE_SWITCH_AGENT = `playwright-ssh-mode-switch-${process.pid}`;
const CREATED_SSH_PASSWORD_CHANGE_AGENT = `playwright-ssh-password-change-${process.pid}`;
const CREATED_LOCAL_AGENT = `playwright-local-${process.pid}`;
const EDITED_LOCAL_AGENT = `playwright-local-edit-${process.pid}`;
const EDITED_AGENT = `playwright-edit-${process.pid}`;
const RUNNING_EDIT_AGENT = `playwright-running-edit-${process.pid}`;
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
        for (const name of [
            VALID_AGENT,
            FAILING_AGENT,
            CREATED_SSH_AGENT,
            CREATED_SSH_PASSWORD_AGENT,
            CREATED_SSH_MISSING_PASSWORD_AGENT,
            CREATED_SSH_MODE_SWITCH_AGENT,
            CREATED_SSH_PASSWORD_CHANGE_AGENT,
            CREATED_LOCAL_AGENT,
            EDITED_LOCAL_AGENT,
            EDITED_AGENT,
            `${EDITED_AGENT}-original`,
            RUNNING_EDIT_AGENT,
            `${RUNNING_EDIT_AGENT}-original`,
        ]) {
            const response = await request.get(`${WEB_BASE_URL}/api/v1/agents`);
            const body: AgentListResponse = await response.json();
            const agent = body.agents.find((entry) => entry.name === name);
            if (!agent) continue;
            if (agent.status !== "stopped") {
                const shutdownResponse = await request.post(
                    `${WEB_BASE_URL}/api/v1/agents/${name}/shutdown`,
                );
                // Per-test cleanup must leave both managed children stopped for later suites.
                expect(shutdownResponse.ok()).toBe(true);
                await expect
                    .poll(async () => (await getAgent(request, name)).status, {
                        timeout: 20_000,
                    })
                    .toBe("stopped");
            }
        }
    });

    test("marks SSH target required and describes plaintext password storage", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/new`);
        await expect(page.getByLabel("SSH target")).toHaveAttribute(
            "aria-required",
            "true",
        );
        await expect(page.getByText("Required", { exact: true })).toBeVisible();
        await expect(
            page.getByText(
                "Password authentication stores the secret as plaintext in config.toml. Key mode uses a preconfigured SSH key or ssh-agent.",
            ),
        ).toBeVisible();
        await expect(
            page.getByRole("radio", { name: "Use preconfigured ssh key" }),
        ).toBeChecked();
        // Add defaults to key mode so a blank password cannot be saved as an empty secret.
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeDisabled();
    });

    test("reveals the SSH password with the visibility toggle", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/new`);
        await page.getByRole("radio", { name: "Use ssh password" }).check();
        const password = page.getByLabel("SSH password", { exact: true });
        await password.fill("secret-value");
        // The typed secret must stay masked until the operator asks to inspect it.
        await expect(password).toHaveAttribute("type", "password");
        const toggle = page.getByRole("button", { name: "Show characters" });
        await toggle.hover();
        await expect(page.getByRole("tooltip")).toHaveText("Show characters");
        await toggle.click();
        // Operators need to verify the secret before it is stored in config.toml.
        await expect(password).toHaveAttribute("type", "text");
        await expect(password).toHaveValue("secret-value");
        await page.getByRole("button", { name: "Hide characters" }).click();
        await expect(password).toHaveAttribute("type", "password");
    });

    test("adds, edits, and deletes a local managed agent", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/new`);
        await page.getByRole("radio", { name: "Local process" }).check();
        // Switching kinds must hide SSH-only fields so a local save cannot mix transports.
        await expect(page.getByLabel("SSH target")).toHaveCount(0);
        await page.getByLabel("Agent name").fill(CREATED_LOCAL_AGENT);
        await page.getByLabel("Home directory").fill("/tmp");
        await page.getByRole("button", { name: "Add managed agent" }).click();

        // Submission dynamically adds and opens the managed tab without a server restart.
        await expect(
            page.getByRole("link", {
                name: new RegExp(`^${CREATED_LOCAL_AGENT}, `),
            }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.getByRole("link", {
                name: `${CREATED_LOCAL_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 30_000 });

        await page
            .getByRole("link", { name: `Edit ${CREATED_LOCAL_AGENT}` })
            .click();
        await expect(
            page.getByRole("heading", { name: "Edit managed agent" }),
        ).toBeVisible();
        // Edit must not offer SSH↔local conversion.
        await expect(
            page.getByRole("radio", { name: "Local process" }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Agent name")).toHaveValue(
            CREATED_LOCAL_AGENT,
        );
        await page.getByLabel("Agent name").fill(EDITED_LOCAL_AGENT);
        await page.getByRole("button", { name: "Stop and Save" }).click();

        // Renaming replaces the tab identity and keeps the user on the editable entry.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${EDITED_LOCAL_AGENT}/edit$`),
        );
        await expect(
            page.getByRole("link", { name: `Edit ${EDITED_LOCAL_AGENT}` }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Delete managed agent" })
            .click();
        const confirmation = page.getByRole("dialog", {
            name: `Delete ${EDITED_LOCAL_AGENT}?`,
        });
        await confirmation
            .getByRole("button", { name: "Delete managed agent" })
            .click();

        await expect(page).toHaveURL(/\/agents\/?$/);
        // Permanent deletion must remove the managed tab as well as the TOML entry.
        await expect(
            page.getByRole("link", { name: `Edit ${EDITED_LOCAL_AGENT}` }),
        ).toHaveCount(0);
    });

    test("opens the edit form from the agents table", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);
        const valid = page.getByRole("row", { name: `Agent ${VALID_AGENT}` });
        await valid
            .getByRole("button", { name: `Open actions for ${VALID_AGENT}` })
            .click();
        await page
            .getByRole("dialog", { name: `${VALID_AGENT} actions` })
            .getByRole("link", { name: "Edit" })
            .click();
        // Table actions must reach the same edit form as the sidebar pencil.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${VALID_AGENT}/edit$`),
        );
        await expect(
            page.getByRole("heading", { name: "Edit managed agent" }),
        ).toBeVisible();
        await expect(page.getByLabel("Agent name")).toHaveValue(VALID_AGENT);
    });

    test("edits and deletes a managed SSH entry from its tab", async ({
        page,
    }) => {
        const originalName = `${EDITED_AGENT}-original`;
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "edit-original-host",
                    username: null,
                    ssh_port: null,
                    name: originalName,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password: null,
                },
            },
        );
        expect(createResponse.ok()).toBe(true);
        await page.goto(`${WEB_BASE_URL}/`);
        await page.getByRole("link", { name: `Edit ${originalName}` }).click();

        await expect(
            page.getByRole("heading", { name: "Edit managed agent" }),
        ).toBeVisible();
        const configurationTab = page
            .getByLabel("Agent view")
            .getByRole("link", { name: "Configuration", exact: true });
        // Editable managed agents expose their form in global navigation, including while stopped.
        await expect(configurationTab).toHaveAttribute("aria-current", "page");
        await expect(
            page.getByText("Agent configuration will be saved to"),
        ).toBeVisible();
        // The footer must show the server's absolute TOML path rather than a relative hint.
        await expect(
            page.locator("code").filter({ hasText: /^\// }),
        ).toBeVisible();
        await page.getByLabel("SSH target").fill("edit-updated-host");
        await page.getByLabel("Agent name").fill(EDITED_AGENT);
        await page.getByRole("button", { name: "Save managed agent" }).click();

        // Renaming replaces the tab identity and keeps the user on the editable entry.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${EDITED_AGENT}/edit$`),
        );
        await expect(
            page.getByRole("link", { name: `Edit ${EDITED_AGENT}` }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Delete managed agent" })
            .click();
        const confirmation = page.getByRole("dialog", {
            name: `Delete ${EDITED_AGENT}?`,
        });
        await confirmation
            .getByRole("button", { name: "Delete managed agent" })
            .click();

        await expect(page).toHaveURL(/\/agents\/?$/);
        // Permanent deletion must remove the managed tab as well as the TOML entry.
        await expect(
            page.getByRole("link", { name: `Edit ${EDITED_AGENT}` }),
        ).toHaveCount(0);
    });

    test("adds and connects an SSH-backed agent through redoor-ssh-test", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1",
            "redoor-ssh-test SSH fixture is not enabled",
        );
        await page.goto(`${WEB_BASE_URL}/`);
        await page.getByRole("link", { name: "Add managed agent" }).click();

        // The trailing add control must navigate to a dedicated, labeled form route.
        await expect(page).toHaveURL(/\/agents\/new$/);
        await expect(
            page.getByRole("heading", { name: "Add managed agent" }),
        ).toBeVisible();
        await page.getByLabel("SSH target").fill("redoor-ssh-test");
        await page.getByLabel("SSH username").fill("redoor");
        await page.getByLabel("Agent name").fill(CREATED_SSH_AGENT);
        await page
            .getByRole("radio", { name: "Use preconfigured ssh key" })
            .check();
        // Key mode must disable the password field so create cannot persist a leftover secret.
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Add managed agent" }).click();

        // Submission dynamically adds and opens the managed tab without a server restart.
        await expect(
            page.getByRole("link", {
                name: new RegExp(`^${CREATED_SSH_AGENT}, `),
            }),
        ).toBeVisible({ timeout: 15_000 });

        // The starting screen must show sticky SSH steps instead of a generic loading sentence.
        await expect(
            page.getByRole("heading", {
                name: `Starting ${CREATED_SSH_AGENT}`,
            }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.getByRole("list", { name: "Provisioning status" }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Sniffing the SSH target")).toBeVisible();
        await expect(page.getByText(/Sniff results:/)).toBeVisible({
            timeout: 30_000,
        });
        // Two rows prove later steps stay sticky instead of replacing the first.
        await expect(
            page
                .getByRole("list", { name: "Provisioning status" })
                .getByRole("listitem")
                .nth(1),
        ).toBeVisible();
        await expect(page.getByLabel(/from start/).nth(1)).toBeVisible();

        // A connected tab proves the form-created config can prepare and run as redoor.
        await expect(
            page.getByRole("link", {
                name: `${CREATED_SSH_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
        const connected = await getAgent(page.request, CREATED_SSH_AGENT);
        expect(connected.managed).toBe(true);
        expect(connected.connection_id).not.toBeNull();

        // The home card must keep the last start steps after the lifecycle page unmounts.
        await page.goto(`${WEB_BASE_URL}/agents/${CREATED_SSH_AGENT}`);
        await expect(
            page.getByRole("heading", { name: "provisioning history" }),
        ).toBeVisible();
        await expect(
            page.getByRole("list", { name: "Provisioning status" }),
        ).toBeVisible();
        await expect(page.getByText("Sniffing the SSH target")).toBeVisible();
        await expect(page.getByText(/Sniff results:/)).toBeVisible();
    });

    test("stops a running agent before renaming and accessing it again", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1",
            "redoor-ssh-test SSH fixture is not enabled",
        );
        const originalName = `${RUNNING_EDIT_AGENT}-original`;
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "redoor-ssh-test",
                    username: "redoor",
                    ssh_port: null,
                    name: originalName,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password: null,
                },
            },
        );
        expect(createResponse.ok()).toBe(true);
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("link", { name: `${originalName}, stopped` })
            .click();
        await expect(
            page.getByRole("link", { name: `${originalName}, connected` }),
        ).toBeVisible({ timeout: 60_000 });
        await page.getByRole("link", { name: `Edit ${originalName}` }).click();

        const saveButton = page.getByRole("button", { name: "Stop and Save" });
        const deleteButton = page.getByRole("button", {
            name: "Delete managed agent",
        });
        // The single submit action explains and owns the required shutdown before persistence.
        await expect(saveButton).toBeEnabled();
        // Delete uses the same auto-stop API, so a running agent must remain removable.
        await expect(deleteButton).toBeEnabled();
        await expect(
            page.getByText(
                "The agent must stop before its managed configuration can be changed. Saving will stop it automatically.",
            ),
        ).toBeVisible();
        await page.getByLabel("Agent name").fill(RUNNING_EDIT_AGENT);
        await saveButton.click();

        await expect(page).toHaveURL(
            new RegExp(`/agents/${RUNNING_EDIT_AGENT}/edit$`),
        );
        await page
            .getByRole("link", { name: `${RUNNING_EDIT_AGENT}, stopped` })
            .click();
        // Starting the renamed tab proves the edited configuration remains operational.
        await expect(
            page.getByRole("link", {
                name: `${RUNNING_EDIT_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    });

    test("adds and connects an SSH agent with password auth", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1" ||
                !process.env.REDOOR_SSH_TEST_PASSWORD,
            "redoor-ssh-test password fixture is not enabled",
        );
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;
        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }
        await page.goto(`${WEB_BASE_URL}/`);
        await page.getByRole("link", { name: "Add managed agent" }).click();

        await page.getByLabel("SSH target").fill("redoor-ssh-test");
        await page.getByLabel("SSH username").fill("redoor-password");
        await page.getByLabel("Agent name").fill(CREATED_SSH_PASSWORD_AGENT);
        await page.getByRole("radio", { name: "Use ssh password" }).check();
        // Password mode must enable the field before a secret can be typed.
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeEnabled();
        await page.getByLabel("SSH password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Add managed agent" }).click();

        // Password auth must prepare and connect without a TTY or ssh-agent key.
        await expect(
            page.getByRole("link", {
                name: `${CREATED_SSH_PASSWORD_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
        const connected = await getAgent(
            page.request,
            CREATED_SSH_PASSWORD_AGENT,
        );
        expect(connected.managed).toBe(true);
        expect(connected.connection_id).not.toBeNull();
    });

    test("switches an existing agent from password auth to key auth", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1" ||
                !process.env.REDOOR_SSH_TEST_PASSWORD,
            "redoor-ssh-test password fixture is not enabled",
        );
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;
        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }
        await page.goto(`${WEB_BASE_URL}/`);
        await page.getByRole("link", { name: "Add managed agent" }).click();
        await page.getByLabel("SSH target").fill("redoor-ssh-test");
        await page.getByLabel("SSH username").fill("redoor-password");
        await page.getByLabel("Agent name").fill(CREATED_SSH_MODE_SWITCH_AGENT);
        await page.getByRole("radio", { name: "Use ssh password" }).check();
        await page.getByLabel("SSH password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Add managed agent" }).click();
        await expect(
            page.getByRole("link", {
                name: `${CREATED_SSH_MODE_SWITCH_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });

        await page
            .getByRole("link", {
                name: `Edit ${CREATED_SSH_MODE_SWITCH_AGENT}`,
            })
            .click();
        await expect(
            page.getByRole("radio", { name: "Use ssh password" }),
        ).toBeChecked();
        await page
            .getByRole("radio", { name: "Use preconfigured ssh key" })
            .check();
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeDisabled();
        await page.getByLabel("SSH username").fill("redoor");
        const updateUrl = `${WEB_BASE_URL}/api/v1/agents/${encodeURIComponent(CREATED_SSH_MODE_SWITCH_AGENT)}`;
        const [updateResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url() === updateUrl &&
                    response.request().method() === "PUT",
            ),
            page.getByRole("button", { name: "Stop and Save" }).click(),
        ]);
        // The same-url navigation cannot serve as a persistence barrier.
        expect(updateResponse.ok()).toBe(true);
        expect(updateResponse.request().postDataJSON()).toMatchObject({
            clear_password: true,
        });
        await expect(page).toHaveURL(
            new RegExp(`/agents/${CREATED_SSH_MODE_SWITCH_AGENT}/edit$`),
        );

        const configuration = await page.request.get(
            `${WEB_BASE_URL}/api/v1/agents/${CREATED_SSH_MODE_SWITCH_AGENT}/configuration`,
        );
        expect(configuration.ok()).toBe(true);
        const body: ManagedSshAgentConfigurationResponse =
            await configuration.json();
        // Switching to key mode must drop the stored secret without echoing it.
        expect(body.has_password).toBe(false);
        expect(body.password).toBeNull();

        await page
            .getByRole("link", {
                name: `${CREATED_SSH_MODE_SWITCH_AGENT}, stopped`,
            })
            .click();
        // Live auth must now succeed as the key user after the password is removed.
        await expect(
            page.getByRole("link", {
                name: `${CREATED_SSH_MODE_SWITCH_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
        await page
            .getByRole("link", {
                name: `Edit ${CREATED_SSH_MODE_SWITCH_AGENT}`,
            })
            .click();
        await expect(
            page.getByRole("radio", { name: "Use preconfigured ssh key" }),
        ).toBeChecked();
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeDisabled();
    });

    test("replaces a wrong SSH password on an existing agent", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1" ||
                !process.env.REDOOR_SSH_TEST_PASSWORD,
            "redoor-ssh-test password fixture is not enabled",
        );
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;
        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "redoor-ssh-test",
                    username: "redoor-password",
                    ssh_port: null,
                    name: CREATED_SSH_PASSWORD_CHANGE_AGENT,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password: `wrong-${process.pid}-password`,
                    clear_password: false,
                },
            },
        );
        expect(createResponse.ok()).toBe(true);
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("link", {
                name: `Edit ${CREATED_SSH_PASSWORD_CHANGE_AGENT}`,
            })
            .click();
        await expect(
            page.getByRole("radio", { name: "Use ssh password" }),
        ).toBeChecked();
        await expect(
            page.getByLabel("SSH password", { exact: true }),
        ).toBeEnabled();
        await page.getByLabel("SSH password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Save managed agent" }).click();
        await expect(page).toHaveURL(
            new RegExp(`/agents/${CREATED_SSH_PASSWORD_CHANGE_AGENT}/edit$`),
        );

        await page
            .getByRole("link", {
                name: `${CREATED_SSH_PASSWORD_CHANGE_AGENT}, stopped`,
            })
            .click();
        // The corrected secret must authenticate as redoor-password after the edit.
        await expect(
            page.getByRole("link", {
                name: `${CREATED_SSH_PASSWORD_CHANGE_AGENT}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    });

    test("shows an actionable error when SSH needs an omitted password", async ({
        page,
    }) => {
        test.skip(
            process.env.REDOOR_SSH_TEST !== "1",
            "redoor-ssh-test SSH fixture is not enabled",
        );
        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "redoor-ssh-test",
                    username: "redoor-password",
                    ssh_port: null,
                    name: CREATED_SSH_MISSING_PASSWORD_AGENT,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password: null,
                },
            },
        );
        // Creating the password-less entry must succeed because credentials may come from a key.
        expect(createResponse.ok()).toBe(true);
        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("link", {
                name: `${CREATED_SSH_MISSING_PASSWORD_AGENT}, stopped`,
            })
            .click();

        const lifecycleAlert = page.getByRole("alert").filter({
            hasText: "Configure a password, SSH key, or ssh-agent credential",
        });
        // Clicking the tab must surface non-interactive authentication guidance promptly.
        await expect(lifecycleAlert).toBeVisible({ timeout: 15_000 });
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Agents" })
            .click();
        const row = page.getByRole("row", {
            name: `Agent ${CREATED_SSH_MISSING_PASSWORD_AGENT}`,
        });
        // The retained watchdog issue must remain visible outside the lifecycle route.
        await expect(row.getByRole("alert")).toContainText(
            "Configure a password, SSH key, or ssh-agent credential",
        );
        // Responsive navigation proves password preparation is not blocking the server.
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Server home" })
            .click();
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
    });

    test("shows managed inventory before lazy startup", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents`);
        await expect(
            page.getByRole("heading", {
                level: 1,
                name: "Agents",
                exact: true,
            }),
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
            .getByRole("link", { name: `${VALID_AGENT}, stopped` })
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
            page.getByRole("link", { name: `${VALID_AGENT}, connected` }),
        ).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
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
        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Server home" })
            .click();
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
    });
});
