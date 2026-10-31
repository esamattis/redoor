/**
 * Fixture and helpers for the managed SSH key integration tests, kept apart from the tests
 * so the test file stays readable.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { $ } from "zx";
import type { UpdateSshAgentRequest } from "#bindings/UpdateSshAgentRequest";
import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
    waitForValue,
} from "./test-utils";
import {
    SSH_TEST_HOST,
    SSH_TEST_USER,
    cleanupSshTest,
    shellQuote,
    sshCommandWithPassword,
    sshTestCommand,
} from "./ssh-test-utils";

/** Budget for a managed SSH device to provision and connect, which uploads the binary. */
export const CONNECT_TIMEOUT_MS = 60_000;

/** Budget for one test: several SSH round trips per enrollment plus one or two connects. */
export const SSH_KEY_TEST_TIMEOUT_MS = 240_000;

/** Budget for one cleanup hook, which may open several SSH connections. */
export const CLEANUP_TIMEOUT_MS = 60_000;

/** A server with an empty `[[agents]]` list whose SSH key store lives in a temp HOME. */
export type KeyFixture = {
    apiClient: ApiClient;
    configPath: string;
    home: string;
    /**
     * `<HOME>/.local/share/<app>/users/<account>/ssh`, where the server keeps the login
     * account's keys and pinned host keys.
     */
    sshDataDir: string;
    /** `<HOME>/.local/share/<app>/users/<account>`, holding the account's vault. */
    accountDir: string;
    /** The server's own log file. */
    serverLog: string;
    processManager: ProcessManager;
    serverPid: number;
    suffix: string;
};

/** Runs a command as `user` on the SSH test host and returns stdout. */
export async function sshAs(user: string, command: string): Promise<string> {
    if (user === SSH_TEST_USER) {
        return sshTestCommand(command);
    }

    return sshCommandWithPassword(user, command);
}

/**
 * Starts a server for one test and removes everything it did locally and on the SSH test
 * host when the test finishes. `sshUsers` lists the remote accounts the test touches, so
 * leftovers of an interrupted run are cleared before the test and again after it.
 */
export async function startKeyFixture(options: {
    label: string;
    sshUsers: string[];
}): Promise<KeyFixture> {
    const suffix = `${process.pid}-${Date.now()}`;
    const appName = `redoor-ssh-keys-${options.label}-${suffix}`;
    const remoteRoot = `/tmp/redoor-ssh-keys-${options.label}-${suffix}`;
    const processManager = new ProcessManager();
    const home = mkdtempSync(join(tmpdir(), "redoor-ssh-keys space%-"));
    const configPath = join(home, "config.toml");

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}
`,
    );

    // Hooks run in reverse registration order: stop the server, then the remote cleanup,
    // and only then delete the local home whose logs help debugging a failed cleanup.
    onTestFinished(() => {
        rmSync(home, { recursive: true, force: true });
    });

    const cleanRemote = async () => {
        for (const user of options.sshUsers) {
            await cleanupSshTest({
                remoteRoot,
                agentAppNames: [appName],
                sshCommand: (command) => sshAs(user, command),
            });
        }
    };

    onTestFinished(cleanRemote, CLEANUP_TIMEOUT_MS);
    onTestFinished(() => processManager.killAll(), CLEANUP_TIMEOUT_MS);

    await cleanRemote();

    const serverPid = processManager.spawn(
        SERVER_PATH,
        ["server", "--config", configPath],
        {
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: appName,
            },
        },
    );

    await waitForPort(VITEST_SERVER_PORT);

    const apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    const dataDir = join(home, ".local", "share", appName);
    const accountDir = join(dataDir, "users", TEST_USERNAME);

    return {
        apiClient,
        configPath,
        home,
        sshDataDir: join(accountDir, "ssh"),
        accountDir,
        serverLog: join(dataDir, "server.log"),
        processManager,
        serverPid,
        suffix,
    };
}

/** Builds a complete update body so tests only spell out the fields they change. */
export function updateRequest(
    overrides: Partial<UpdateSshAgentRequest> &
        Pick<UpdateSshAgentRequest, "target" | "username" | "name">,
): UpdateSshAgentRequest {
    return {
        ssh_port: null,
        remote_bin: null,
        home: null,
        log: null,
        password: null,
        clear_password: null,
        ...overrides,
    };
}

/**
 * Removes every `authorized_keys` line `device` installed for `user`, so a test that fails
 * half way, or deletes the device without removing its key, leaves nothing on the host.
 * A symlinked file is left alone because `sed -i` would replace the link with a copy.
 */
export async function removeRemoteDeviceLines(
    user: string,
    deviceId: string,
): Promise<void> {
    await sshAs(
        user,
        `f="$HOME/.ssh/authorized_keys"; if [ -f "$f" ] && [ ! -L "$f" ]; then sed -i ${shellQuote(`/redoor:${deviceId}:/d`)} "$f"; fi`,
    );
}

/** Adds a dormant SSH device for `user` and removes its remote lines when the test ends. */
export async function createDevice(
    fixture: KeyFixture,
    options: { user: string; name: string; password?: string },
): Promise<string> {
    const response = await fixture.apiClient.createSshAgent({
        target: SSH_TEST_HOST,
        username: options.user,
        ssh_port: null,
        name: options.name,
        remote_bin: null,
        home: null,
        log: join(fixture.home, `${options.name}.log`),
        password: options.password ?? null,
        clear_password: null,
    });

    const deviceId = response.agent.id;
    onTestFinished(
        () => removeRemoteDeviceLines(options.user, deviceId),
        CLEANUP_TIMEOUT_MS,
    );

    return deviceId;
}

/** The whole `authorized_keys` of `user` on the SSH test host, empty when it is missing. */
export async function remoteAuthorizedKeys(user: string): Promise<string> {
    return sshAs(user, `cat "$HOME/.ssh/authorized_keys" 2>/dev/null || true`);
}

/** The `authorized_keys` marker of a key the test account installed for `deviceId`. */
export function keyMarker(deviceId: string, fingerprint: string): string {
    return `redoor:${deviceId}:${TEST_USERNAME}:${fingerprint}`;
}

/** The `authorized_keys` lines of `user` that carry `deviceId`'s marker. */
export async function remoteDeviceLines(
    user: string,
    deviceId: string,
): Promise<string[]> {
    return (await remoteAuthorizedKeys(user))
        .split("\n")
        .filter((line) => line.includes(`redoor:${deviceId}:`));
}

/** The `[[agents]]` table of `deviceId` as written in config.toml. */
export function configEntry(fixture: KeyFixture, deviceId: string): string {
    const entry = readFileSync(fixture.configPath, "utf8")
        .split("[[agents]]")
        .find((table) => table.includes(`id = "${deviceId}"`));

    if (entry === undefined) {
        throw new Error(`config.toml has no entry for ${deviceId}`);
    }

    return entry;
}

/** Directory holding the pinned host key and the key files of `deviceId`. */
export function deviceDir(fixture: KeyFixture, deviceId: string): string {
    return join(fixture.sshDataDir, deviceId);
}

/**
 * Every file stored for `deviceId` except its pinned host key, sorted, so tests see the
 * current key, a staged `.next` key and anything left behind by an unfinished write.
 */
export function localKeyFiles(fixture: KeyFixture, deviceId: string): string[] {
    const dir = deviceDir(fixture, deviceId);

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => name !== "known_hosts")
        .sort();
}

/**
 * The public key (`[type, base64 blob]`) of the device's current private key. redoor keeps
 * no `.pub` file, so it is derived the same way, from the private key.
 */
export async function localPublicKey(
    fixture: KeyFixture,
    deviceId: string,
): Promise<[string, string]> {
    const path = join(deviceDir(fixture, deviceId), "id_ed25519");
    const output = await $`ssh-keygen -y -f ${path}`.quiet();
    const [keyType, blob] = output.stdout.trim().split(" ");

    if (keyType === undefined || blob === undefined) {
        throw new Error(`ssh-keygen printed no public key for ${path}`);
    }

    return [keyType, blob];
}

/** Permission bits of a path, for comparing with the modes the key store promises. */
export function modeOf(path: string): number {
    return statSync(path).mode & 0o777;
}

/** `SHA256:` fingerprint of a base64 OpenSSH public key blob, as `ssh-keygen -l` prints it. */
export function fingerprintOf(base64Blob: string): string {
    const digest = createHash("sha256")
        .update(Buffer.from(base64Blob, "base64"))
        .digest("base64");

    return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Encodes one SSH wire-format string: a 32-bit big-endian length and the bytes. */
export function sshString(value: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);

    return Buffer.concat([length, value]);
}

/**
 * A fresh, valid ed25519 public key blob in base64. The private half is discarded, so
 * adding it to `authorized_keys` grants nobody access.
 */
export function randomEd25519PublicKey(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });

    if (jwk.x === undefined) {
        throw new Error("ed25519 JWK has no public key");
    }

    return Buffer.concat([
        sshString(Buffer.from("ssh-ed25519")),
        sshString(Buffer.from(jwk.x, "base64url")),
    ]).toString("base64");
}

/** Resolves to the HTTP status and message of a failed API call. */
export async function apiFailure(
    call: Promise<unknown>,
): Promise<{ status: number; message: string }> {
    try {
        await call;
    } catch (error) {
        if (error instanceof ApiError) {
            return { status: error.status, message: error.message };
        }

        throw error;
    }

    throw new Error("API call unexpectedly succeeded");
}

/** Probes the device's host key and enrolls with it confirmed, like the UI does. */
export async function enrollConfirmed(
    fixture: KeyFixture,
    deviceId: string,
    password: string | null = null,
) {
    const hostKey = await fixture.apiClient.getSshHostKey(deviceId);

    return fixture.apiClient.enrollSshKey(deviceId, {
        host_key_fingerprint: hostKey.fingerprint,
        password,
    });
}

/** Finds the device's current inventory record. */
export async function findAgent(fixture: KeyFixture, deviceId: string) {
    const agent = (await fixture.apiClient.listAgents()).find(
        (entry) => entry.id === deviceId,
    );

    if (agent === undefined) {
        throw new Error(`device ${deviceId} missing from the inventory`);
    }

    return agent;
}

/** Starts the device and waits for a connection newer than `previousConnectionId`. */
export async function startAndWaitConnected(
    fixture: KeyFixture,
    deviceId: string,
    previousConnectionId: string | null = null,
) {
    await (await findAgent(fixture, deviceId)).start();

    return waitForValue({
        predicate: async () => {
            const agent = await findAgent(fixture, deviceId);

            if (
                agent.status === "connected" &&
                agent.connectionId !== null &&
                agent.connectionId !== previousConnectionId
            ) {
                return agent;
            }

            if (agent.connectionIssue) {
                throw new Error(
                    `issue=${agent.connectionIssue}, server=${fixture.processManager.getStdout(fixture.serverPid).slice(-4000)}`,
                );
            }

            return undefined;
        },
        timeoutMs: CONNECT_TIMEOUT_MS,
        description: `SSH device ${deviceId} to connect`,
    });
}

/** Waits until the device is connected on a connection other than `previousConnectionId`. */
export async function waitReconnected(
    fixture: KeyFixture,
    deviceId: string,
    previousConnectionId: string | null,
) {
    return waitForValue({
        predicate: async () => {
            const agent = await findAgent(fixture, deviceId);

            return agent.status === "connected" &&
                agent.connectionId !== null &&
                agent.connectionId !== previousConnectionId
                ? agent
                : undefined;
        },
        timeoutMs: CONNECT_TIMEOUT_MS,
        description: `SSH device ${deviceId} to reconnect`,
    });
}

/**
 * Starts the device and waits until its start fails. Returns whether it connected anyway,
 * so the caller can assert that it did not.
 */
export async function startAndWaitForIssue(
    fixture: KeyFixture,
    deviceId: string,
): Promise<{ issue: string | null; connected: boolean }> {
    await (await findAgent(fixture, deviceId)).start();

    return waitForValue({
        predicate: async () => {
            const agent = await findAgent(fixture, deviceId);

            if (agent.status === "connected") {
                return { issue: agent.connectionIssue, connected: true };
            }

            if (agent.connectionIssue) {
                return { issue: agent.connectionIssue, connected: false };
            }

            return undefined;
        },
        timeoutMs: CONNECT_TIMEOUT_MS,
        description: `SSH device ${deviceId} start to fail`,
    });
}

/** The fixture password for `redoor-password`, required by the password tests. */
export function fixturePassword(): string {
    const password = process.env.REDOOR_SSH_TEST_PASSWORD;

    if (password === undefined || password === "") {
        throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
    }

    return password;
}
