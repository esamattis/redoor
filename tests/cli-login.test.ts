import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { $, type ProcessPromise } from "zx";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import type { AccessTokenResponse } from "#bindings/AccessTokenResponse";
import type { AccessTokenSecretResponse } from "#bindings/AccessTokenSecretResponse";
import type { ApproveCliLoginResponse } from "#bindings/ApproveCliLoginResponse";
import type { CliLoginResponse } from "#bindings/CliLoginResponse";
import type { CliTokenDefaults } from "#bindings/CliTokenDefaults";
import type { ErrorResponse } from "#bindings/ErrorResponse";
import type { StartCliLoginResponse } from "#bindings/StartCliLoginResponse";
import { createMcpTestClient } from "./mcp-client";
import {
    ProcessManager,
    TEST_PASSWORD,
    TEST_USERNAME,
    TempFileManager,
    ageFreshLogin,
    browserFetch,
    approveCliLogin,
    cliLoginApproval as approval,
    signInBrowser,
    startServerAndAgent,
    waitForApprovalPrompt,
} from "./test-utils";

/** One answer of the CLI's long poll. */
type WaitAnswer =
    | { status: "pending" }
    | { status: "denied" }
    | ({ status: "approved" } & AccessTokenSecretResponse);

describe("CLI login through the browser", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();

    const binary =
        process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");

    let setup: Awaited<ReturnType<typeof startServerAndAgent>>;
    let baseUrl: string;
    let home: string;

    beforeAll(async () => {
        setup = await startServerAndAgent({
            processManager: processes,
            agentName: "cli-login-agent",
            agentCwd: files.tempDirectory(),
        });
        baseUrl = setup.apiClient.baseUrl;
        home = files.tempDirectory();
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Starts a login request the way the CLI does, without the CLI. */
    async function startRequest(
        token: Partial<CliTokenDefaults> = {},
    ): Promise<StartCliLoginResponse> {
        const response = await fetch(`${baseUrl}/api/v1/cli-logins`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                host_name: "test-host",
                token: {
                    name: "api started",
                    permissions: ["files:read"],
                    devices: { kind: "all" },
                    lifetime: "never",
                    ...token,
                },
            }),
        });

        expect(response.status).toBe(200);

        return response.json();
    }

    /** One poll as the CLI. */
    function wait(
        started: Pick<StartCliLoginResponse, "id" | "poll_secret">,
    ): Promise<Response> {
        return fetch(`${baseUrl}/api/v1/cli-logins/${started.id}/wait`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ poll_secret: started.poll_secret }),
        });
    }

    /**
     * Turns a request down and lets the CLI side collect the answer, so it no longer counts
     * against the per-address cap of the tests after it. Runs as test cleanup, so it signs
     * in and out by itself instead of registering more cleanup.
     */
    async function discard(started: StartCliLoginResponse): Promise<void> {
        const login = await fetch(`${baseUrl}/api/v1/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: TEST_USERNAME,
                password: TEST_PASSWORD,
            }),
        });

        const session = {
            cookie:
                (login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "",
            file: "",
        };

        await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/deny`,
        });
        await wait(started);
        await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: "/api/v1/logout",
        });
    }

    /** Deletes a token when the test ends, using a session as the UI would. */
    function deleteWhenDone(tokenId: string): void {
        onTestFinished(async () => {
            try {
                await setup.apiClient.deleteAccessToken(tokenId);
            } catch (error) {
                // Tests that revoke their token already cleaned up.
                if (!(error instanceof ApiError && error.status === 404)) {
                    throw error;
                }
            }
        });
    }

    /** The real binary running `redoor remote <args>` in its own namespace. */
    type Cli = {
        run: ProcessPromise;
        id: string;
        userCode: string;
    };

    /**
     * Starts the real binary in an isolated namespace and resolves once it has printed the
     * approval URL and the code, which is when a user would switch to the browser.
     */
    async function startCli(namespace: string, args: string[]): Promise<Cli> {
        const run = $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: namespace,
                REDOOR_REMOTE_SERVER: "",
                REDOOR_REMOTE_TOKEN: "",
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;

        onTestFinished(async () => {
            // A CLI still waiting after a failed assertion must not outlive the test. Killing
            // one that already exited throws, which is fine.
            try {
                await run.kill();
            } catch {
                // Already exited.
            }
        });

        return { run, ...(await waitForApprovalPrompt(run)) };
    }

    /** Approves a CLI's request with its own defaults, deleting the token after the test. */
    async function approveCli(cli: Cli): Promise<AccessTokenResponse> {
        const metadata = await approveCliLogin(baseUrl, cli);
        deleteWhenDone(metadata.id);

        return metadata;
    }

    /** Path of a namespace's saved credentials. */
    function credentialsPath(namespace: string) {
        return path.join(
            home,
            ".local/share",
            namespace,
            "remote-credentials.json",
        );
    }

    /** Reads the token a namespace saved. */
    async function savedToken(namespace: string): Promise<string> {
        const saved: { token: string } = JSON.parse(
            await fs.readFile(credentialsPath(namespace), "utf8"),
        );

        return saved.token;
    }

    /** Resolves to the HTTP status of a token's self lookup. */
    async function tokenStatus(token: string): Promise<number> {
        const client = new ApiClient(baseUrl);
        client.setAccessToken(token);

        try {
            await client.getCurrentAccessToken();

            return 200;
        } catch (error) {
            if (error instanceof ApiError) return error.status;

            throw error;
        }
    }

    /** Runs a short `redoor remote` command in a namespace. */
    function remote(namespace: string, args: string[]) {
        return $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: namespace,
                REDOOR_REMOTE_SERVER: "",
                REDOOR_REMOTE_TOKEN: "",
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;
    }

    it("logs the CLI in once the token is approved in the browser", async () => {
        const cli = await startCli("browser-login", [
            "login",
            baseUrl,
            "--permissions",
            "files:read,agents:manage",
            "--name",
            "browser login test",
        ]);

        const session = await signInBrowser(baseUrl);

        const request: CliLoginResponse = await (
            await browserFetch(baseUrl, session.cookie, {
                method: "GET",
                path: `/api/v1/cli-logins/${cli.id}`,
            })
        ).json();

        // The page shows where the request comes from, so the user can recognise it ...
        expect(request.host_name).toBe(hostname());
        expect(request.client_ip).toBe("127.0.0.1");
        // ... and the CLI's flags as the form's defaults.
        expect(request.token).toEqual({
            name: "browser login test",
            permissions: ["files:read", "agents:manage"],
            devices: { kind: "all" },
            lifetime: "90d",
        });
        expect(request.status).toBe("pending");
        // The page never learns the code, so it must be typed from the terminal.
        expect(JSON.stringify(request)).not.toContain(cli.userCode);

        // The user narrows the token in the form before approving it.
        const approved = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${cli.id}/approve`,
            body: approval(cli.userCode.toLowerCase(), {
                ...request.token,
                permissions: ["files:read"],
            }),
        });

        // The code is accepted in any case, and the browser gets no secret.
        expect(approved.status).toBe(200);
        const approvedBody = await approved.text();
        expect(approvedBody).not.toContain("redoor_at_");

        const { metadata }: ApproveCliLoginResponse = JSON.parse(approvedBody);

        deleteWhenDone(metadata.id);

        const result = await cli.run;

        // The CLI continued by itself and saved the token the browser approved.
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toContain("Logged in to");
        expect(result.stderr).toContain("files:read; all devices");
        const stat = await fs.stat(credentialsPath("browser-login"));
        // The credentials file is private and holds a token.
        expect(stat.mode & 0o777).toBe(0o600);
        expect(await savedToken("browser-login")).toMatch(/^redoor_at_/);

        const status = await remote("browser-login", ["status", "--json"]);
        const current: AccessTokenResponse = JSON.parse(status.stdout);
        // The saved token is the one approved, with the permissions chosen in the browser.
        expect(current.id).toBe(metadata.id);
        expect(current.permissions).toEqual(["files:read"]);

        const exec = await remote("browser-login", [
            "exec",
            setup.testAgent.id,
            "--",
            "true",
        ]);

        // The token lacks commands:execute, and the error says so.
        expect(exec.exitCode).not.toBe(0);
        expect(exec.stderr).toContain("commands:execute");
    });

    it("needs a fresh sign-in to approve", async () => {
        const started = await startRequest();
        onTestFinished(() => discard(started));
        const session = await signInBrowser(baseUrl);
        ageFreshLogin(session, 61);

        const refused = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/approve`,
            body: approval(started.user_code, {
                name: "stale",
                permissions: ["files:read"],
                devices: { kind: "all" },
                lifetime: "never",
            }),
        });

        const error: ErrorResponse = await refused.json();

        // A copied browser profile can open the page but cannot approve the login.
        expect(refused.status).toBe(403);
        expect(error.code).toBe("fresh_login_required");

        // The request is still pending, so the user can sign in again and approve it.
        const request: CliLoginResponse = await (
            await browserFetch(baseUrl, session.cookie, {
                method: "GET",
                path: `/api/v1/cli-logins/${started.id}`,
            })
        ).json();

        expect(request.status).toBe("pending");
    });

    it("hands the token to the CLI exactly once", async () => {
        const started = await startRequest();
        const session = await signInBrowser(baseUrl);

        const approved = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/approve`,
            body: approval(started.user_code, {
                name: "once",
                permissions: ["files:read"],
                devices: { kind: "all" },
                lifetime: "never",
            }),
        });

        expect(approved.status).toBe(200);
        const first = await wait(started);
        const answer: WaitAnswer = await first.json();

        // The CLI's poll carries the secret, which must never be cached.
        expect(first.headers.get("cache-control")).toContain("no-store");

        if (answer.status !== "approved") {
            throw new Error(
                `Expected an approved answer, got ${answer.status}`,
            );
        }

        const token = answer.token;
        expect(token).toMatch(/^redoor_at_/);
        deleteWhenDone(answer.metadata.id);
        // The secret works.
        expect(await tokenStatus(token)).toBe(200);
        // A second poll gets nothing: the request is used up.
        expect((await wait(started)).status).toBe(404);
        // A wrong poll secret never gets the token either.
        const other = await startRequest();
        onTestFinished(() => discard(other));
        expect((await wait({ ...other, poll_secret: "guess" })).status).toBe(
            404,
        );
    });

    it("removes the request after five wrong codes", async () => {
        const started = await startRequest();
        const session = await signInBrowser(baseUrl);

        const defaults: CliTokenDefaults = {
            name: "guessed",
            permissions: ["files:read"],
            devices: { kind: "all" },
            lifetime: "never",
        };

        const approve = (code: string) =>
            browserFetch(baseUrl, session.cookie, {
                method: "POST",
                path: `/api/v1/cli-logins/${started.id}/approve`,
                body: approval(code, defaults),
            });

        for (let attempt = 1; attempt < 5; attempt += 1) {
            // A wrong code is refused but leaves the request for another try.
            expect((await approve("ZZZZ-ZZZZ")).status).toBe(400);
        }

        // The fifth wrong code removes the request, so the code cannot be guessed ...
        expect((await approve("ZZZZ-ZZZZ")).status).toBe(404);
        // ... and even the right one is too late.
        expect((await approve(started.user_code)).status).toBe(404);
        expect((await wait(started)).status).toBe(404);
    });

    it("tells a denial to the CLI once and refuses to approve it", async () => {
        const started = await startRequest();
        const session = await signInBrowser(baseUrl);

        const denied = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/deny`,
        });

        // Denying needs no code and no fresh sign-in: it hands nothing out.
        expect(denied.status).toBe(200);

        const approved = await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/approve`,
            body: approval(started.user_code, {
                name: "after denial",
                permissions: ["files:read"],
                devices: { kind: "all" },
                lifetime: "never",
            }),
        });

        // A denied request can no longer be approved.
        expect(approved.status).toBe(409);
        const answer: WaitAnswer = await (await wait(started)).json();
        // The CLI learns about the denial ...
        expect(answer.status).toBe("denied");
        // ... once, then the request is gone.
        expect((await wait(started)).status).toBe(404);
    });

    it("stops the CLI when the login is denied in the browser", async () => {
        const cli = await startCli("denied-login", ["login", baseUrl]);
        const session = await signInBrowser(baseUrl);
        expect(
            (
                await browserFetch(baseUrl, session.cookie, {
                    method: "POST",
                    path: `/api/v1/cli-logins/${cli.id}/deny`,
                })
            ).status,
        ).toBe(200);
        const result = await cli.run;

        // The waiting CLI stops with a message that says why.
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("The login was denied in the browser");
        // Nothing is saved.
        expect(existsSync(credentialsPath("denied-login"))).toBe(false);
    });

    it("lets only one poll wait per request", async () => {
        const started = await startRequest();
        // Two polls at once: whichever reaches the server second is refused at once.
        const polls = [wait(started), wait(started)];

        const refused = await Promise.race(
            polls.map(async (poll) => (await poll).status === 409),
        );

        // At least one poll answered quickly; the waiting one gets the denial.
        expect(refused).toBe(true);
        const session = await signInBrowser(baseUrl);
        await browserFetch(baseUrl, session.cookie, {
            method: "POST",
            path: `/api/v1/cli-logins/${started.id}/deny`,
        });

        const statuses = await Promise.all(
            polls.map(async (poll) => {
                const response = await poll;

                if (response.status !== 200) {
                    return String(response.status);
                }

                const answer: WaitAnswer = await response.json();

                return answer.status;
            }),
        );

        // Exactly one poll waited, and it received the denial instead of timing out.
        expect([...statuses].sort((a, b) => a.localeCompare(b))).toEqual([
            "409",
            "denied",
        ]);
    });

    it("caps the requests one address may have waiting", async () => {
        const started: StartCliLoginResponse[] = [];

        onTestFinished(async () => {
            for (const request of started) await discard(request);
        });

        for (let index = 0; index < 5; index += 1) {
            started.push(await startRequest());
        }

        const sixth = await fetch(`${baseUrl}/api/v1/cli-logins`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                host_name: "test-host",
                token: {
                    name: "one too many",
                    permissions: ["files:read"],
                    devices: { kind: "all" },
                    lifetime: "never",
                },
            }),
        });

        // Anonymous callers cannot make the server hold more than a few requests each.
        expect(sixth.status).toBe(429);
    });

    it("prints a token for MCP clients with create-token", async () => {
        const cli = await startCli("create-token", [
            "create-token",
            baseUrl,
            "--permissions",
            "files:read",
        ]);

        await approveCli(cli);
        const result = await cli.run;

        expect(result.exitCode, result.stderr).toBe(0);

        const output: {
            token: string;
            mcp_endpoint: string;
            metadata: AccessTokenResponse;
        } = JSON.parse(result.stdout);

        // The JSON on stdout carries the secret and where to use it; the prompt went to stderr.
        expect(output.token).toMatch(/^redoor_at_/);
        expect(output.mcp_endpoint).toBe(`${baseUrl}/mcp`);
        expect(output.metadata.permissions).toEqual(["files:read"]);
        // Nothing is saved locally.
        expect(existsSync(credentialsPath("create-token"))).toBe(false);

        const tools = await createMcpTestClient({
            endpoint: output.mcp_endpoint,
            token: output.token,
        }).listTools();

        // The printed token works on the MCP endpoint, limited to its permissions.
        expect(tools.result.tools.map((tool) => tool.name)).toContain(
            "read_file",
        );
        expect(tools.result.tools.map((tool) => tool.name)).not.toContain(
            "run_command",
        );
    });

    it("revokes the previous token on re-login and on logout", async () => {
        const first = await startCli("login-again", ["login", baseUrl]);
        await approveCli(first);
        expect((await first.run).exitCode).toBe(0);
        const firstToken = await savedToken("login-again");

        const second = await startCli("login-again", ["login", baseUrl]);
        await approveCli(second);
        const again = await second.run;
        expect(again.exitCode, again.stderr).toBe(0);
        const secondToken = await savedToken("login-again");

        // Logging in again replaces the token and revokes the old one, leaving no orphan.
        expect(secondToken).not.toBe(firstToken);
        expect(await tokenStatus(firstToken)).toBe(401);
        expect(await tokenStatus(secondToken)).toBe(200);

        const logout = await remote("login-again", ["logout"]);
        // Logout revokes the token server-side and removes the file.
        expect(logout.exitCode, logout.stderr).toBe(0);
        expect(await tokenStatus(secondToken)).toBe(401);
        expect(existsSync(credentialsPath("login-again"))).toBe(false);
    });
});
