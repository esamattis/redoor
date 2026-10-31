// Serial: adds and removes SSH devices in the shared device list, and creates and deletes
// the test account's vault, which encrypts SSH keys.
import fs from "node:fs/promises";
import path from "node:path";
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from "@playwright/test";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import type { SshHostKeyResponse } from "#bindings/SshHostKeyResponse";
import type { SshKeyRemovalResponse } from "#bindings/SshKeyRemovalResponse";
import type { SshKeyStatusResponse } from "#bindings/SshKeyStatusResponse";
import { WEB_BASE_URL } from "../helpers";

// Only the password user is used here: the integration tests enroll keys for `redoor`, and
// two suites rewriting the same authorized_keys at once would race.
const SSH_USER = "redoor-password";

const ADDED_DEVICE = `playwright-ssh-key-${process.pid}`;

const UPGRADED_DEVICE = `playwright-ssh-key-upgrade-${process.pid}`;

const ENCRYPTED_DEVICE = `playwright-ssh-key-vault-${process.pid}`;

const PASSPHRASE = "correct horse battery staple";

/** The Playwright server's data directories, where the account's vault file lives. */
const SERVER_SHARE = path.resolve(".test-playwright-home/.local/share");

/** Deletes the account's vault, so the vault test starts and ends without one. */
async function removeVault() {
    const apps = await fs.readdir(SERVER_SHARE).catch(() => []);

    await Promise.all(
        apps.map((app) =>
            fs.rm(
                path.join(
                    SERVER_SHARE,
                    app,
                    "users",
                    "test-user",
                    "vault.json",
                ),
                { force: true },
            ),
        ),
    );
}

// Enrollment and the following connect provision the agent over the fixture, which can take
// a minute under full-suite load.
const SSH_KEY_TEST_TIMEOUT = 150_000;

const DEDICATED_KEY_OPTION = "Create a dedicated SSH key (recommended)";

/** Finds a device by name, or undefined once it was deleted. */
async function findAgent(
    request: APIRequestContext,
    name: string,
): Promise<AgentInfoResponse | undefined> {
    const response = await request.get(`${WEB_BASE_URL}/api/v1/agents`);
    expect(response.ok()).toBe(true);
    const body: AgentListResponse = await response.json();

    return body.agents.find((entry) => entry.name === name);
}

/** Reads a device's saved SSH settings, which report the key and the pin but no secrets. */
async function getConfiguration(
    request: APIRequestContext,
    agentId: string,
): Promise<ManagedSshAgentConfigurationResponse> {
    const response = await request.get(
        `${WEB_BASE_URL}/api/v1/agents/${agentId}/configuration`,
    );

    expect(response.ok()).toBe(true);

    return response.json();
}

/**
 * Stops the device, removes its key line from the shared fixture account and deletes the
 * device, so no agent, authorized_keys line or config entry outlives the test.
 *
 * An encrypted key can only remove its line with its file key, which only the browser's
 * vault has; the encrypted key test removes it through the UI, so this cleanup accepts a
 * local-only removal for such a key after a failure.
 */
async function removeDevice(
    request: APIRequestContext,
    name: string,
): Promise<void> {
    const agent = await findAgent(request, name);

    if (!agent) return;

    if (agent.status !== "stopped") {
        const shutdown = await request.post(
            `${WEB_BASE_URL}/api/v1/agents/${agent.id}/shutdown`,
        );

        expect(shutdown.ok()).toBe(true);
        await expect
            .poll(async () => (await findAgent(request, name))?.status, {
                timeout: 20_000,
            })
            .toBe("stopped");
    }

    const configuration = await getConfiguration(request, agent.id);

    if (configuration.has_managed_ssh_key) {
        const encrypted = (await getKeyStatus(request, agent.id)).encrypted;

        const removal = await request.delete(
            `${WEB_BASE_URL}/api/v1/agents/${agent.id}/ssh-key`,
        );

        expect(removal.ok()).toBe(true);
        const body: SshKeyRemovalResponse = await removal.json();
        // A line left behind would keep a deleted device's key able to log in.
        expect(body.removed_from_device || encrypted).toBe(true);
    }

    const deletion = await request.delete(
        `${WEB_BASE_URL}/api/v1/agents/${agent.id}`,
    );

    expect(deletion.ok()).toBe(true);
}

/** Answers the shared vault prompt with the passphrase. */
async function unlockVault(page: Page): Promise<void> {
    const unlock = page.getByRole("dialog", { name: "Unlock vault" });
    await expect(unlock).toBeVisible({ timeout: 30_000 });
    await unlock.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
    // Argon2id takes a moment; the dialog closes once the vault is unlocked.
    await expect(unlock).toBeHidden({ timeout: 30_000 });
}

/** Reads how the device's key is stored: encrypted with the vault or not. */
async function getKeyStatus(
    request: APIRequestContext,
    agentId: string,
): Promise<SshKeyStatusResponse> {
    const response = await request.get(
        `${WEB_BASE_URL}/api/v1/agents/${agentId}/ssh-key`,
    );

    expect(response.ok()).toBe(true);

    return response.json();
}

/** Probes the host key the fixture presents, to compare with what the UI showed. */
async function probeHostKey(
    request: APIRequestContext,
    agentId: string,
): Promise<SshHostKeyResponse> {
    const response = await request.get(
        `${WEB_BASE_URL}/api/v1/agents/${agentId}/ssh-host-key`,
    );

    expect(response.ok()).toBe(true);

    return response.json();
}

test.describe.serial("Dedicated SSH device keys", () => {
    test.skip(
        process.env.REDOOR_SSH_TEST !== "1" ||
            !process.env.REDOOR_SSH_TEST_PASSWORD,
        "redoor-ssh-test password fixture is not enabled",
    );

    test.beforeEach(async ({ request }) => {
        await removeDevice(request, ADDED_DEVICE);
        await removeDevice(request, UPGRADED_DEVICE);
        await removeDevice(request, ENCRYPTED_DEVICE);
        await removeVault();
    });

    // Playwright has no onTestFinished; afterEach is its per-test cleanup hook.
    test.afterEach(async ({ request }) => {
        await removeDevice(request, ADDED_DEVICE);
        await removeDevice(request, UPGRADED_DEVICE);
        await removeDevice(request, ENCRYPTED_DEVICE);
        await removeVault();
    });

    test("adds a device with a dedicated key and connects with it", async ({
        page,
    }) => {
        test.setTimeout(SSH_KEY_TEST_TIMEOUT);
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;

        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }

        await page.goto(`${WEB_BASE_URL}/agents/new`);
        await page.getByLabel("SSH target").fill("redoor-ssh-test");
        await page.getByLabel("SSH username").fill(SSH_USER);
        await page.getByLabel("Device name").fill(ADDED_DEVICE);
        // The dedicated key is the default for new SSH devices.
        await expect(
            page.getByRole("checkbox", { name: DEDICATED_KEY_OPTION }),
        ).toBeChecked();
        await page
            .getByLabel("SSH password (used once, not saved)")
            .fill(password);

        const [createResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url() === `${WEB_BASE_URL}/api/v1/agents` &&
                    response.request().method() === "POST",
            ),
            page.getByRole("button", { name: "Add device" }).click(),
        ]);

        expect(createResponse.ok()).toBe(true);
        // The password is meant for the key setup only, so creating the device never sends it.
        expect(createResponse.request().postDataJSON()).toMatchObject({
            password: null,
        });

        const setup = page.getByRole("dialog", {
            name: "Set up a dedicated SSH key",
        });

        const fingerprint = setup.getByLabel(/^Host key \(.+\) contents$/);
        await expect(fingerprint).toHaveText(/^SHA256:/, { timeout: 30_000 });

        const agent = await findAgent(page.request, ADDED_DEVICE);

        if (!agent) throw new Error(`${ADDED_DEVICE} missing after create`);

        // The user must be shown the key the device really presents before trusting it.
        await expect(fingerprint).toHaveText(
            (await probeHostKey(page.request, agent.id)).fingerprint,
        );
        // The password typed in the form is carried over instead of asked again.
        await expect(
            setup.getByLabel("SSH password (used once, not saved)"),
        ).toHaveValue(password);
        await setup
            .getByRole("button", { name: "Trust host key and install" })
            .click();

        const installed = page.getByRole("dialog", {
            name: "SSH key installed",
        });

        // Enrollment must finish with the new key's fingerprint for the user to verify.
        await expect(
            installed.getByLabel("New key fingerprint contents"),
        ).toHaveText(/^SHA256:/, { timeout: 60_000 });

        const configuration = await getConfiguration(page.request, agent.id);
        // The device now uses its own key, and the typed password was never stored.
        expect(configuration.has_managed_ssh_key).toBe(true);
        expect(configuration.has_password).toBe(false);
        expect(configuration.has_pinned_host_key).toBe(true);

        await installed.getByRole("button", { name: "Open device" }).click();
        await page
            .getByRole("button", { name: "Connect", exact: true })
            .click();
        // Connecting without any stored password proves the dedicated key logs in.
        await expect(
            page.getByRole("link", { name: `${ADDED_DEVICE}, connected` }),
        ).toHaveAttribute("aria-current", "page", { timeout: 90_000 });
    });

    test("upgrades a password device to a dedicated key from its configuration page", async ({
        page,
    }) => {
        test.setTimeout(SSH_KEY_TEST_TIMEOUT);
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;

        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }

        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "redoor-ssh-test",
                    username: SSH_USER,
                    ssh_port: null,
                    name: UPGRADED_DEVICE,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password,
                    clear_password: false,
                },
            },
        );

        expect(createResponse.ok()).toBe(true);
        const agent = await findAgent(page.request, UPGRADED_DEVICE);

        if (!agent) throw new Error(`${UPGRADED_DEVICE} missing after create`);

        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("link", { name: `Edit ${UPGRADED_DEVICE}` })
            .click();

        const status = page.getByLabel("SSH key status");
        // The page must say the device still relies on a stored plaintext password.
        await expect(status).toContainText("password stored as plaintext");
        await page.getByRole("button", { name: "Set up SSH key" }).click();

        const setup = page.getByRole("dialog", {
            name: "Set up a dedicated SSH key",
        });

        await expect(setup.getByLabel(/^Host key \(.+\) contents$/)).toHaveText(
            /^SHA256:/,
            { timeout: 30_000 },
        );
        // No password is typed: the stored one is used once to install the key.
        await setup
            .getByRole("button", { name: "Trust host key and install" })
            .click();

        const installed = page.getByRole("dialog", {
            name: "SSH key installed",
        });

        await expect(
            installed.getByLabel("New key fingerprint contents"),
        ).toHaveText(/^SHA256:/, { timeout: 60_000 });
        await installed.getByRole("button", { name: "Done" }).click();

        const configuration = await getConfiguration(page.request, agent.id);
        // Upgrading must replace the stored password with the key, never keep both.
        expect(configuration.has_managed_ssh_key).toBe(true);
        expect(configuration.has_password).toBe(false);
        // The page must switch to the actions for a device that has a key.
        await expect(status).toContainText("dedicated SSH key");
        await expect(
            page.getByRole("button", { name: "Rotate key" }),
        ).toBeVisible();

        await page
            .getByRole("link", { name: `${UPGRADED_DEVICE}, stopped` })
            .click();
        await page
            .getByRole("button", { name: "Connect", exact: true })
            .click();
        // Connecting after the password was removed proves the upgraded key logs in.
        await expect(
            page.getByRole("link", {
                name: `${UPGRADED_DEVICE}, connected`,
            }),
        ).toHaveAttribute("aria-current", "page", { timeout: 90_000 });

        await page
            .getByRole("link", { name: `Edit ${UPGRADED_DEVICE}` })
            .click();
        await page.getByRole("button", { name: "Re-pin host key" }).click();

        const repin = page.getByRole("dialog", { name: "Re-pin host key" });

        // The device still presents the pinned key, so nothing may be re-pinned.
        await expect(repin.getByText("The host key is unchanged.")).toBeVisible(
            { timeout: 30_000 },
        );
        await expect(
            repin.getByRole("button", { name: "Trust new host key" }),
        ).toHaveCount(0);
        await repin.getByRole("button", { name: "Close", exact: true }).click();

        await page.getByRole("button", { name: "Remove key" }).click();
        await page
            .getByRole("dialog", {
                name: `Remove the SSH key of ${UPGRADED_DEVICE}?`,
            })
            .getByRole("button", { name: "Remove key" })
            .click();
        // Removal must report that the line left the device, not only the local copy.
        await expect(
            page
                .getByRole("status")
                .filter({ hasText: "Removed the SSH key from" }),
        ).toBeVisible({ timeout: 30_000 });

        const afterRemoval = await getConfiguration(page.request, agent.id);
        // The key is gone but the host key stays pinned for a later setup.
        expect(afterRemoval.has_managed_ssh_key).toBe(false);
        expect(afterRemoval.has_pinned_host_key).toBe(true);
        await expect(
            page.getByRole("button", { name: "Set up SSH key" }),
        ).toBeVisible();
    });

    test("sets up a vault-encrypted key and starts the device through the unlock prompt", async ({
        page,
    }) => {
        test.setTimeout(SSH_KEY_TEST_TIMEOUT);
        const password = process.env.REDOOR_SSH_TEST_PASSWORD;

        if (password === undefined) {
            throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
        }

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();

        const create = page.getByRole("dialog", { name: "Create vault" });
        await create.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
        await create.getByLabel("Repeat passphrase").fill(PASSPHRASE);
        await create.getByRole("button", { name: "Create vault" }).click();
        // Argon2id takes a moment; the dialog closes once the vault exists and is unlocked.
        await expect(create).toBeHidden({ timeout: 30_000 });

        const createResponse = await page.request.post(
            `${WEB_BASE_URL}/api/v1/agents`,
            {
                data: {
                    target: "redoor-ssh-test",
                    username: SSH_USER,
                    ssh_port: null,
                    name: ENCRYPTED_DEVICE,
                    remote_bin: null,
                    home: null,
                    log: null,
                    password,
                    clear_password: false,
                },
            },
        );

        expect(createResponse.ok()).toBe(true);
        const agent = await findAgent(page.request, ENCRYPTED_DEVICE);

        if (!agent) throw new Error(`${ENCRYPTED_DEVICE} missing after create`);

        await page.goto(`${WEB_BASE_URL}/`);
        await page
            .getByRole("link", { name: `Edit ${ENCRYPTED_DEVICE}` })
            .click();
        await page.getByRole("button", { name: "Set up SSH key" }).click();

        const setup = page.getByRole("dialog", {
            name: "Set up a dedicated SSH key",
        });

        // The dialog tells the user the key is encrypted with the vault.
        await expect(
            setup.getByText("encrypted with your vault"),
        ).toBeVisible();
        await expect(setup.getByLabel(/^Host key \(.+\) contents$/)).toHaveText(
            /^SHA256:/,
            { timeout: 30_000 },
        );
        await setup
            .getByRole("button", { name: "Trust host key and install" })
            .click();

        // The page load locked the vault, and the new key needs it, so the setup asks first.
        const unlock = page.getByRole("dialog", { name: "Unlock vault" });
        await expect(unlock).toBeVisible({ timeout: 30_000 });
        await unlock.getByRole("button", { name: "Cancel" }).first().click();
        await expect(unlock).toBeHidden();
        // Cancelling the unlock is the user's choice, so the setup returns to its form
        // without reporting it as a failure.
        await expect(setup.getByRole("alert")).toHaveCount(0);
        await expect(
            setup.getByRole("button", { name: "Trust host key and install" }),
        ).toBeEnabled();

        await setup
            .getByRole("button", { name: "Trust host key and install" })
            .click();
        await expect(unlock).toBeVisible({ timeout: 30_000 });
        await unlock.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
        await unlock
            .getByRole("button", { name: "Unlock", exact: true })
            .click();
        // Escape while the unlock runs must not cancel the waiting setup; otherwise the
        // vault would unlock after the setup had already failed.
        await page.keyboard.press("Escape");
        await expect(unlock).toBeHidden({ timeout: 30_000 });

        const installed = page.getByRole("dialog", {
            name: "SSH key installed",
        });

        await expect(
            installed.getByLabel("New key fingerprint contents"),
        ).toHaveText(/^SHA256:/, { timeout: 60_000 });
        await installed.getByRole("button", { name: "Done" }).click();

        // The key was encrypted with the vault.
        expect((await getKeyStatus(page.request, agent.id)).encrypted).toBe(
            true,
        );
        // The configuration page says how the key is stored.
        await expect(page.getByLabel("SSH key storage")).toContainText(
            "Encrypted with vault",
        );

        // Loading the page again locks the vault, which was not kept on this device.
        await page.goto(`${WEB_BASE_URL}/agents/${ENCRYPTED_DEVICE}`);
        await page
            .getByRole("button", { name: "Connect", exact: true })
            .click();
        // Starting a device whose key is locked asks for the vault ...
        await unlockVault(page);
        // ... and once unlocked, the start hands the key over and the device connects.
        await expect(
            page.getByRole("link", { name: `${ENCRYPTED_DEVICE}, connected` }),
        ).toHaveAttribute("aria-current", "page", { timeout: 90_000 });
        // The server holds the key while the device runs.
        expect((await getKeyStatus(page.request, agent.id)).held).toBe(true);

        await page
            .getByRole("link", { name: `Edit ${ENCRYPTED_DEVICE}` })
            .click();
        await page.getByRole("button", { name: "Remove key" }).click();
        await page
            .getByRole("dialog", {
                name: `Remove the SSH key of ${ENCRYPTED_DEVICE}?`,
            })
            .getByRole("button", { name: "Remove key" })
            .click();
        // The unlocked vault gave the removal the key's file key, so the line left the device.
        await expect(
            page
                .getByRole("status")
                .filter({ hasText: "Removed the SSH key from" }),
        ).toBeVisible({ timeout: 30_000 });
    });
});
