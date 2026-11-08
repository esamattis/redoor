import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { X509Certificate } from "node:crypto";
import {
    copyFileSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";

import { ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TEST_AGENT_TOKEN,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    restartServerAndWait,
    selfSignedCertificatePath,
    trustSelfSignedCertificate,
    approveCliLogin,
    waitForApprovalPrompt,
    waitForAgentReady,
    waitForPort,
    waitForValue,
} from "./test-utils";

const processManager = new ProcessManager();

/** Private server home, so the generated certificate is this file's own. */
const home = mkdtempSync(join(tmpdir(), "redoor-https-test-"));

const configPath = join(home, "config.toml");

const serverLog = join(home, "server.log");

const origin = `https://127.0.0.1:${VITEST_SERVER_PORT}`;

let serverPid: number;

let apiClient: ApiClient;

let certificatePem: string;

let restoreTrust: (() => void) | undefined;

/** Writes the server config with the given `[server.tls]` body. */
function writeConfig(tls: string): void {
    writeFileSync(
        configPath,
        `agent_token = "${TEST_AGENT_TOKEN}"

[server]
username = "${TEST_USERNAME}"
password = "${TEST_PASSWORD}"
port = ${VITEST_SERVER_PORT}

[server.tls]
${tls}
`,
    );
}

/** Starts the server on this file's config and home. */
function spawnServer(): number {
    return processManager.spawnServer({
        config: configPath,
        log: serverLog,
        home,
    });
}

/** Reads a file as text, or nothing while it does not exist yet. */
function readIfPresent(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

beforeAll(async () => {
    writeConfig("self_signed = true");
    serverPid = spawnServer();

    const trusted = await trustSelfSignedCertificate({
        home,
        appName: TEST_APP_NAME,
    });

    certificatePem = trusted.pem;
    restoreTrust = trusted.restore;
    await waitForPort(VITEST_SERVER_PORT, 30_000, "https");
    apiClient = new ApiClient(origin);
    await apiClient.login(TEST_USERNAME, TEST_PASSWORD);
}, 60_000);

afterAll(async () => {
    restoreTrust?.();
    await processManager.killAll();
    rmSync(home, { recursive: true, force: true });
});

describe("Built-in HTTPS with a self-signed certificate", () => {
    it("creates a private certificate valid for loopback names", () => {
        const certificate = new X509Certificate(certificatePem);

        const keyPath = join(
            home,
            ".local",
            "share",
            TEST_APP_NAME,
            "tls",
            "self-signed-key.pem",
        );

        // Local clients connect by name or loopback address, so both must verify.
        expect(certificate.subjectAltName).toContain("DNS:localhost");
        expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
        // Other local users must not be able to read the private key.
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);

        const validDays =
            (certificate.validToDate.getTime() -
                certificate.validFromDate.getTime()) /
            (24 * 60 * 60 * 1000);

        // Apple platforms refuse server certificates valid for more than 825 days.
        expect(validDays).toBeLessThanOrEqual(825);
        // Users compare this fingerprint with the browser's before accepting the warning.
        expect(readFileSync(serverLog, "utf8")).toContain(
            `sha256=${certificate.fingerprint256}`,
        );
    });

    it("serves the API over verified HTTPS and not over plain HTTP", async () => {
        const info = await apiClient.getServerInfo();

        // The UI uses this to tell pasted agent configs to skip verification.
        expect(info.self_signed_tls).toBe(true);
        // The port speaks TLS only, so a plain HTTP client gets no API answer.
        await expect(
            fetch(`http://127.0.0.1:${VITEST_SERVER_PORT}/api/v1/agents`),
        ).rejects.toThrow();
    });

    it("marks session cookies Secure", async () => {
        const response = await fetch(`${origin}/api/v1/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: TEST_USERNAME,
                password: TEST_PASSWORD,
            }),
        });

        // Browsers must never send the session over plain HTTP to the same host.
        expect(response.headers.get("set-cookie")).toMatch(/;\s*Secure/i);
    });

    it("connects a managed local agent over TLS", async () => {
        const name = "https-local-agent";
        await apiClient.createLocalAgent({ name, home: null });
        onTestFinished(async () => {
            try {
                await apiClient.deleteManagedAgent(name, "local");
            } catch {
                // Cleanup must tolerate a delete that already happened.
            }
        });

        const created = (await apiClient.listAgents()).find(
            (agent) => agent.name === name,
        );

        if (!created) throw new Error("Created local agent missing");
        await created.start();

        const connected = await waitForValue({
            timeoutMs: 15_000,
            description: "managed local agent to connect over TLS",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) =>
                        agent.name === name && agent.status === "connected",
                ),
        });

        // The server must start its own agents with wss:// and skip verifying localhost.
        expect(connected.status).toBe("connected");
    }, 20_000);

    it("connects a standalone agent only when certificate checks are skipped", async () => {
        const serverProcess = processManager.getProcess(serverPid);

        if (!serverProcess) throw new Error("Server process missing");
        const verifyingLog = join(home, "verifying-agent.log");

        const verifyingPid = processManager.spawnAgent({
            wsAddress: origin,
            name: "https-verifying-agent",
            cwd: home,
            home,
            log: verifyingLog,
        });

        onTestFinished(() => processManager.kill(verifyingPid));

        // Without the opt-out the self-signed certificate must be refused.
        await waitForValue({
            description: "agent to reject the self-signed certificate",
            predicate: async () =>
                readIfPresent(verifyingLog)?.match(/UnknownIssuer/),
        });

        const insecureName = "https-insecure-agent";
        const registered = waitForAgentReady(serverProcess, insecureName);

        const insecurePid = processManager.spawnAgent({
            wsAddress: origin,
            name: insecureName,
            cwd: home,
            home,
            log: join(home, "insecure-agent.log"),
            env: { REDOOR_AGENT_INSECURE_TLS: "1" },
        });

        onTestFinished(() => processManager.kill(insecurePid));

        // The environment variable alone must turn verification off and let it register.
        await registered;
        expect(
            (await apiClient.listAgents()).some(
                (agent) =>
                    agent.name === insecureName && agent.status === "connected",
            ),
        ).toBe(true);
        // Operators must see that the agent no longer verifies the server.
        expect(
            readFileSync(join(home, "insecure-agent.log"), "utf8"),
        ).toContain("TLS certificate verification is disabled");
    }, 20_000);

    it("lets the remote CLI log in only when certificate checks are skipped", async () => {
        const cliHome = mkdtempSync(join(tmpdir(), "redoor-https-cli-"));

        onTestFinished(() => rmSync(cliHome, { recursive: true, force: true }));

        /** Runs `redoor remote` in its own namespace, without inherited overrides. */
        const remote = (args: string[]) =>
            $({
                env: {
                    ...process.env,
                    HOME: cliHome,
                    REDOOR_APP_NAME: `${TEST_APP_NAME}-https-cli`,
                    REDOOR_REMOTE_SERVER: "",
                    REDOOR_REMOTE_TOKEN: "",
                    REDOOR_REMOTE_INSECURE_TLS: "",
                },
                quiet: true,
                nothrow: true,
            })`exec ${SERVER_PATH} remote ${args}`;

        const loginArgs = [
            "login",
            origin,
            "--permissions",
            "all",
            "--name",
            "https cli test",
        ];

        const verified = await remote(loginArgs);

        // The CLI verifies certificates by default, so the self-signed one is refused before
        // any login request starts.
        expect(verified.exitCode).not.toBe(0);
        expect(verified.stderr).toMatch(/certificate/i);

        const insecure = remote([...loginArgs, "--insecure-tls"]);
        onTestFinished(async () => {
            try {
                await insecure.kill();
            } catch {
                // Already exited.
            }
        });

        const metadata = await approveCliLogin(
            origin,
            await waitForApprovalPrompt(insecure),
        );

        onTestFinished(async () => {
            await apiClient.deleteAccessToken(metadata.id);
        });
        const loggedIn = await insecure;

        // The opt-out lets the login through and warns about it.
        expect(loggedIn.exitCode, loggedIn.stderr).toBe(0);
        expect(loggedIn.stderr).toContain(
            "TLS certificate verification is disabled",
        );

        const status = await remote(["status"]);

        // The saved login remembers the opt-out, so later commands need no flag.
        expect(status.exitCode, status.stderr).toBe(0);
        expect(status.stdout).toContain("Certificate: not verified");
    }, 30_000);

    it("keeps the certificate across restarts", async () => {
        await restartServerAndWait({ apiClient, serverLog });

        // A restart must not invalidate the exception users accepted in their browser.
        expect(
            readFileSync(
                selfSignedCertificatePath(home, TEST_APP_NAME),
                "utf8",
            ),
        ).toBe(certificatePem);
    }, 30_000);

    it("serves operator-provided certificate files", async () => {
        const certDirectory = mkdtempSync(
            join(tmpdir(), "redoor-https-files-"),
        );

        onTestFinished(() =>
            rmSync(certDirectory, { recursive: true, force: true }),
        );
        const generated = join(home, ".local", "share", TEST_APP_NAME, "tls");
        const cert = join(certDirectory, "fullchain.pem");
        const key = join(certDirectory, "privkey.pem");
        copyFileSync(join(generated, "self-signed-cert.pem"), cert);
        copyFileSync(join(generated, "self-signed-key.pem"), key);
        writeConfig(`cert = "${cert}"
key = "${key}"`);

        await restartServerAndWait({ apiClient, serverLog });

        // The files are served as given; the trusted copy proves the same certificate.
        expect((await apiClient.getServerInfo()).self_signed_tls).toBe(false);
    }, 30_000);

    it("refuses a restart onto certificate files that cannot be loaded", async () => {
        writeConfig(`cert = "${join(home, "missing-cert.pem")}"
key = "${join(home, "missing-key.pem")}"`);

        // The running server must stay up instead of restarting into a failed listener.
        await expect(apiClient.restartServer()).rejects.toMatchObject({
            status: 400,
        });
        // It keeps answering requests over its current certificate.
        await expect(apiClient.listAgents()).resolves.toBeInstanceOf(Array);
    });
});
