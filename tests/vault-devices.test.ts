import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import type { ApiErrorCode } from "#bindings/ApiErrorCode";
import {
    buildNewVault,
    buildRotation,
    newPassphraseKek,
    openPassphraseSlot,
    openGenerations,
    proofFromRaw,
} from "#ui/vault/vault-keys";
import { unwrapForDevice, wrapForDevice } from "#ui/vault/vault-crypto";
import {
    ALL_PERMISSIONS,
    ProcessManager,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    TempFileManager,
    createAccessToken,
    restartServerAndWait,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "vault-devices-test-agent";

const PASSPHRASE = "correct horse battery staple";

/** The shared vault file at the data directory root, which every test starts without. */
const VAULT_PATH = join(
    TEST_SERVER_HOME,
    ".local/share",
    TEST_APP_NAME,
    "vault.json",
);

/** The server's default log, which the restart helper watches for the new startup. */
const SERVER_LOG = join(
    TEST_SERVER_HOME,
    ".local/share",
    TEST_APP_NAME,
    "server.log",
);

/** Asserts that a call fails with the given status and vault error code. */
async function expectFailure(
    promise: Promise<unknown>,
    status: number,
    code: ApiErrorCode | null,
): Promise<void> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ApiError);

        if (error instanceof ApiError) {
            expect(error.status).toBe(status);
            expect(error.code).toBe(code);

            return;
        }
    }

    throw new Error(`expected the call to fail with ${status}`);
}

/** Asserts that the device entry is gone for this client: every route answers 404. */
async function expectDeviceGone(api: ApiClient, deviceId: string) {
    // Opening, touching and checking all agree that the entry no longer exists.
    await expectFailure(
        api.openVaultDevice(deviceId),
        404,
        "vault_device_not_found",
    );
    await expectFailure(
        api.touchVaultDevice(deviceId),
        404,
        "vault_device_not_found",
    );
    await expectFailure(
        api.getVaultDevice(deviceId),
        404,
        "vault_device_not_found",
    );
}

describe("Vault device secrets", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;

    beforeAll(async () => {
        fs.rmSync(VAULT_PATH, { force: true });

        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        apiClient = setup.apiClient;
    }, 30000);

    beforeEach(() => {
        // The vault is per account and the account is shared by every test.
        fs.rmSync(VAULT_PATH, { force: true });
    });

    afterAll(async () => {
        await processManager.killAll();
        fs.rmSync(VAULT_PATH, { force: true });
        tempFiles.cleanup();
    });

    /** Creates a vault with one passphrase slot and returns its raw current key. */
    async function createVault() {
        const { request, vault, raw } = await buildNewVault({
            label: "device test vault",
            slots: async () => [
                { id: null, kek: await newPassphraseKek(PASSPHRASE) },
            ],
        });

        await apiClient.createVault(request);

        return { vault, raw };
    }

    /** A client with a login session of its own, like a second browser. */
    async function signedInClient(): Promise<ApiClient> {
        const client = new ApiClient(apiClient.baseUrl);
        await client.login(TEST_USERNAME, TEST_PASSWORD);

        return client;
    }

    it("hands the secret back to its session until the entry is deleted", async () => {
        const { vault, raw } = await createVault();

        const created = await apiClient.createVaultDevice({
            lock_after: "15_minutes",
        });

        // The idle window starts in full, measured by the server.
        expect(created.expires_in_seconds).toBe(15 * 60);

        const context = {
            vaultId: vault.vaultId,
            keyId: vault.currentKeyId,
            deviceId: created.device_id,
        };

        const wrap = await wrapForDevice(created.secret, raw, context);
        const opened = await apiClient.openVaultDevice(created.device_id);
        // A page load gets the same secret back, so the kept key opens again.
        expect(opened.secret).toBe(created.secret);
        expect(await unwrapForDevice(opened.secret, wrap, context)).toEqual(
            raw,
        );
        // Opening is not use, so the deadline does not move past the full window.
        expect(opened.expires_in_seconds).toBeLessThanOrEqual(15 * 60);

        const touched = await apiClient.touchVaultDevice(created.device_id);
        // A touch restarts the full window and carries no secret.
        expect(touched).toEqual({ expires_in_seconds: 15 * 60 });

        const checked = await apiClient.getVaultDevice(created.device_id);
        // The check answers without the secret too.
        expect(Object.keys(checked)).toEqual(["expires_in_seconds"]);

        await apiClient.deleteVaultDevice(created.device_id);
        await expectDeviceGone(apiClient, created.device_id);
        // Deleting again is harmless, so racing locks in two tabs both succeed.
        await apiClient.deleteVaultDevice(created.device_id);
    });

    it("keeps an entry without an idle lock open with no deadline", async () => {
        await createVault();

        const created = await apiClient.createVaultDevice({
            lock_after: "never",
        });

        // "Until I lock it" has no deadline on the server.
        expect(created.expires_in_seconds).toBeNull();
        expect(
            (await apiClient.openVaultDevice(created.device_id))
                .expires_in_seconds,
        ).toBeNull();
    });

    it("needs a vault before keeping one unlocked", async () => {
        // There is nothing to keep unlocked without a vault.
        await expectFailure(
            apiClient.createVaultDevice({ lock_after: "1_hour" }),
            404,
            "vault_not_found",
        );
    });

    it("refuses another session's entry", async () => {
        await createVault();

        const created = await apiClient.createVaultDevice({
            lock_after: "never",
        });

        const other = await signedInClient();
        // Another login session cannot read, use or check the entry, as if it did not exist.
        await expectDeviceGone(other, created.device_id);
        await other.deleteVaultDevice(created.device_id);
        // Its delete was ignored, so the owning session still opens the entry.
        await apiClient.openVaultDevice(created.device_id);
    });

    it("forgets a session's entries when it signs out", async () => {
        await createVault();
        const client = await signedInClient();

        const created = await client.createVaultDevice({
            lock_after: "never",
        });

        await client.logout();
        await client.login(TEST_USERNAME, TEST_PASSWORD);
        // Signing in again in the same browser does not reopen the vault.
        await expectDeviceGone(client, created.device_id);
    });

    it("forgets every entry when the vault is rotated or restored from a backup", async () => {
        await createVault();
        const other = await signedInClient();

        const mine = await apiClient.createVaultDevice({
            lock_after: "never",
        });

        const theirs = await other.createVaultDevice({ lock_after: "1_week" });
        const material = await apiClient.getVaultUnlockMaterial();
        const opened = await openPassphraseSlot(material, PASSPHRASE);

        const { request, rawNext } = await buildRotation({
            material,
            vault: await openGenerations(material, opened.rawVaultKey),
            rawPrevious: opened.rawVaultKey,
            slots: [{ id: opened.slot.id, kek: opened.kek }],
        });

        await apiClient.rotateVault(request);
        // Every stored key wraps the replaced generation, so no browser's entry survives.
        await expectDeviceGone(apiClient, mine.device_id);
        await expectDeviceGone(other, theirs.device_id);

        const afterRotation = await other.createVaultDevice({
            lock_after: "never",
        });

        const backup = await apiClient.exportVaultBackup();
        const proof = await proofFromRaw(rawNext);

        await apiClient.restoreVaultBackup({
            backup,
            backup_auth_proof: proof,
            current_auth_proof: proof,
        });

        // A restored backup replaces the vault, so entries made since are gone too.
        await expectDeviceGone(other, afterRotation.device_id);
    });

    it("forgets every entry when the server restarts", async () => {
        await createVault();

        const created = await apiClient.createVaultDevice({
            lock_after: "never",
        });

        await restartServerAndWait({ apiClient, serverLog: SERVER_LOG });
        // Secrets live in server memory only, so a restart locks every browser.
        await expectDeviceGone(apiClient, created.device_id);
    });

    it("denies every device route to access tokens", async () => {
        await createVault();

        const created = await apiClient.createVaultDevice({
            lock_after: "never",
        });

        const { token } = await createAccessToken(apiClient, {
            permissions: ALL_PERMISSIONS,
        });

        const tokenClient = new ApiClient(apiClient.baseUrl);
        tokenClient.setAccessToken(token);

        const attempts: [string, () => Promise<object | void>][] = [
            [
                "create",
                () => tokenClient.createVaultDevice({ lock_after: "never" }),
            ],
            ["open", () => tokenClient.openVaultDevice(created.device_id)],
            ["touch", () => tokenClient.touchVaultDevice(created.device_id)],
            ["check", () => tokenClient.getVaultDevice(created.device_id)],
            ["delete", () => tokenClient.deleteVaultDevice(created.device_id)],
        ];

        for (const [name, attempt] of attempts) {
            const status = await attempt().then(
                () => 200,
                (error: Error) =>
                    error instanceof ApiError ? error.status : 0,
            );

            // Tokens and MCP clients get no vault capability, so device secrets stay with
            // browser sessions.
            expect(status, name).toBe(403);
        }

        // The refused delete left the session's entry in place.
        await apiClient.openVaultDevice(created.device_id);
    });
});
