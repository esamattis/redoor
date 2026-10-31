/**
 * Managed SSH keys encrypted with the account's vault: setup, the server-held key that lets
 * the watchdog reconnect, rotation from plaintext, removal with and without the key's file
 * key, and rewrapping after a vault rotation. The vault is per account and each test starts
 * its own server with its own data directory.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ApiErrorCode } from "#bindings/ApiErrorCode";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import { rewrapSshKey } from "#ui/vault/ssh-key-vault";
import {
    buildDestroy,
    buildNewVault,
    buildRotation,
    fileKeyForHeader,
    newPassphraseKek,
    newSshKeySeal,
    openGenerations,
    openPassphraseSlot,
    type UnlockedVault,
} from "#ui/vault/vault-keys";
import {
    ALL_PERMISSIONS,
    VITEST_SERVER_PORT,
    createAccessToken,
    restartServerAndWait,
} from "./test-utils";
import { SSH_TEST_USER } from "./ssh-test-utils";
import {
    CONNECT_TIMEOUT_MS,
    SSH_KEY_TEST_TIMEOUT_MS,
    type KeyFixture,
    createDevice,
    deviceDir,
    enrollConfirmed,
    findAgent,
    keyMarker,
    localKeyFiles,
    modeOf,
    remoteDeviceLines,
    startAndWaitConnected,
    startKeyFixture,
    waitReconnected,
} from "./ssh-key-test-utils";

const PASSPHRASE = "correct horse battery staple";

/** Asserts that a call fails with the given error code and returns the error. */
async function expectCode(
    promise: Promise<unknown>,
    code: ApiErrorCode,
): Promise<ApiError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof ApiError && error.code === code) {
            return error;
        }

        throw error;
    }

    throw new Error(`expected the call to fail with ${code}`);
}

/** Creates the account's vault with one passphrase slot, as the browser would. */
async function createVault(fixture: KeyFixture): Promise<UnlockedVault> {
    const { request, vault } = await buildNewVault({
        label: "ssh key vault",
        slots: async () => [
            { id: null, kek: await newPassphraseKek(PASSPHRASE) },
        ],
    });

    await fixture.apiClient.createVault(request);

    return vault;
}

/** Unlocks the vault with the passphrase, keeping the raw key a rotation needs. */
async function unlock(fixture: KeyFixture) {
    const material = await fixture.apiClient.getVaultUnlockMaterial();
    const opened = await openPassphraseSlot(material, PASSPHRASE);

    return {
        material,
        opened,
        vault: await openGenerations(material, opened.rawVaultKey),
    };
}

/** Rotates the vault key, keeping the passphrase slot, and returns the unlocked result. */
async function rotateVault(fixture: KeyFixture): Promise<UnlockedVault> {
    const { material, opened, vault } = await unlock(fixture);

    const { request } = await buildRotation({
        material,
        vault,
        rawPrevious: opened.rawVaultKey,
        slots: [{ id: opened.slot.id, kek: opened.kek }],
    });

    await fixture.apiClient.rotateVault(request);

    return (await unlock(fixture)).vault;
}

/** Unwraps the device's encrypted key's file key from its header, like the browser does. */
async function sshKeyFileKey(
    fixture: KeyFixture,
    vault: UnlockedVault,
    deviceId: string,
): Promise<string> {
    const status = await fixture.apiClient.getSshKeyStatus(deviceId);

    if (status.vault_header === null) {
        throw new Error(`device ${deviceId} has no encrypted SSH key`);
    }

    return fileKeyForHeader(vault, status.vault_header);
}

/** Sets up an encrypted key, confirming the host key like the UI does. */
async function enrollEncrypted(
    fixture: KeyFixture,
    deviceId: string,
    vault: UnlockedVault,
) {
    const hostKey = await fixture.apiClient.getSshHostKey(deviceId);

    return fixture.apiClient.enrollSshKey(deviceId, {
        host_key_fingerprint: hostKey.fingerprint,
        password: null,
        vault: await newSshKeySeal(vault),
    });
}

/** An API client authenticated with a full-permission access token. */
async function tokenClient(fixture: KeyFixture): Promise<ApiClient> {
    const { token } = await createAccessToken(fixture.apiClient, {
        permissions: ALL_PERMISSIONS,
    });

    const client = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    client.setAccessToken(token);

    return client;
}

/** Starts the device through `client` without a file key, as a CLI or MCP client would. */
async function startWithClient(client: ApiClient, deviceId: string) {
    const agent = (await client.listAgents()).find(
        (entry) => entry.id === deviceId,
    );

    if (agent === undefined) {
        throw new Error(`device ${deviceId} missing for the token`);
    }

    return agent.start();
}

/**
 * Kills the local `ssh` process that runs the device's agent, so the watchdog has to
 * reconnect on its own. The process is found by its argv, which carries the device id in
 * the remote command, and only processes named `ssh` are touched.
 */
function killSshChild(deviceId: string): number {
    let killed = 0;

    for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;

        let argv: string[];

        try {
            argv = readFileSync(join("/proc", entry, "cmdline"), "utf8")
                .split("\0")
                .filter((arg) => arg !== "");
        } catch {
            continue;
        }

        if (argv[0] === "ssh" && argv.some((arg) => arg.includes(deviceId))) {
            process.kill(Number(entry), "SIGKILL");
            killed += 1;
        }
    }

    return killed;
}

/** Everything the server wrote, for checks that no secret was logged. */
function serverOutput(fixture: KeyFixture): string {
    return `${readFileSync(fixture.serverLog, "utf8")}${fixture.processManager.getStdout(fixture.serverPid)}`;
}

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")(
    "managed SSH keys encrypted with the vault",
    () => {
        test(
            "an encrypted key is held from a browser start until stop or server restart",
            async () => {
                const fixture = await startKeyFixture({
                    label: "vault-held",
                    sshUsers: [SSH_TEST_USER],
                });

                const vault = await createVault(fixture);

                const deviceId = await createDevice(fixture, {
                    user: SSH_TEST_USER,
                    name: `ssh-vault-held-${fixture.suffix}`,
                });

                // An account with a vault cannot create plaintext keys any more.
                await expectCode(
                    enrollConfirmed(fixture, deviceId),
                    "vault_required",
                );
                // The refused setup left nothing behind.
                expect(localKeyFiles(fixture, deviceId)).toEqual([]);

                const enrolled = await enrollEncrypted(
                    fixture,
                    deviceId,
                    vault,
                );

                const dir = deviceDir(fixture, deviceId);
                // Only the encrypted key is stored, private like a plaintext one.
                expect(localKeyFiles(fixture, deviceId)).toEqual([
                    "id_ed25519.redoorencrypted",
                ]);
                expect(modeOf(join(dir, "id_ed25519.redoorencrypted"))).toBe(
                    0o600,
                );
                // Keys live in the account's directory, next to its vault.
                expect(modeOf(fixture.sshDataDir)).toBe(0o700);
                // The private key never reaches the disk in plaintext.
                expect(
                    readFileSync(
                        join(dir, "id_ed25519.redoorencrypted"),
                        "latin1",
                    ),
                ).not.toContain("PRIVATE KEY");

                const locked = await fixture.apiClient.getSshKeyStatus(deviceId);
                // The status names the key from its header while it is locked.
                expect(locked).toMatchObject({
                    managed: true,
                    encrypted: true,
                    held: false,
                    fingerprint: enrolled.fingerprint,
                });
                expect(locked.key_status?.status).toBe("current");
                // The device has exactly the new key, marked with the account.
                expect(
                    await remoteDeviceLines(SSH_TEST_USER, deviceId),
                ).toEqual([
                    expect.stringContaining(
                        keyMarker(deviceId, enrolled.fingerprint),
                    ),
                ]);

                const token = await tokenClient(fixture);
                // A token cannot unlock the vault, so it cannot start the locked device ...
                await expectCode(
                    startWithClient(token, deviceId),
                    "ssh_key_locked",
                );
                // ... and neither can a session start without the key's file key.
                await expectCode(
                    (await findAgent(fixture, deviceId)).start(),
                    "ssh_key_locked",
                );
                // The refusal came before the watchdog, so the device stays stopped.
                expect((await findAgent(fixture, deviceId)).status).toBe(
                    "stopped",
                );

                const fileKey = await sshKeyFileKey(fixture, vault, deviceId);

                await (
                    await findAgent(fixture, deviceId)
                ).start({ ssh_key_file_key: fileKey });

                const connected = await waitReconnected(fixture, deviceId, null);

                // The browser start handed the key over; the agent logged in with it.
                expect((await connected.echo("vault-key")).message).toBe(
                    "vault-key",
                );
                // The server holds the key while the device runs.
                expect(
                    (await fixture.apiClient.getSshKeyStatus(deviceId)).held,
                ).toBe(true);

                // While it is held, a token may start the running device again.
                await startWithClient(token, deviceId);

                await connected.shutdown();
                // Stop drops the held key ...
                expect(
                    (await fixture.apiClient.getSshKeyStatus(deviceId)).held,
                ).toBe(false);
                // ... so a token can no longer start the device.
                await expectCode(
                    startWithClient(token, deviceId),
                    "ssh_key_locked",
                );

                await (
                    await findAgent(fixture, deviceId)
                ).start({ ssh_key_file_key: fileKey });
                await waitReconnected(fixture, deviceId, connected.connectionId);

                await restartServerAndWait({
                    apiClient: fixture.apiClient,
                    serverLog: fixture.serverLog,
                });

                // A restarted server holds no key: nothing is handed to the new process.
                expect(
                    (await fixture.apiClient.getSshKeyStatus(deviceId)).held,
                ).toBe(false);
                await expectCode(
                    startWithClient(token, deviceId),
                    "ssh_key_locked",
                );

                const output = serverOutput(fixture);
                // The file key never appears in the logs ...
                expect(output).not.toContain(fileKey);
                // ... and neither does private key material.
                expect(output).not.toContain("PRIVATE KEY");
            },
            SSH_KEY_TEST_TIMEOUT_MS,
        );

        test(
            "rotating a running plaintext key to an encrypted one keeps the device reconnecting",
            async () => {
                const fixture = await startKeyFixture({
                    label: "vault-rotate",
                    sshUsers: [SSH_TEST_USER],
                });

                const deviceId = await createDevice(fixture, {
                    user: SSH_TEST_USER,
                    name: `ssh-vault-rotate-${fixture.suffix}`,
                });

                const plaintext = await enrollConfirmed(fixture, deviceId);
                // Without a vault the key is plaintext, as before.
                expect(localKeyFiles(fixture, deviceId)).toEqual([
                    "id_ed25519",
                ]);

                const connected = await startAndWaitConnected(
                    fixture,
                    deviceId,
                );

                const vault = await createVault(fixture);

                // A plaintext key rotates without a file key; the new key is encrypted.
                const rotated = await fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                    vault: await newSshKeySeal(vault),
                });

                // The rotation produced a new key.
                expect(rotated.rotated).toBe(true);
                // The plaintext key is gone; only the encrypted one is stored.
                expect(localKeyFiles(fixture, deviceId)).toEqual([
                    "id_ed25519.redoorencrypted",
                ]);

                const lines = await remoteDeviceLines(SSH_TEST_USER, deviceId);
                // The old line is removed and only the new key is authorized.
                expect(lines).toEqual([
                    expect.stringContaining(
                        keyMarker(deviceId, rotated.fingerprint),
                    ),
                ]);
                expect(lines[0]).not.toContain(plaintext.fingerprint);
                // The running device holds the new key, so it can reconnect.
                expect(
                    (await fixture.apiClient.getSshKeyStatus(deviceId)).held,
                ).toBe(true);

                // Losing the ssh process makes the watchdog reconnect on its own.
                expect(killSshChild(deviceId)).toBeGreaterThan(0);

                const reconnected = await waitReconnected(
                    fixture,
                    deviceId,
                    connected.connectionId,
                );

                // The reconnect logged in with the held encrypted key.
                expect((await reconnected.echo("held-key")).message).toBe(
                    "held-key",
                );

                await reconnected.shutdown();
            },
            SSH_KEY_TEST_TIMEOUT_MS + CONNECT_TIMEOUT_MS,
        );

        test(
            "removing an encrypted key of a stopped device needs its file key to reach the device",
            async () => {
                const fixture = await startKeyFixture({
                    label: "vault-remove",
                    sshUsers: [SSH_TEST_USER],
                });

                const vault = await createVault(fixture);

                const deviceId = await createDevice(fixture, {
                    user: SSH_TEST_USER,
                    name: `ssh-vault-remove-${fixture.suffix}`,
                });

                await enrollEncrypted(fixture, deviceId, vault);

                const rotated = await fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                    vault: await newSshKeySeal(vault),
                    current_file_key: await sshKeyFileKey(
                        fixture,
                        vault,
                        deviceId,
                    ),
                });

                // A stopped device's rotation logged in with the request's file key ...
                expect(rotated.rotated).toBe(true);
                // ... which was not kept, so a token still cannot start the device.
                expect(
                    (await fixture.apiClient.getSshKeyStatus(deviceId)).held,
                ).toBe(false);

                const localOnly = await fixture.apiClient.removeSshKey(deviceId);

                // Without the file key the server cannot log in to remove the line ...
                expect(localOnly.removed_from_device).toBe(false);
                // ... so the line stays on the device ...
                expect(
                    await remoteDeviceLines(SSH_TEST_USER, deviceId),
                ).toHaveLength(1);
                // ... while the key is deleted locally anyway.
                expect(localKeyFiles(fixture, deviceId)).toEqual([]);

                await enrollEncrypted(fixture, deviceId, vault);

                const removed = await fixture.apiClient.removeSshKey(deviceId, {
                    current_file_key: await sshKeyFileKey(
                        fixture,
                        vault,
                        deviceId,
                    ),
                });

                // With the file key the device was reached ...
                expect(removed).toEqual({
                    removed_from_device: true,
                    device_error: null,
                });
                // ... and every line of this device and account is gone, including the
                // one the local-only removal left behind.
                expect(
                    await remoteDeviceLines(SSH_TEST_USER, deviceId),
                ).toEqual([]);
                // The pin stays for the next setup.
                expect(readdirSync(deviceDir(fixture, deviceId))).toEqual([
                    "known_hosts",
                ]);
            },
            SSH_KEY_TEST_TIMEOUT_MS,
        );

        test(
            "after a vault rotation the key is rewrapped before its generation can be destroyed",
            async () => {
                const fixture = await startKeyFixture({
                    label: "vault-rewrap",
                    sshUsers: [SSH_TEST_USER],
                });

                const first = await createVault(fixture);

                const deviceId = await createDevice(fixture, {
                    user: SSH_TEST_USER,
                    name: `ssh-vault-rewrap-${fixture.suffix}`,
                });

                await enrollEncrypted(fixture, deviceId, first);

                const rotated = await rotateVault(fixture);
                const before = await fixture.apiClient.listVaultSshKeys();

                // The key is listed on the older generation, for the settings page.
                expect(before.keys).toHaveLength(1);
                expect(before.keys[0]?.device_id).toBe(deviceId);
                expect(before.keys[0]?.key_status.status).toBe("older");

                const { material, vault } = await unlock(fixture);

                const destroy = await buildDestroy({
                    material,
                    vault,
                    keyId: first.currentKeyId,
                });

                // The key would become unreadable, so destroying its generation is refused.
                await expectCode(
                    fixture.apiClient.destroyVaultKey(
                        first.currentKeyId,
                        destroy,
                    ),
                    "vault_key_in_use",
                );

                const key = before.keys[0];

                if (key === undefined) {
                    throw new Error("the encrypted key is not listed");
                }

                await rewrapSshKey({
                    api: fixture.apiClient,
                    vault: rotated,
                    key,
                });

                const after = await fixture.apiClient.listVaultSshKeys();
                // The key moved to the current generation.
                expect(after.keys[0]?.key_status.status).toBe("current");

                await fixture.apiClient.destroyVaultKey(
                    first.currentKeyId,
                    destroy,
                );

                await (
                    await findAgent(fixture, deviceId)
                ).start({
                    ssh_key_file_key: await sshKeyFileKey(
                        fixture,
                        rotated,
                        deviceId,
                    ),
                });

                const connected = await waitReconnected(fixture, deviceId, null);

                // The rewrapped key still logs in after the old generation is gone.
                expect((await connected.echo("rewrapped")).message).toBe(
                    "rewrapped",
                );

                await connected.shutdown();
            },
            SSH_KEY_TEST_TIMEOUT_MS,
        );
    },
);

describe("managed SSH key vault access", () => {
    test("access tokens get 403 on the SSH key status, rewrap and list routes", async () => {
        const fixture = await startKeyFixture({
            label: "vault-token",
            sshUsers: [],
        });

        // Never contacted: the token is rejected before the handler runs.
        const created = await fixture.apiClient.createSshAgent({
            target: "ssh-vault-unreachable.invalid",
            username: "nobody",
            ssh_port: null,
            name: `ssh-vault-token-${fixture.suffix}`,
            remote_bin: null,
            home: null,
            log: null,
            password: null,
            clear_password: null,
        });

        const deviceId = created.agent.id;
        const token = await tokenClient(fixture);

        const statuses = await Promise.all(
            [
                token.getSshKeyStatus(deviceId),
                token.rewrapSshKey(deviceId, {
                    file_key: "x",
                    key_id: "kid_x",
                    wrap: { alg: "A256GCM", iv: "x", ct: "x" },
                }),
                token.listVaultSshKeys(),
            ].map(async (call) => {
                try {
                    await call;
                } catch (error) {
                    if (error instanceof ApiError) {
                        return error.status;
                    }

                    throw error;
                }

                return 200;
            }),
        );

        // Only a browser session may read key headers or rewrap keys.
        expect(statuses).toEqual([403, 403, 403]);

        const status = await fixture.apiClient.getSshKeyStatus(deviceId);
        // The session reaches the handler: a device without a managed key reports so.
        expect(status).toMatchObject({ managed: false, encrypted: false });
    }, 30_000);
});
