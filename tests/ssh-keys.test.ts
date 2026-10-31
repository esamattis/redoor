import {
    chmodSync,
    existsSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { $ } from "zx";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ALL_PERMISSIONS,
    VITEST_SERVER_PORT,
    createAccessToken,
    waitForLogMessage,
} from "./test-utils";
import {
    SSH_PASSWORD_USER,
    SSH_TEST_HOST,
    SSH_TEST_USER,
    shellQuote,
    sshTestCommand,
} from "./ssh-test-utils";
import {
    SSH_KEY_TEST_TIMEOUT_MS,
    CLEANUP_TIMEOUT_MS,
    startKeyFixture,
    updateRequest,
    createDevice,
    remoteAuthorizedKeys,
    remoteDeviceLines,
    configEntry,
    deviceDir,
    localKeyFiles,
    localPublicKey,
    modeOf,
    fingerprintOf,
    randomEd25519PublicKey,
    apiFailure,
    enrollConfirmed,
    findAgent,
    startAndWaitConnected,
    startAndWaitForIssue,
    fixturePassword,
    keyMarker,
} from "./ssh-key-test-utils";

describe.skipIf(
    process.env.REDOOR_SSH_TEST !== "1" ||
        !process.env.REDOOR_SSH_TEST_PASSWORD,
)("managed SSH keys with password bootstrap", () => {
    test(
        "enrolls with a typed password and connects with the managed key",
        async () => {
            const fixture = await startKeyFixture({
                label: "typed",
                sshUsers: [SSH_PASSWORD_USER],
            });

            const password = fixturePassword();

            const deviceId = await createDevice(fixture, {
                user: SSH_PASSWORD_USER,
                name: `ssh-keys-typed-${fixture.suffix}`,
            });

            const hostKey = await fixture.apiClient.getSshHostKey(deviceId);
            // The probe returns a fingerprint the user can compare with the device.
            expect(hostKey.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
            // A new device has nothing pinned, so the UI must ask for confirmation.
            expect(hostKey.pinned_fingerprint).toBeNull();

            const unconfirmed = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password,
                }),
            );

            // No credential may be sent before the user confirmed the host key.
            expect(unconfirmed.status).toBe(400);

            const withoutPassword = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: hostKey.fingerprint,
                    password: null,
                }),
            );

            // The server's own keys do not work for this account, so the user must type one.
            expect(withoutPassword.status).toBe(400);
            // The message says what was tried and what the user has to do next.
            expect(withoutPassword.message).toContain(
                "this server's own SSH keys",
            );
            expect(withoutPassword.message).toContain(
                "Enter the device's login password",
            );

            const serverProcess = fixture.processManager.getProcess(
                fixture.serverPid,
            );

            if (!serverProcess) {
                throw new Error("Server process not found");
            }

            const rejectionLogged = waitForLogMessage(
                serverProcess,
                new RegExp(
                    `rejected a credential for installing the managed SSH key: device=${deviceId}, credential=the typed password, error=SSH authentication failed`,
                ),
            );

            const failureLogged = waitForLogMessage(
                serverProcess,
                new RegExp(
                    `Setting up the managed SSH key failed: device=${deviceId}, status=502, error=The device rejected every credential`,
                ),
            );

            const wrongPassword = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: hostKey.fingerprint,
                    password: `wrong-${fixture.suffix}`,
                }),
            );

            // A rejected password is the device's answer, not a bad request.
            expect(wrongPassword.status).toBe(502);
            // The browser learns that the typed password was rejected and why, not only
            // that the last ssh attempt failed.
            expect(wrongPassword.message).toContain(
                "The device rejected every credential the server tried (this server's own SSH keys, the typed password)",
            );
            expect(wrongPassword.message).toMatch(
                /OpenSSH: .*permission denied/i,
            );
            // The server log records each rejected credential and the failed operation,
            // so a reported failure can be traced without reproducing it.
            await rejectionLogged;
            await failureLogged;
            // The typed password never reaches the browser's error or the server log.
            expect(wrongPassword.message).not.toContain(
                `wrong-${fixture.suffix}`,
            );
            expect(
                fixture.processManager.getStdout(fixture.serverPid),
            ).not.toContain(`wrong-${fixture.suffix}`);
            // A failed login must not leave a generated key behind.
            expect(localKeyFiles(fixture, deviceId)).toEqual([]);

            const enrolled = await fixture.apiClient.enrollSshKey(deviceId, {
                host_key_fingerprint: hostKey.fingerprint,
                password,
            });

            // The first key of a device is a setup, not a rotation.
            expect(enrolled.rotated).toBe(false);

            const dir = deviceDir(fixture, deviceId);
            // Only the current private key is stored: the staged key was renamed into
            // place, and there is no public key file to keep in sync with it.
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);
            // Key material must never be reachable by other local users.
            expect(modeOf(fixture.sshDataDir)).toBe(0o700);
            expect(modeOf(dir)).toBe(0o700);
            // ssh refuses a private key that others can read.
            expect(modeOf(join(dir, "id_ed25519"))).toBe(0o600);
            expect(modeOf(join(dir, "known_hosts"))).toBe(0o600);

            const knownHosts = readFileSync(join(dir, "known_hosts"), "utf8");

            const pinned = knownHosts.match(
                new RegExp(`^${deviceId} (\\S+) (\\S+)\\n$`),
            );

            // The pin is one line keyed by the device id, the HostKeyAlias ssh uses.
            expect(pinned?.[1]).toBe(hostKey.key_type);
            // The pinned key is exactly the one the user confirmed.
            expect(fingerprintOf(pinned?.[2] ?? "")).toBe(hostKey.fingerprint);

            const publicKey = await localPublicKey(fixture, deviceId);

            // The response fingerprint lets the user find the key in the device's logs.
            expect(enrolled.fingerprint).toBe(fingerprintOf(publicKey[1]));

            const entry = configEntry(fixture, deviceId);
            // The config records that the device uses its managed key ...
            expect(entry).toMatch(/^managed_ssh_key = true$/m);
            // ... and the typed password is used once, never stored.
            expect(entry).not.toMatch(/^password\s*=/m);
            expect(readFileSync(fixture.configPath, "utf8")).not.toContain(
                password,
            );
            // Nor may it leak into the server's logs.
            expect(
                fixture.processManager.getStdout(fixture.serverPid),
            ).not.toContain(password);

            const configuration =
                await fixture.apiClient.getSshAgentConfiguration(deviceId);

            // The edit form offers rotation and removal instead of the first setup.
            expect(configuration).toMatchObject({
                has_managed_ssh_key: true,
                has_pinned_host_key: true,
                has_password: false,
            });

            const lines = await remoteDeviceLines(SSH_PASSWORD_USER, deviceId);
            // Exactly the restricted line for this key is installed on the device, marked
            // with the device id, the account and the key's fingerprint.
            expect(lines).toEqual([
                `restrict,port-forwarding ${publicKey[0]} ${publicKey[1]} ${keyMarker(deviceId, enrolled.fingerprint)}`,
            ]);

            const connected = await startAndWaitConnected(fixture, deviceId);
            const echo = await connected.echo("managed-key-typed");
            // The agent session, which also uploaded the binary, logged in with the new key.
            expect(echo.message).toBe("managed-key-typed");
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "enrolls with the stored password and removes it from config.toml",
        async () => {
            const fixture = await startKeyFixture({
                label: "stored",
                sshUsers: [SSH_PASSWORD_USER],
            });

            const password = fixturePassword();

            const deviceId = await createDevice(fixture, {
                user: SSH_PASSWORD_USER,
                name: `ssh-keys-stored-${fixture.suffix}`,
                password,
            });

            // The precondition: the device starts out with a stored password.
            expect(configEntry(fixture, deviceId)).toMatch(/^password\s*=/m);

            await enrollConfirmed(fixture, deviceId);

            const entry = configEntry(fixture, deviceId);
            // The stored password logged in, so no password had to be typed ...
            expect(entry).toMatch(/^managed_ssh_key = true$/m);
            // ... and it is deleted, because a device uses a key or a password, never both.
            expect(entry).not.toMatch(/^password\s*=/m);
            expect(readFileSync(fixture.configPath, "utf8")).not.toContain(
                password,
            );
            // The edit form must no longer show password auth.
            expect(
                (await fixture.apiClient.getSshAgentConfiguration(deviceId))
                    .has_password,
            ).toBe(false);
            // The key is installed exactly once.
            expect(
                await remoteDeviceLines(SSH_PASSWORD_USER, deviceId),
            ).toHaveLength(1);
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );
});

describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")("managed SSH keys", () => {
    test(
        "bootstraps with the server user's keys and never falls back to them later",
        async () => {
            const fixture = await startKeyFixture({
                label: "own-keys",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-own-${fixture.suffix}`,
            });

            const enrolled = await enrollConfirmed(fixture, deviceId);
            // The ~/.ssh/config IdentityFile got the enrollment in without any password.
            expect(enrolled.rotated).toBe(false);

            const connected = await startAndWaitConnected(fixture, deviceId);
            await connected.shutdown();

            await sshTestCommand(
                `sed -i ${shellQuote(`/redoor:${deviceId}:/d`)} "$HOME/.ssh/authorized_keys"`,
            );
            // The precondition: the managed key no longer works on the device.
            expect(await remoteDeviceLines(SSH_TEST_USER, deviceId)).toEqual(
                [],
            );

            const result = await startAndWaitForIssue(fixture, deviceId);
            // The IdentityFile of the redoor-ssh-test alias is still authorized, so connecting
            // would mean ssh offered the user's key instead of only the managed one.
            expect(result.connected).toBe(false);
            // The user sees that the login was refused, not some unrelated failure.
            expect(result.issue).toMatch(/permission denied/i);
            await (await findAgent(fixture, deviceId)).shutdown();

            const rotation = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                }),
            );

            // Rotation must not use the still-authorized user key to replace a revoked key.
            expect(rotation.status).toBe(502);
            expect(await remoteDeviceLines(SSH_TEST_USER, deviceId)).toEqual(
                [],
            );
            // A rejected rotation leaves the previous key and config available for recovery,
            // and its staged key is deleted again.
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);
            expect(
                fingerprintOf((await localPublicKey(fixture, deviceId))[1]),
            ).toBe(enrolled.fingerprint);
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "rotation keeps a connected device connected and leaves one remote line and one local key",
        async () => {
            const fixture = await startKeyFixture({
                label: "rotate",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-rotate-${fixture.suffix}`,
            });

            const first = await enrollConfirmed(fixture, deviceId);
            const connected = await startAndWaitConnected(fixture, deviceId);

            // A pinned device needs no new confirmation for a rotation.
            const second = await fixture.apiClient.enrollSshKey(deviceId, {
                host_key_fingerprint: null,
                password: null,
            });

            // Enrolling a device that has a key replaces it.
            expect(second.rotated).toBe(true);
            // The rotation produced a new key, not the old one again.
            expect(second.fingerprint).not.toBe(first.fingerprint);

            const during = await findAgent(fixture, deviceId);
            // Rotation only renames the key file and writes no config, so the running agent
            // is not stopped: it is still the same connection ...
            expect(during.status).toBe("connected");
            expect(during.connectionId).toBe(connected.connectionId);
            // ... and its tunnel still works after the old key's line was removed.
            expect((await during.echo("after-rotation")).message).toBe(
                "after-rotation",
            );

            const lines = await remoteDeviceLines(SSH_TEST_USER, deviceId);
            // The old line is removed once the new key is current.
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain(keyMarker(deviceId, second.fingerprint));
            // Locally the new key replaced the old one in place; no staged key is left.
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);
            expect(
                fingerprintOf((await localPublicKey(fixture, deviceId))[1]),
            ).toBe(second.fingerprint);
            // The config is unchanged: it records only that a managed key is used.
            expect(configEntry(fixture, deviceId)).toMatch(
                /^managed_ssh_key = true$/m,
            );

            await during.shutdown();

            const reconnected = await startAndWaitConnected(
                fixture,
                deviceId,
                connected.connectionId,
            );

            // A new connection logs in with the rotated key; the old one is revoked.
            expect(reconnected.status).toBe("connected");
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "keeps unrelated authorized_keys lines byte for byte and drops stale ones",
        async () => {
            const fixture = await startKeyFixture({
                label: "preserve",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-preserve-${fixture.suffix}`,
            });

            const unrelatedMarker = `redoor-test-unrelated-${fixture.suffix}`;
            const unrelated = `ssh-ed25519   ${randomEd25519PublicKey()}  ${unrelatedMarker}\t#  odd   spacing `;
            const staleKey = randomEd25519PublicKey();
            const stale = `restrict,port-forwarding ssh-ed25519 ${staleKey} ${keyMarker(deviceId, fingerprintOf(staleKey))}`;

            onTestFinished(async () => {
                await sshTestCommand(
                    `sed -i ${shellQuote(`/${unrelatedMarker}/d`)} "$HOME/.ssh/authorized_keys"`,
                );
            }, CLEANUP_TIMEOUT_MS);
            await sshTestCommand(
                `printf '%s\\n' ${shellQuote(unrelated)} ${shellQuote(stale)} >> "$HOME/.ssh/authorized_keys"`,
            );

            const before = await remoteAuthorizedKeys(SSH_TEST_USER);
            // The precondition: both test lines are on the device.
            expect(before).toContain(`${unrelated}\n${stale}\n`);

            const enrolled = await enrollConfirmed(fixture, deviceId);
            const after = await remoteAuthorizedKeys(SSH_TEST_USER);
            const [newLine] = await remoteDeviceLines(SSH_TEST_USER, deviceId);
            // Only the new line remains for this device.
            expect(newLine).toContain(keyMarker(deviceId, enrolled.fingerprint));
            // Every other line, including odd whitespace, is copied unchanged and the stale
            // line of this device is dropped.
            expect(after).toBe(
                `${before.replace(`${stale}\n`, "")}${newLine}\n`,
            );
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "refuses a symlinked authorized_keys and leaves it untouched",
        async () => {
            const fixture = await startKeyFixture({
                label: "symlink",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-symlink-${fixture.suffix}`,
            });

            const realFile = `authorized_keys.redoor-test-${fixture.suffix}`;
            const tempLink = `.authorized_keys.link-${fixture.suffix}`;

            // Restores the regular file atomically, so logins never see it missing.
            onTestFinished(async () => {
                await sshTestCommand(
                    `cd "$HOME/.ssh" && if [ -L authorized_keys ] && [ -f ${shellQuote(realFile)} ]; then mv -fT ${shellQuote(realFile)} authorized_keys; fi; rm -f ${shellQuote(tempLink)}`,
                );
            }, CLEANUP_TIMEOUT_MS);
            // The link points at a copy, so the account's own logins keep working.
            await sshTestCommand(
                `cd "$HOME/.ssh" && cp -p authorized_keys ${shellQuote(realFile)} && ln -s ${shellQuote(realFile)} ${shellQuote(tempLink)} && mv -fT ${shellQuote(tempLink)} authorized_keys`,
            );

            const before = await remoteAuthorizedKeys(SSH_TEST_USER);

            const failure = await apiFailure(
                enrollConfirmed(fixture, deviceId),
            );

            // The install step on the device failed, which is a device-side error.
            expect(failure.status).toBe(502);
            // The message says why, so the user can fix the setup that owns the file.
            expect(failure.message).toContain("not a regular file");
            // The link is still a link ...
            expect(
                (
                    await sshTestCommand(
                        `if [ -L "$HOME/.ssh/authorized_keys" ]; then echo link; fi`,
                    )
                ).trim(),
            ).toBe("link");
            // ... and the file it points at is unchanged.
            expect(await remoteAuthorizedKeys(SSH_TEST_USER)).toBe(before);
            // The staged key is deleted again because it was never installed.
            expect(localKeyFiles(fixture, deviceId)).toEqual([]);
            // The config does not claim a key that does not work.
            expect(configEntry(fixture, deviceId)).not.toContain(
                "managed_ssh_key",
            );
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "a failed config write after the key commit rolls back the key everywhere",
        async () => {
            const fixture = await startKeyFixture({
                label: "commit-fail",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-commit-fail-${fixture.suffix}`,
            });

            const hostKey = await fixture.apiClient.getSshHostKey(deviceId);

            // config.toml lives directly in the read-only home, while the key store is in a
            // writable directory below it, so the key rename succeeds but the config write
            // after it fails.
            onTestFinished(() => chmodSync(fixture.home, 0o700));
            chmodSync(fixture.home, 0o500);

            const failure = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: hostKey.fingerprint,
                    password: null,
                }),
            );

            chmodSync(fixture.home, 0o700);
            // The config write is a server-side failure.
            expect(failure.status).toBe(500);
            // The config never claimed the key ...
            expect(configEntry(fixture, deviceId)).not.toContain(
                "managed_ssh_key",
            );
            // ... so the key renamed into place before the write is deleted again, ...
            expect(localKeyFiles(fixture, deviceId)).toEqual([]);
            // ... and its line is removed from the device with the bootstrap credential.
            expect(await remoteDeviceLines(SSH_TEST_USER, deviceId)).toEqual(
                [],
            );

            await enrollConfirmed(fixture, deviceId);
            // A later setup succeeds normally.
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);
            expect(
                await remoteDeviceLines(SSH_TEST_USER, deviceId),
            ).toHaveLength(1);
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "device edits keep, clear or drop the key and pin as the change requires",
        async () => {
            const fixture = await startKeyFixture({
                label: "edits",
                sshUsers: [SSH_TEST_USER],
            });

            const name = `ssh-keys-edits-${fixture.suffix}`;

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name,
            });

            await enrollConfirmed(fixture, deviceId);
            const renamed = `${name}-renamed`;

            await fixture.apiClient.updateSshAgent(
                deviceId,
                updateRequest({
                    target: SSH_TEST_HOST,
                    username: SSH_TEST_USER,
                    name: renamed,
                    ssh_port: 22,
                }),
            );
            const renamedEntry = configEntry(fixture, deviceId);
            // A rename or port edit is the same account, so the key must stay ...
            expect(renamedEntry).toMatch(/^managed_ssh_key = true$/m);
            // ... while the edit itself was applied.
            expect(renamedEntry).toContain(`name = "${renamed}"`);
            expect(renamedEntry).toMatch(/^ssh_port = 22$/m);

            const connected = await startAndWaitConnected(fixture, deviceId);
            // The key is stored under the device id and the pin under the HostKeyAlias, so
            // neither the new name nor the explicit port breaks the login.
            expect(connected.name).toBe(renamed);
            await connected.shutdown();

            const withPassword = await apiFailure(
                fixture.apiClient.updateSshAgent(
                    deviceId,
                    updateRequest({
                        target: SSH_TEST_HOST,
                        username: SSH_TEST_USER,
                        name: renamed,
                        password: "not-allowed",
                    }),
                ),
            );

            // A device uses a managed key or a password, never both.
            expect(withPassword.status).toBe(400);
            // The rejected edit kept the key.
            expect(configEntry(fixture, deviceId)).toMatch(
                /^managed_ssh_key = true$/m,
            );

            await fixture.apiClient.updateSshAgent(
                deviceId,
                updateRequest({
                    target: SSH_TEST_HOST,
                    username: SSH_PASSWORD_USER,
                    name: renamed,
                }),
            );
            // The key is not installed for the other account, so it is dropped ...
            expect(configEntry(fixture, deviceId)).not.toContain(
                "managed_ssh_key",
            );
            expect(localKeyFiles(fixture, deviceId)).toEqual([]);
            // ... but the machine is the same, so the pin stays.
            expect(
                existsSync(join(deviceDir(fixture, deviceId), "known_hosts")),
            ).toBe(true);
            expect(
                await fixture.apiClient.getSshAgentConfiguration(deviceId),
            ).toMatchObject({
                has_managed_ssh_key: false,
                has_pinned_host_key: true,
            });

            const resolved = await $`ssh -G ${SSH_TEST_HOST}`.quiet();
            const address = resolved.stdout.match(/^hostname (\S+)$/m)?.[1];

            if (address === undefined) {
                throw new Error(`ssh -G ${SSH_TEST_HOST} printed no hostname`);
            }

            // The precondition: the new target is a different string for the same machine.
            expect(address).not.toBe(SSH_TEST_HOST);

            await fixture.apiClient.updateSshAgent(
                deviceId,
                updateRequest({
                    target: address,
                    username: SSH_TEST_USER,
                    name: renamed,
                }),
            );
            // A new target may be another machine, so the pin is dropped with the device dir.
            expect(existsSync(deviceDir(fixture, deviceId))).toBe(false);
            expect(
                await fixture.apiClient.getSshAgentConfiguration(deviceId),
            ).toMatchObject({
                has_managed_ssh_key: false,
                has_pinned_host_key: false,
            });
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "a concurrent enrollment of the same device gets 409",
        async () => {
            const fixture = await startKeyFixture({
                label: "concurrent",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-concurrent-${fixture.suffix}`,
            });

            const hostKey = await fixture.apiClient.getSshHostKey(deviceId);

            const request = {
                host_key_fingerprint: hostKey.fingerprint,
                password: null,
            };

            const results = await Promise.allSettled([
                fixture.apiClient.enrollSshKey(deviceId, request),
                fixture.apiClient.enrollSshKey(deviceId, request),
            ]);

            const statuses = results
                .map((result) => {
                    if (result.status === "fulfilled") {
                        return 200;
                    }

                    if (result.reason instanceof ApiError) {
                        return result.reason.status;
                    }

                    throw result.reason;
                })
                .sort((left, right) => left - right);

            // One request runs, the other is refused instead of racing over the same files.
            expect(statuses).toEqual([200, 409]);
            // Only the running request installed a key.
            expect(
                await remoteDeviceLines(SSH_TEST_USER, deviceId),
            ).toHaveLength(1);
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "a changed host key blocks the device until it is re-pinned",
        async () => {
            const fixture = await startKeyFixture({
                label: "host-key",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-host-key-${fixture.suffix}`,
            });

            const realHostKey = await fixture.apiClient.getSshHostKey(deviceId);
            await fixture.apiClient.enrollSshKey(deviceId, {
                host_key_fingerprint: realHostKey.fingerprint,
                password: null,
            });

            const fakeKey = randomEd25519PublicKey();
            const fakeFingerprint = fingerprintOf(fakeKey);

            const knownHostsPath = join(
                deviceDir(fixture, deviceId),
                "known_hosts",
            );

            // Simulates the device presenting another key than the pinned one.
            writeFileSync(
                knownHostsPath,
                `${deviceId} ssh-ed25519 ${fakeKey}\n`,
                {
                    mode: 0o600,
                },
            );

            const blocked = await startAndWaitForIssue(fixture, deviceId);
            // ssh must refuse the unknown key rather than connect.
            expect(blocked.connected).toBe(false);
            // The issue explains the cause ...
            expect(blocked.issue?.startsWith("SSH host key changed.")).toBe(
                true,
            );
            // ... with both fingerprints, so the user can check which one is right.
            expect(blocked.issue).toContain(realHostKey.fingerprint);
            expect(blocked.issue).toContain(fakeFingerprint);
            await (await findAgent(fixture, deviceId)).shutdown();

            const probed = await fixture.apiClient.getSshHostKey(deviceId);
            // The probe shows the presented key next to the different pinned one.
            expect(probed.fingerprint).toBe(realHostKey.fingerprint);
            expect(probed.pinned_fingerprint).toBe(fakeFingerprint);

            const rotation = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                }),
            );

            // Key operations against a changed host must not send credentials either.
            expect(rotation.status).toBe(409);

            const wrongPin = await apiFailure(
                fixture.apiClient.pinSshHostKey(deviceId, {
                    host_key_fingerprint: fakeFingerprint,
                }),
            );

            // Only the key the device presents right now can be pinned.
            expect(wrongPin.status).toBe(409);
            // The failed pin left the file alone.
            expect(readFileSync(knownHostsPath, "utf8")).toContain(fakeKey);

            const repinned = await fixture.apiClient.pinSshHostKey(deviceId, {
                host_key_fingerprint: realHostKey.fingerprint,
            });

            // The confirmed key is now pinned.
            expect(repinned.fingerprint).toBe(realHostKey.fingerprint);

            const connected = await startAndWaitConnected(fixture, deviceId);
            // Re-pinning is all it takes to recover; the managed key still works.
            expect(connected.status).toBe("connected");
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "removal deletes the remote line and local key but keeps the pin",
        async () => {
            const fixture = await startKeyFixture({
                label: "remove",
                sshUsers: [SSH_TEST_USER],
            });

            const deviceId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name: `ssh-keys-remove-${fixture.suffix}`,
            });

            await enrollConfirmed(fixture, deviceId);

            const keyFile = join(deviceDir(fixture, deviceId), "id_ed25519");
            const hiddenKeyFile = `${keyFile}.hidden`;
            renameSync(keyFile, hiddenKeyFile);

            const rotationWithoutKey = await apiFailure(
                fixture.apiClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                }),
            );

            renameSync(hiddenKeyFile, keyFile);
            // Rotation logs in only with the current key, so a missing key is a user-fixable
            // state with a way out, not an opaque server error.
            expect(rotationWithoutKey.status).toBe(400);
            expect(rotationWithoutKey.message).toContain(
                "Remove the key and set it up again",
            );
            // The failed rotation changed nothing on the device or in the config.
            expect(
                await remoteDeviceLines(SSH_TEST_USER, deviceId),
            ).toHaveLength(1);
            expect(configEntry(fixture, deviceId)).toMatch(
                /^managed_ssh_key = true$/m,
            );
            // Nothing was staged, because the current key is checked first.
            expect(localKeyFiles(fixture, deviceId)).toEqual(["id_ed25519"]);

            onTestFinished(() => chmodSync(fixture.home, 0o700));
            chmodSync(fixture.home, 0o500);

            const failedRemoval = await apiFailure(
                fixture.apiClient.removeSshKey(deviceId),
            );

            chmodSync(fixture.home, 0o700);
            // Revocation happens only after persistence, so a failed write keeps login working.
            expect(failedRemoval.status).toBe(500);
            expect(
                await remoteDeviceLines(SSH_TEST_USER, deviceId),
            ).toHaveLength(1);
            expect(configEntry(fixture, deviceId)).toContain("managed_ssh_key");

            const removal = await fixture.apiClient.removeSshKey(deviceId);
            // The device was reachable with the key, so its line was removed there.
            expect(removal).toEqual({
                removed_from_device: true,
                device_error: null,
            });
            // No line of this device is left on the host.
            expect(await remoteDeviceLines(SSH_TEST_USER, deviceId)).toEqual(
                [],
            );
            // The key is gone locally ...
            expect(localKeyFiles(fixture, deviceId)).toEqual([]);
            // ... but the pin stays, so a new setup needs no host key confirmation.
            expect(
                existsSync(join(deviceDir(fixture, deviceId), "known_hosts")),
            ).toBe(true);
            // The config no longer points at a key.
            expect(configEntry(fixture, deviceId)).not.toContain(
                "managed_ssh_key",
            );
            expect(
                await fixture.apiClient.getSshAgentConfiguration(deviceId),
            ).toMatchObject({
                has_managed_ssh_key: false,
                has_pinned_host_key: true,
            });

            const fakeKey = randomEd25519PublicKey();
            writeFileSync(
                join(deviceDir(fixture, deviceId), "known_hosts"),
                `${deviceId} ssh-ed25519 ${fakeKey}
`,
                { mode: 0o600 },
            );
            const blocked = await startAndWaitForIssue(fixture, deviceId);
            // Removing the login key must not bypass the host pin for fallback credentials.
            expect(blocked.connected).toBe(false);
            expect(blocked.issue).toContain("SSH host key changed.");
            await (await findAgent(fixture, deviceId)).shutdown();
            // A second removal has nothing to remove.
            expect(
                (await apiFailure(fixture.apiClient.removeSshKey(deviceId)))
                    .status,
            ).toBe(404);
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );

    test(
        "a new device with a deleted device's name does not inherit its key or pin",
        async () => {
            const fixture = await startKeyFixture({
                label: "reuse",
                sshUsers: [SSH_TEST_USER],
            });

            const name = `ssh-keys-reuse-${fixture.suffix}`;

            const oldId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name,
            });

            await enrollConfirmed(fixture, oldId);

            // Enrollment installed exactly one line for the device.
            expect(await remoteDeviceLines(SSH_TEST_USER, oldId)).toHaveLength(
                1,
            );

            const wrongRoute = await apiFailure(
                fixture.apiClient.deleteManagedAgent(oldId, "local"),
            );

            // A route that does not own this device must not revoke its remote key.
            expect(wrongRoute.status).toBe(404);
            expect(await remoteDeviceLines(SSH_TEST_USER, oldId)).toHaveLength(
                1,
            );

            onTestFinished(() => chmodSync(fixture.home, 0o700));
            chmodSync(fixture.home, 0o500);

            const failedDelete = await apiFailure(
                fixture.apiClient.deleteManagedAgent(oldId, "ssh"),
            );

            chmodSync(fixture.home, 0o700);
            // Failed persistence must leave both the config and its authorized key intact.
            expect(failedDelete.status).toBe(500);
            expect(configEntry(fixture, oldId)).toContain("managed_ssh_key");
            expect(await remoteDeviceLines(SSH_TEST_USER, oldId)).toHaveLength(
                1,
            );

            await fixture.apiClient.deleteManagedAgent(oldId, "ssh");
            // A deleted device's key and pin are deleted with it.
            expect(existsSync(deviceDir(fixture, oldId))).toBe(false);
            // Deleting a reachable device also removes its line from the device, like the
            // "Remove key" action, so no orphaned line is left behind.
            expect(await remoteDeviceLines(SSH_TEST_USER, oldId)).toEqual([]);

            const newId = await createDevice(fixture, {
                user: SSH_TEST_USER,
                name,
            });

            // Names are reusable, ids never are.
            expect(newId).not.toBe(oldId);
            // Nothing is stored for the new device yet.
            expect(existsSync(deviceDir(fixture, newId))).toBe(false);
            expect(
                await fixture.apiClient.getSshAgentConfiguration(newId),
            ).toMatchObject({
                has_managed_ssh_key: false,
                has_pinned_host_key: false,
            });
            // The new device must go through host key confirmation again.
            expect(
                (await fixture.apiClient.getSshHostKey(newId))
                    .pinned_fingerprint,
            ).toBeNull();
        },
        SSH_KEY_TEST_TIMEOUT_MS,
    );
});

describe("managed SSH key access", () => {
    test("SSH targets cannot inject local client options", async () => {
        const fixture = await startKeyFixture({
            label: "options",
            sshUsers: [],
        });

        const marker = join(fixture.home, "must-not-exist");

        const created = await fixture.apiClient.createSshAgent({
            target: `-oProxyCommand=touch ${shellQuote(marker)}`,
            username: null,
            ssh_port: null,
            name: `ssh-keys-options-${fixture.suffix}`,
            remote_bin: null,
            home: null,
            log: null,
            password: null,
            clear_password: null,
        });

        const failure = await apiFailure(
            fixture.apiClient.getSshHostKey(created.agent.id),
        );

        // A malformed destination fails as a host; its text must never execute on the server.
        expect(failure.status).toBe(502);
        expect(existsSync(marker)).toBe(false);
    }, 30_000);

    test("access tokens get 403 on every SSH key endpoint", async () => {
        const fixture = await startKeyFixture({ label: "token", sshUsers: [] });

        // Never contacted: the token is rejected before the handler runs.
        const created = await fixture.apiClient.createSshAgent({
            target: "ssh-keys-unreachable.invalid",
            username: "nobody",
            ssh_port: null,
            name: `ssh-keys-token-${fixture.suffix}`,
            remote_bin: null,
            home: null,
            log: null,
            password: null,
            clear_password: null,
        });

        const deviceId = created.agent.id;

        const { token } = await createAccessToken(fixture.apiClient, {
            permissions: ALL_PERMISSIONS,
        });

        const tokenClient = new ApiClient(
            `http://127.0.0.1:${VITEST_SERVER_PORT}`,
        );

        tokenClient.setAccessToken(token);

        const statuses = await Promise.all(
            [
                tokenClient.getSshHostKey(deviceId),
                tokenClient.enrollSshKey(deviceId, {
                    host_key_fingerprint: null,
                    password: null,
                }),
                tokenClient.pinSshHostKey(deviceId, {
                    host_key_fingerprint: "SHA256:x",
                }),
                tokenClient.removeSshKey(deviceId),
            ].map(async (call) => (await apiFailure(call)).status),
        );

        // Even a token with every permission cannot change what the server logs in to.
        expect(statuses).toEqual([403, 403, 403, 403]);
        // The same request with the session reaches the handler, so the 403 is about the
        // token and not a missing route.
        expect(
            (await apiFailure(fixture.apiClient.removeSshKey(deviceId))).status,
        ).toBe(404);
    }, 30_000);
});
