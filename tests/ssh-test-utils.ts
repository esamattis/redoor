import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { z } from "zod";
import { type Agent, ApiClient } from "#ui/api-client";
import {
    type ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
    waitForValue,
} from "./test-utils";
import { TEST_TERMINAL_SIZE, TerminalViewer } from "./terminal-test-utils";

// Every SSH test file shares the one remote test host and its `authorized_keys`, so they must
// run one at a time. Failing here makes a new SSH test file that was not added to
// `SERIAL_INTEGRATION_TEST_FILES` fail loudly instead of racing the other SSH files.
if (process.env.REDOOR_VITEST_LANE !== "serial") {
    throw new Error(
        "SSH integration tests must be listed in SERIAL_INTEGRATION_TEST_FILES in integration-test-lanes.ts",
    );
}

/** SSH alias of the disposable test host the SSH integration tests provision. */
export const SSH_TEST_HOST = "redoor-ssh-test";

/** Unprivileged key-authenticated account on the SSH test host. */
export const SSH_TEST_USER = "redoor";

/** Quotes one controlled value for the remote POSIX shell used by OpenSSH. */
export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Password-only account on the SSH test host, for tests that cover password login. */
export const SSH_PASSWORD_USER = "redoor-password";

/**
 * Shares one SSH connection per account between the many remote checks and cleanups the
 * tests run. A fresh connection costs about 0.2 s of handshake, which added up to tens of
 * seconds across the suite. This only affects the tests' own inspection commands; the
 * server under test still opens its own connections. The short `/tmp` path stays within
 * the Unix socket path limit on macOS, and idle masters exit soon after the suite ends.
 */
const SSH_MULTIPLEX_OPTIONS = [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=/tmp/redoor-test-ssh-%C",
    "-o",
    "ControlPersist=30",
];

/**
 * Runs a command on the SSH test host as the required redoor user. Returns stdout so tests
 * can inspect remote state such as `authorized_keys`.
 */
export async function sshTestCommand(command: string): Promise<string> {
    const { stdout } = await $`ssh ${SSH_MULTIPLEX_OPTIONS} -l ${SSH_TEST_USER} ${SSH_TEST_HOST} ${command}`.quiet();

    return stdout;
}

/**
 * Runs a command as a password-only account using the shared fixture password, without
 * exposing it in process arguments or test output. Returns stdout.
 */
export async function sshCommandWithPassword(
    username: string,
    command: string,
): Promise<string> {
    const password = process.env.REDOOR_SSH_TEST_PASSWORD;

    if (password === undefined || password === "") {
        throw new Error(
            "REDOOR_SSH_TEST_PASSWORD is required for password SSH commands",
        );
    }

    const askpassDir = mkdtempSync(join(tmpdir(), "redoor-ssh-askpass-"));
    const askpassPath = join(askpassDir, "askpass");
    writeFileSync(
        askpassPath,
        `#!/bin/sh
printf '%s' "$REDOOR_SSH_TEST_PASSWORD"
`,
        { mode: 0o700 },
    );

    try {
        const { stdout } = await $({
            env: {
                ...process.env,
                DISPLAY: process.env.DISPLAY ?? ":0",
                SSH_ASKPASS: askpassPath,
                SSH_ASKPASS_REQUIRE: "force",
            },
        })`ssh ${SSH_MULTIPLEX_OPTIONS} -l ${username} ${SSH_TEST_HOST} ${command}`.quiet();

        return stdout;
    } finally {
        rmSync(askpassDir, { recursive: true, force: true });
    }
}

/** Root account on the SSH test host; it logs in with the shared fixture password. */
export const SSH_ROOT_USER = "root";

/** Runs a command as root for behavior that cannot be exercised by local non-root agents. */
export async function sshRootTestCommand(command: string): Promise<string> {
    return sshCommandWithPassword(SSH_ROOT_USER, command);
}

/**
 * Starts a server whose TOML-managed agent logs in to the SSH test host as root with the
 * fixture password, and resolves once that agent is connected. Root-only behavior (ownership,
 * other users' systemd managers) cannot be exercised by the local non-root test agents.
 * Callers register their own cleanup first, so a failed start still cleans up.
 */
export async function startRootSshAgent(options: {
    processManager: ProcessManager;
    home: string;
    appName: string;
    agentName: string;
}): Promise<Agent> {
    const sshPassword = process.env.REDOOR_SSH_TEST_PASSWORD;

    if (sshPassword === undefined) {
        throw new Error("REDOOR_SSH_TEST_PASSWORD unexpectedly missing");
    }

    const configPath = join(options.home, "config.toml");

    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[[agents]]
target = "${SSH_TEST_HOST}"
username = "${SSH_ROOT_USER}"
password = ${JSON.stringify(sshPassword)}
name = "${options.agentName}"
`,
    );

    const serverPid = options.processManager.spawn(
        SERVER_PATH,
        ["server", "--config", configPath],
        {
            env: {
                ...process.env,
                HOME: options.home,
                REDOOR_APP_NAME: options.appName,
            },
        },
    );

    await waitForPort(VITEST_SERVER_PORT);

    const apiClient = new ApiClient(`http://127.0.0.1:${VITEST_SERVER_PORT}`);

    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);

    const configuredAgent = await waitForValue({
        predicate: async () =>
            (await apiClient.listAgents()).find(
                (agent) => agent.name === options.agentName,
            ),
        description: "root SSH agent inventory registration",
    });

    await configuredAgent.start();

    return waitForValue({
        predicate: async () => {
            const agent = (await apiClient.listAgents()).find(
                (entry) => entry.name === options.agentName,
            );

            if (agent?.connectionId) {
                return agent;
            }

            throw new Error(
                `status=${agent?.status ?? "missing"}, issue=${agent?.connectionIssue ?? "none"}, server=${options.processManager.getStdout(serverPid)}`,
            );
        },
        timeoutMs: 60_000,
        description: "root SSH agent to connect",
    });
}

/** Stops any orphaned remote agent and removes only this test's isolated files. */
export async function cleanupSshTest(options: {
    remoteRoot: string;
    agentAppNames: string[];
    sshCommand?: (command: string) => Promise<string>;
}): Promise<void> {
    const run = options.sshCommand ?? sshTestCommand;
    const appNames = options.agentAppNames.map(shellQuote).join(" ");
    // Managed agent daemons live in `<app>-<agent id>` namespaces next to the app's own and
    // outlive the SSH session, so they and their forward sockets are cleaned up too.
    const command = `for app in ${appNames}; do for dir in "$HOME/.local/share/$app" "$HOME/.local/share/$app"-dev_*; do pid_file="$dir/agent.pid"; if [ -f "$pid_file" ]; then pid=$(sed -n 's/^ *"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$pid_file"); case "$pid" in *[!0-9]*|'') ;; *) kill -9 "$pid" 2>/dev/null || true ;; esac; fi; rm -rf "$dir"; done; rm -f "\${XDG_RUNTIME_DIR:-/tmp}/$app"-dev_*.sock "/tmp/$app"-dev_*.sock; done; rm -rf ${shellQuote(options.remoteRoot)}`;
    await run(command);
}

/** The PID the managed daemon of `namespace` on the SSH test host recorded. */
export async function remoteDaemonPid(namespace: string): Promise<number> {
    const record = await sshTestCommand(
        `cat "$HOME/.local/share/"${shellQuote(namespace)}/agent.pid`,
    );

    return z.object({ pid: z.number() }).parse(JSON.parse(record)).pid;
}

/** Whether a process with `pid` runs on the SSH test host. */
export async function remoteProcessAlive(pid: number): Promise<boolean> {
    const answer = await sshTestCommand(
        `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`,
    );

    return answer.trim() === "alive";
}

/** Kills the local `ssh` client of the managed session whose forward names `namespace`. */
export async function killLocalSshSession(namespace: string): Promise<void> {
    const pids: number[] = [];

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

        // Only the session's ssh client names the device's namespace in its forward.
        if (argv[0] === "ssh" && argv.some((arg) => arg.includes(`${namespace}-`))) {
            pids.push(Number(entry));
        }
    }

    if (pids.length === 0) {
        throw new Error(`No ssh session of ${namespace} found`);
    }

    for (const pid of pids) {
        process.kill(pid, "SIGKILL");
    }
}

/** Waits until `name` is connected on a connection other than `previous`. */
export async function waitForReconnect(
    api: ApiClient,
    name: string,
    previous: string | null,
): Promise<Agent> {
    return waitForValue({
        predicate: async () =>
            (await api.listAgents()).find(
                (agent) =>
                    agent.name === name &&
                    agent.status === "connected" &&
                    agent.connectionId !== previous,
            ),
        timeoutMs: 60_000,
        description: `${name} to reconnect`,
    });
}

/** Attaches a new viewer to an existing terminal session. */
export async function reattach(
    api: ApiClient,
    sessionId: string,
): Promise<TerminalViewer> {
    const viewer = new TerminalViewer(api, sessionId, TEST_TERMINAL_SIZE);
    await viewer.waitForReady();

    return viewer;
}

/** Asks the shell for its PID, which tells whether a reattached tab reached the same shell. */
export async function terminalShellPid(
    viewer: TerminalViewer,
    marker: string,
): Promise<string> {
    viewer.type(`printf '${marker}-%s\\n' $$\n`);
    const pattern = new RegExp(`${marker}-(\\d+)`);
    const output = await viewer.waitForOutputMatching(pattern);
    const pid = pattern.exec(output)?.[1];

    if (pid === undefined) {
        throw new Error(`No shell PID in ${output}`);
    }

    return pid;
}
