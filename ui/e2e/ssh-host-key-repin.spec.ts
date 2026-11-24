import { expect, test } from "./fixtures";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { SshHostKeyPinResponse } from "#bindings/SshHostKeyPinResponse";
import type { SshHostKeyResponse } from "#bindings/SshHostKeyResponse";
import { ignoreServerEvents, WEB_BASE_URL } from "./helpers";

const DEVICE_ID = "dev_hostkeyrepintest00001";
const DEVICE_NAME = "lima-sandbox-repin-test";
const PINNED_FINGERPRINT = "SHA256:PyX7vOcF2iPVF7uPA+97U+QezCmf0gPfC9dxeNTSniQ";

const PRESENTED_FINGERPRINT =
    "SHA256:INq4pD2AYoSB4xSZracPLZNHp50594KBf1AsSKpYBm8";

/** Builds a synthetic managed SSH device stuck connecting on the given error. */
function makeConnectingSshAgent(error: string): AgentInfoResponse {
    const nowMs = Date.now();

    return {
        id: DEVICE_ID,
        name: DEVICE_NAME,
        cwd: null,
        managed: true,
        configuration_editable: true,
        ssh_target: "lima-radiator-sandbox",
        status: "starting",
        connected_at: null,
        connection_id: null,
        last_seen_at: Math.floor(nowMs / 1000) - 60,
        connection_issue: error,
        provisioning_status: [],
        last_failed_attempt: {
            messages: [{ message: "Sniffing the SSH target", at: nowMs - 66 }],
            error,
            at: nowMs,
        },
        binary: null,
        supports_native_open: false,
        supports_move_to_trash: false,
        supports_trash: false,
        supports_upload_preconditions: false,
        uid: null,
        is_root: false,
        systemd: null,
        duplicate_id: null,
    };
}

test.describe("SSH host key re-pin from connecting view", () => {
    test("re-pins a changed host key from the connecting view and retries startup", async ({
        page,
    }) => {
        await ignoreServerEvents(page);

        const hostKeyError = `SSH host key changed. The device presented ${PRESENTED_FINGERPRINT}, but ${PINNED_FINGERPRINT} is pinned for it. If the change is expected, re-pin the host key from the device page.`;

        let currentAgent = makeConnectingSshAgent(hostKeyError);
        const pinnedFingerprints: string[] = [];
        let retryStartCalls = 0;

        await page.route(`${WEB_BASE_URL}/api/v1/agents`, async (route) => {
            if (route.request().method() !== "GET") {
                await route.continue();

                return;
            }

            const response = await route.fetch();
            const body: AgentListResponse = await response.json();

            await route.fulfill({
                response,
                json: {
                    agents: [...body.agents, currentAgent],
                },
            });
        });

        await page.route(
            `${WEB_BASE_URL}/api/v1/agents/${DEVICE_ID}/ssh-host-key`,
            async (route) => {
                const payload: SshHostKeyResponse = {
                    key_type: "ssh-ed25519",
                    fingerprint: PRESENTED_FINGERPRINT,
                    previously_trusted: false,
                    pinned_fingerprint: PINNED_FINGERPRINT,
                };

                await route.fulfill({ status: 200, json: payload });
            },
        );

        await page.route(
            `${WEB_BASE_URL}/api/v1/agents/${DEVICE_ID}/ssh-host-key/pin`,
            async (route) => {
                const requestBody = route.request().postDataJSON();
                pinnedFingerprints.push(requestBody.host_key_fingerprint);

                const payload: SshHostKeyPinResponse = {
                    key_type: "ssh-ed25519",
                    fingerprint: PRESENTED_FINGERPRINT,
                };

                await route.fulfill({ status: 200, json: payload });
            },
        );

        await page.route(
            `${WEB_BASE_URL}/api/v1/agents/${DEVICE_ID}/retry-start`,
            async (route) => {
                retryStartCalls += 1;
                currentAgent = {
                    ...currentAgent,
                    connection_issue: null,
                    provisioning_status: [
                        { message: "Retrying SSH connection", at: Date.now() },
                    ],
                };
                await route.fulfill({
                    status: 200,
                    json: { agent: currentAgent },
                });
            },
        );

        await page.goto(`${WEB_BASE_URL}/agents/${DEVICE_NAME}/browser/`);

        // The connecting screen must surface a direct re-pin action next to the host key failure.
        const repinButton = page.getByRole("button", {
            name: "Re-pin host key",
        });

        await expect(repinButton).toBeVisible();
        await repinButton.click();

        const dialog = page.getByRole("dialog", {
            name: "Re-pin host key",
        });

        await expect(dialog).toBeVisible();
        // Both fingerprints are shown so the user can compare them before trusting the new key.
        await expect(dialog.getByLabel("Pinned host key contents")).toHaveText(
            PINNED_FINGERPRINT,
        );
        await expect(
            dialog.getByLabel("Presented host key (ssh-ed25519) contents"),
        ).toHaveText(PRESENTED_FINGERPRINT);

        const retryResponse = page.waitForResponse(
            (response) =>
                response.url() ===
                    `${WEB_BASE_URL}/api/v1/agents/${DEVICE_ID}/retry-start` &&
                response.request().method() === "POST",
        );

        // Register before clicking so a fast post-retry refetch cannot complete before we wait.
        const postRetryAgentsRefresh = page.waitForResponse(
            (response) =>
                retryStartCalls > 0 &&
                response.url() === `${WEB_BASE_URL}/api/v1/agents` &&
                response.request().method() === "GET",
        );

        await dialog
            .getByRole("button", { name: "Trust new host key" })
            .click();

        await retryResponse;
        await postRetryAgentsRefresh;

        // Wait for the refreshed retry snapshot to render before checking that the prompt
        // stays hidden while `last_failed_attempt` is still present.
        await expect(page.getByText("Retrying SSH connection")).toBeVisible();

        // Confirming must pin the presented fingerprint and immediately retry the waiting start.
        expect(pinnedFingerprints).toEqual([PRESENTED_FINGERPRINT]);
        expect(retryStartCalls).toBe(1);
        await expect(dialog).toBeHidden();
        // The callout stays hidden after the retry clears connection_issue on the same failure.
        await expect(repinButton).toHaveCount(0);
        await expect(
            page.getByRole("status").filter({ hasText: PRESENTED_FINGERPRINT }),
        ).toBeVisible();
    });

    test("does not offer host key re-pin for unrelated SSH errors", async ({
        page,
    }) => {
        await ignoreServerEvents(page);

        const authError =
            "SSH authentication failed. The configured password or SSH key was rejected.";

        const agent = makeConnectingSshAgent(authError);

        await page.route(`${WEB_BASE_URL}/api/v1/agents`, async (route) => {
            if (route.request().method() !== "GET") {
                await route.continue();

                return;
            }

            const response = await route.fetch();
            const body: AgentListResponse = await response.json();

            await route.fulfill({
                response,
                json: {
                    agents: [...body.agents, agent],
                },
            });
        });

        await page.goto(`${WEB_BASE_URL}/agents/${DEVICE_NAME}/browser/`);

        // Wait for the unrelated failure to render before asserting the re-pin button is absent.
        await expect(page.getByText(authError)).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Re-pin host key" }),
        ).toHaveCount(0);
    });
});
