import { randomBytes } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { ApiClient } from "#ui/api-client";
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
    sshTestCommand,
} from "./ssh-test-utils";

/** Status line prefix the installer reports right before streaming a binary to the device. */
const UPLOADING = "Uploading the binary to ";

/** Status line prefix the installer reports when the device already has the binary. */
const REUSING = "Using existing remote binary at ";

/** Matches the content-addressed debug install path and captures the build hash. */
const DEBUG_INSTALL = /\/binaries\/debug-([0-9a-f]{16})\/redoor$/;

/** Lists the install directories of `appName` on the SSH test host, sorted. */
async function remoteInstalls(appName: string): Promise<string[]> {
    const output = await sshTestCommand(
        `cd "$HOME/.local/share" && ls -1 ${shellQuote(appName)}/binaries`,
    );

    return output
        .split("\n")
        .filter((line) => line !== "")
        .sort();
}

/** Returns the build hash named by the one status line that starts with `prefix`. */
function installedHash(messages: string[], prefix: string): string {
    const lines = messages.filter((message) => message.startsWith(prefix));
    expect(lines).toHaveLength(1);
    const hash = DEBUG_INSTALL.exec(lines[0] ?? "")?.[1];

    if (hash === undefined) {
        throw new Error(`No debug install path in: ${lines.join(", ")}`);
    }

    return hash;
}

/** Status line prefix the installer reports when the debug build cannot run on the device. */
const DEBUG_REJECTED = "The local debug build does not run on this device: ";

/** A server with one stopped SSH-backed agent whose debug build is a private file. */
interface DebugProvisioningServer {
    /** Signed-in client for the server under test. */
    apiClient: ApiClient;
    /** Namespace of the server, which also names its install directory on the device. */
    appName: string;
    /** Local directory holding the server's home, config and caches. */
    home: string;
    /** Starts the agent, waits for it to connect, stops it and returns every status line. */
    startOnce: () => Promise<string[]>;
}

/**
 * Starts a server whose debug build is `prepareBuild(home)` instead of `target/debug`,
 * with one SSH-backed agent on the test host. Remote and local state are removed when the
 * test finishes.
 */
async function startDebugProvisioningServer(options: {
    prefix: string;
    prepareBuild: (home: string) => string;
}): Promise<DebugProvisioningServer> {
    const processManager = new ProcessManager();
    const home = mkdtempSync(join(tmpdir(), `${options.prefix}-`));
    const suffix = `${process.pid}-${Date.now()}`;
    const appName = `${options.prefix}-${suffix}`;
    const agentName = `${options.prefix}-agent-${suffix}`;
    const remoteRoot = `/tmp/${options.prefix}-${suffix}`;
    const configPath = join(home, "config.toml");
    const debugBuild = options.prepareBuild(home);

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_TEST_USER}"
name = "${agentName}"
home = "${remoteRoot}"
log = "${join(home, "managed-agent.log")}"
`,
    );

    onTestFinished(async () => {
        await processManager.killAll();

        try {
            await cleanupSshTest({ remoteRoot, agentAppNames: [appName] });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    await cleanupSshTest({ remoteRoot, agentAppNames: [appName] });
    await sshTestCommand(`mkdir -p ${shellQuote(remoteRoot)}`);

    const serverPid = processManager.spawn(
        SERVER_PATH,
        ["server", "--config", configPath],
        {
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: appName,
                REDOOR_TEST_DEBUG_BINARY: debugBuild,
            },
        },
    );

    await waitForPort(VITEST_SERVER_PORT);
    const apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    /**
     * Starts the stopped agent, waits for a new connection and returns every
     * provisioning step seen on the way, then stops it again for the next start.
     */
    async function startOnce(): Promise<string[]> {
        const stopped = await waitForValue({
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === agentName && agent.status === "stopped",
                ),
            description: "stopped SSH debug build agent",
        });

        await stopped.start();

        const seen = new Set<string>();

        const connected = await waitForValue({
            predicate: async () => {
                const agent = (await apiClient.listAgents()).find(
                    (entry) => entry.name === agentName,
                );

                for (const step of agent?.provisioningStatus ?? []) {
                    seen.add(step.message);
                }

                if (agent?.connectionId) {
                    return agent;
                }

                throw new Error(
                    `status=${agent?.status ?? "missing"}, issue=${agent?.connectionIssue ?? "none"}, server=${processManager.getStdout(serverPid)}`,
                );
            },
            timeoutMs: 90_000,
            description: "SSH debug build agent to connect",
        });

        for (const step of connected.provisioningStatus) {
            seen.add(step.message);
        }

        const shutdown = await connected.shutdown();
        // The next start must begin from a stopped agent, not race the old session.
        expect(shutdown.agent.status).toBe("stopped");

        return [...seen];
    }

    return { apiClient, appName, home, startOnce };
}

// The server only uploads its debug build to a device of its own platform, and the SSH
// test host is x86_64 Linux.
describe.skipIf(
    process.env.REDOOR_SSH_TEST !== "1" ||
        process.platform !== "linux" ||
        process.arch !== "x64",
)("SSH debug build provisioning", () => {
    test("reuses an unchanged debug build and replaces a rebuilt one", async () => {
        let debugBuild = "";

        const server = await startDebugProvisioningServer({
            prefix: "redoor-ssh-debug-build",
            // A private copy stands in for `target/debug/redoor`, so the test can
            // "rebuild" it without touching the shared build output other suites run.
            prepareBuild: (home) => {
                debugBuild = join(home, "build", "redoor");
                mkdirSync(join(home, "build"));
                copyFileSync(SERVER_PATH, debugBuild);
                chmodSync(debugBuild, 0o755);

                return debugBuild;
            },
        });

        const { appName, startOnce } = server;

        // Installs left by older servers: the legacy fixed debug path, another build's
        // content-addressed path, and a versioned release install that must survive.
        await sshTestCommand(
            `cd "$HOME/.local/share" && mkdir -p ${shellQuote(appName)}/binaries/debug ${shellQuote(appName)}/binaries/debug-0000000000000000 ${shellQuote(appName)}/binaries/1.2.3`,
        );

        const first = await startOnce();
        // A fresh device has no install of this build, so it must be uploaded.
        const firstHash = installedHash(first, UPLOADING);
        // The verified upload removes the legacy and other-build debug installs and keeps
        // the release install. The cleanup may finish after the agent connects, so poll.
        await waitForValue({
            predicate: async () => {
                const installs = await remoteInstalls(appName);
                expect(installs).toEqual(["1.2.3", `debug-${firstHash}`]);

                return installs;
            },
            description: "stale debug installs to be removed",
        });

        const second = await startOnce();
        // The unchanged build is found at its content-addressed path and not uploaded again.
        expect(
            second.filter((message) => message.startsWith(UPLOADING)),
        ).toEqual([]);
        expect(installedHash(second, REUSING)).toBe(firstHash);

        // Extra trailing bytes change the content hash and size but still run, like a
        // rebuild that keeps the version.
        appendFileSync(debugBuild, randomBytes(4096));

        const third = await startOnce();
        const rebuiltHash = installedHash(third, UPLOADING);
        // The rebuilt binary gets its own directory instead of overwriting the old one.
        expect(rebuiltHash).not.toBe(firstHash);
        // Only the rebuilt install remains next to the release install.
        await waitForValue({
            predicate: async () => {
                const installs = await remoteInstalls(appName);
                expect(installs).toEqual(["1.2.3", `debug-${rebuiltHash}`]);

                return installs;
            },
            description: "previous debug build install to be removed",
        });
    }, 300_000);

    test("falls back to the release build when the debug build cannot run on the device", async () => {
        // Runs the real server locally, where the marker exists, so the server reads a
        // normal version from it. On the device the marker is missing and it fails the way
        // a glibc build does on an older-glibc or musl host.
        const server = await startDebugProvisioningServer({
            prefix: "redoor-ssh-debug-unrunnable",
            prepareBuild: (home) => {
                const debugBuild = join(home, "build", "redoor");
                const marker = join(home, "build", "runs-here");
                mkdirSync(join(home, "build"));
                writeFileSync(marker, "");
                writeFileSync(
                    debugBuild,
                    `#!/bin/sh
if [ -e ${shellQuote(marker)} ]; then exec ${shellQuote(SERVER_PATH)} "$@"; fi
echo 'redoor: version GLIBC_2.99 not found (required by redoor)' >&2
exit 1
`,
                    { mode: 0o755 },
                );

                return debugBuild;
            },
        });

        const { apiClient, appName, home, startOnce } = server;

        // The release fallback is served from the namespaced local cache so the test never
        // downloads from GitHub; the server binary runs on the test host.
        const { version } = await apiClient.getServerInfo();

        const cachedRelease = join(
            home,
            ".cache",
            appName,
            "binaries",
            version,
            "linux",
            "x86_64",
            "redoor",
        );

        mkdirSync(join(cachedRelease, ".."), { recursive: true });
        copyFileSync(SERVER_PATH, cachedRelease);
        chmodSync(cachedRelease, 0o755);
        const releaseInstall = `/binaries/${version}/redoor`;

        const first = await startOnce();
        // The UI must say why the debug build was skipped, with the loader's own error.
        expect(first).toContain(
            `${DEBUG_REJECTED}redoor: version GLIBC_2.99 not found (required by redoor)`,
        );

        const firstUploads = first.filter((message) =>
            message.startsWith(UPLOADING),
        );

        // A fresh device gets the debug build first, since only running it reveals the
        // problem, and then the release build.
        expect(firstUploads).toHaveLength(2);
        expect(DEBUG_INSTALL.test(firstUploads[0] ?? "")).toBe(true);
        expect(firstUploads[1]?.endsWith(releaseInstall)).toBe(true);

        const second = await startOnce();
        // The unrunnable debug install stays as the marker that sends later starts
        // straight to the release build, so nothing is uploaded again.
        expect(
            second.filter((message) => message.startsWith(UPLOADING)),
        ).toEqual([]);
        expect(
            second.some(
                (message) =>
                    message.startsWith(REUSING) &&
                    message.endsWith(releaseInstall),
            ),
        ).toBe(true);
        // The sniff line shows the run error instead of an empty version.
        expect(
            second.some(
                (message) =>
                    message.startsWith("Sniff results:") &&
                    message.includes(
                        "version=(fails to run: redoor: version GLIBC_2.99",
                    ),
            ),
        ).toBe(true);
    }, 300_000);
});
