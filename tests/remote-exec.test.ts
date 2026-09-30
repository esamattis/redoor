import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { $ } from "zx";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";
import type { ExecRequest } from "#bindings/ExecRequest";
import type { ExecEvent } from "#bindings/ExecEvent";
import type { CancelExecutionResponse } from "#bindings/CancelExecutionResponse";

describe("Remote exec and non-shell streaming API", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();
    const binary =
        process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");
    let setup: Awaited<ReturnType<typeof startServerAndAgent>>;
    let home: string;

    beforeAll(async () => {
        setup = await startServerAndAgent({
            processManager: processes,
            agentName: "remote-exec",
            agentCwd: files.tempDirectory(),
        });
        home = files.tempDirectory();
        const directory = path.join(home, ".local/share/exec-test");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(
            path.join(directory, "remote-session.json"),
            JSON.stringify({
                version: 1,
                generation: randomUUID(),
                server_url: `${setup.apiClient.baseUrl}/`,
                cookies: [
                    {
                        raw_cookie: `${setup.apiClient.getAuthHeaders().Cookie}; Path=/`,
                        path: ["/", true],
                        domain: { HostOnly: "127.0.0.1" },
                        expires: "SessionEnd",
                    },
                ],
            }),
            { mode: 0o600 },
        );
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Separate invocations prove saved cookies and argv survive real CLI parsing. */
    function exec(...args: string[]) {
        return $({
            env: { ...process.env, HOME: home, REDOOR_APP_NAME: "exec-test" },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote exec ${args}`;
    }

    /** Use the dedicated endpoint directly to verify new REST semantics independently of CLI output. */
    function api(request: ExecRequest, signal?: AbortSignal) {
        return fetch(
            `${setup.apiClient.baseUrl}/api/v1/agents/${setup.testAgent.id}/exec`,
            {
                method: "POST",
                headers: {
                    ...setup.apiClient.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
                signal,
            },
        );
    }

    /** Finite output fixtures can decode the NDJSON contract without masking live-stream tests. */
    function events(stdout: string): ExecEvent[] {
        return stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
    }

    /** A missing direct child proves cancellation reaped it rather than only closing local output. */
    function gone(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            return true;
        }
    }

    it("preserves argv, empty arguments and metacharacters without implicit shell evaluation", async () => {
        const values = [
            "space value",
            "",
            "$HOME; echo injected",
            "*.txt",
            "--app-name",
            "a=b",
            "雪",
        ];
        const output = await exec(
            setup.testAgent.id,
            "--",
            "printf",
            "<%s>",
            ...values,
        );
        // Literal output distinguishes direct argv execution from accidental shell quoting or evaluation.
        expect(output.exitCode, output.stderr).toBe(0);
        expect(output.stdout).toBe(
            values.map((value) => `<${value}>`).join(""),
        );
        expect(output.stderr).toBe("");
        // Completed CLI executions must not leak output labels into filesystem transfer history.
        expect((await setup.apiClient.getTransferProgress()).transfers).toEqual([]);
    });

    it("sets cwd and repeated environment overrides, preserves stderr and returns a remote failure", async () => {
        const cwd = files.tempDirectory();
        const output = await exec(
            "--cwd",
            cwd,
            "--env",
            "VALUE=old",
            "--env",
            "VALUE=a=b",
            "--env",
            "EMPTY=",
            setup.testAgent.id,
            "--",
            "sh",
            "-c",
            'printf "%s|%s|%s" "$PWD" "$VALUE" "$EMPTY"; printf "remote stderr" >&2; exit 37',
        );
        // Distinct streams and the exact exit code must survive a successfully transported command failure.
        expect(output.stdout).toBe(`${cwd}|a=b|`);
        expect(output.stderr).toBe("remote stderr");
        expect(output.exitCode).toBe(37);
    });

    it("emits lossless bounded JSON records, including binary bytes and a distinct exit event", async () => {
        const output = await exec(
            "--json",
            setup.testAgent.id,
            "--",
            "sh",
            "-c",
            "printf '\\000\\377'; printf err >&2; exit 125",
        );
        const records = events(output.stdout);
        // A reserved remote exit code remains distinguishable from API/transport error events.
        expect(output.exitCode).toBe(125);
        expect(
            records
                .filter((event) => event.type === "stdout")
                .flatMap((event) => event.data),
        ).toEqual([0, 255]);
        expect(
            Buffer.from(
                records
                    .filter((event) => event.type === "stderr")
                    .flatMap((event) => event.data),
            ).toString(),
        ).toBe("err");
        expect(records.at(-1)).toEqual({
            type: "exit",
            code: 125,
            signal: null,
        });
        expect(output.stderr).toBe("");
    });

    it("reports spawn/API failures separately from remote exit and rejects invalid CLI inputs", async () => {
        const missing = await exec(
            "--json",
            setup.testAgent.id,
            "--",
            "/no/such/redoor-exec-command",
        );
        // Spawn errors have no remote exit status; a missing agent is an API failure with the same local category.
        expect(missing.exitCode).toBe(125);
        expect(events(missing.stdout).at(-1)?.type).toBe("error");
        const absent = await exec("--json", "absent-agent", "--", "true");
        expect(absent.exitCode).toBe(125);
        expect(events(absent.stdout).at(-1)?.type).toBe("error");
        for (const args of [
            ["--timeout", "0s"],
            ["--env", "=value"],
            ["--timeout", "huge"],
        ]) {
            const invalid = await exec(
                ...args,
                setup.testAgent.id,
                "--",
                "true",
            );
            // Parser validation must happen before any remote process is admitted.
            expect(invalid.exitCode).toBe(2);
        }
        const separator = await exec(setup.testAgent.id, "true");
        expect(separator.exitCode).toBe(2);
    });

    it("enforces timeout on the agent and reaps the process", async () => {
        const pidFile = path.join(files.tempDirectory(), "pid");
        const output = await exec(
            "--json",
            "--timeout",
            "1s",
            setup.testAgent.id,
            "--",
            "sh",
            "-c",
            'echo $$ > "$1"; exec sleep 60',
            "sh",
            pidFile,
        );
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        // Agent-side timeout must terminate work rather than merely ending the HTTP wait.
        expect(output.exitCode).toBe(124);
        expect(events(output.stdout).at(-1)).toEqual({ type: "timed_out" });
        await waitForValue({
            description: "timed out child reaped",
            predicate: async () => gone(pid),
        });
    });

    it.each(["SIGINT", "SIGTERM"] as const)(
        "forwards %s interruption to remote cancellation",
        async (signal) => {
            const pidFile = path.join(files.tempDirectory(), "pid");
            const command = exec(
                "--json",
                setup.testAgent.id,
                "--",
                "sh",
                "-c",
                'echo $$ > "$1"; printf ready; exec sleep 60',
                "sh",
                pidFile,
            );
            onTestFinished(async () => {
                if (command.output === null) await command.kill("SIGKILL");
            });
            const pid = await waitForValue({
                description: "remote command started",
                predicate: async () => {
                    const text = await fs
                        .readFile(pidFile, "utf8")
                        .catch(() => "");
                    return Number(text) || undefined;
                },
            });
            await command.kill(signal);
            const output = await command;
            // Local interruption keeps exit 130 but cannot claim agent-acknowledged termination after closing HTTP.
            expect(output.exitCode, output.stderr).toBe(130);
            expect(events(output.stdout).at(-1)).toEqual({
                type: "error",
                message: expect.stringContaining("termination not acknowledged"),
            });
            await waitForValue({
                description: "interrupted remote child reaped",
                predicate: async () => gone(pid),
            });
        },
    );

    it("streams before exit and supports explicit cancellation while output is backpressured", async () => {
        const abort = new AbortController();
        onTestFinished(() => abort.abort());
        const pidFile = path.join(files.tempDirectory(), "pid");
        const response = await api(
            {
                argv: [
                    "sh",
                    "-c",
                    'echo $$ > "$1"; printf ready; exec yes payload',
                    "sh",
                    pidFile,
                ],
                cwd: null,
                env: {},
                timeout_ms: null,
            },
            abort.signal,
        );
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error("Missing execution body");
        onTestFinished(async () => {
            await reader.cancel().catch(() => undefined);
        });
        const first = await reader.read();
        // Receiving bytes from a still-running infinite process proves this is a stream, not buffered completion.
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(
            "application/x-ndjson",
        );
        expect(first.done).toBe(false);
        const echo = await setup.testAgent.echo("responsive during exec");
        expect(echo.message).toBe("responsive during exec");
        const id = response.headers.get("X-Redoor-Execution-Id");
        // Execution output must never create a path-bearing file-transfer entry, even while active.
        expect((await setup.apiClient.getTransferProgress()).transfers).toEqual([]);
        const wrongAgent = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/agents/another-agent/exec/${id}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // An execution id cannot authorize cancellation under a different agent's resource.
        expect(wrongAgent.status).toBe(404);
        const fileCancellation = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/transfers/${id}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // Shared transport ids do not make executions cancellable as filesystem transfers.
        expect(fileCancellation.status).toBe(404);
        const canceled = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/agents/${setup.testAgent.id}/exec/${id}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // Independent control must stop the worker even when the consumer stops reading its infinite output.
        expect(canceled.status).toBe(202);
        const cancellation: CancelExecutionResponse = await canceled.json();
        // The execution endpoint returns an execution handle, not a transfer-progress handle.
        expect(cancellation.execution_id).toBe(Number(id));
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        // Fetch can split NDJSON across reads, so retain the initial bytes when decoding the terminal record.
        let tail = first.value === undefined ? "" : Buffer.from(first.value).toString();
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            tail += Buffer.from(chunk.value).toString();
        }
        // The terminal record is an agent acknowledgement, so the child is already reaped when observed.
        expect(events(tail).at(-1)).toEqual({ type: "canceled" });
        expect(gone(pid)).toBe(true);
        await waitForValue({
            description: "backpressured exec reaped",
            predicate: async () => gone(pid),
        });
        // Canceled executions must stay out of filesystem transfer history.
        expect((await setup.apiClient.getTransferProgress()).transfers).toEqual([]);
    });

    it("returns a transport failure promptly when the agent execution limit rejects admission", async () => {
        const abort = new AbortController();
        onTestFinished(() => abort.abort());
        const responses: Response[] = [];
        for (let index = 0; index < 32; index++) {
            responses.push(
                await api(
                    {
                        argv: ["sleep", "60"],
                        cwd: null,
                        env: {},
                        timeout_ms: null,
                    },
                    abort.signal,
                ),
            );
        }
        const rejected = await exec("--json", setup.testAgent.id, "--", "true");
        // Pre-worker rejection must close the stream rather than hanging forever without an exit event.
        expect(rejected.exitCode, rejected.stderr).toBe(125);
        expect(events(rejected.stdout).at(-1)?.type).toBe("error");
        abort.abort();
        for (const response of responses)
            await response.body?.cancel().catch(() => undefined);
        // A real execution proves admission slots were released; transfer history cannot observe execution cleanup.
        await waitForValue({
            description: "rejected admission cleanup",
            predicate: async () => (await exec(setup.testAgent.id, "--", "true")).exitCode === 0,
        });
    });

    it("validates REST inputs and reports signals without fabricating an exit code", async () => {
        for (const invalid of [
            { argv: [] },
            { cwd: "relative" },
            { env: { "": "bad" } },
            { timeout_ms: 0 },
        ]) {
            const response = await api({
                argv: ["true"],
                cwd: null,
                env: {},
                timeout_ms: null,
                ...invalid,
            });
            // Malformed process inputs must return an HTTP validation error before command admission.
            expect(response.status).toBe(400);
        }
        const response = await api({
            argv: ["sh", "-c", "kill -TERM $$"],
            cwd: null,
            env: {},
            timeout_ms: null,
        });
        const records = events(await response.text());
        // A signaled process carries a null code and an explicit signal for scripts.
        expect(records.at(-1)).toEqual({
            type: "exit",
            code: null,
            signal: 15,
        });
        const signaled = await exec(
            setup.testAgent.id,
            "--",
            "sh",
            "-c",
            "kill -TERM $$",
        );
        // Human-mode exit status follows the conventional 128 + signal mapping without status on stdout.
        expect(signaled.exitCode).toBe(143);
        expect(signaled.stdout).toBe("");
    });

    it("rejects cancellation of completed executions and file-transfer handles", async () => {
        const response = await api({
            argv: ["true"], cwd: null, env: {}, timeout_ms: null,
        });
        await response.text();
        const id = response.headers.get("X-Redoor-Execution-Id");
        const finished = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/agents/${setup.testAgent.id}/exec/${id}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // Completed output no longer owns an execution resource and must not appear cancellable.
        expect(finished.status).toBe(404);
        const destination = path.join(files.tempDirectory(), "file.txt");
        await setup.testAgent.upload(destination, new File(["content"], "file.txt"));
        const transfer = (await setup.apiClient.getTransferProgress()).transfers.find(
            (entry) => entry.path === destination,
        );
        if (transfer === undefined) throw new Error("Missing file transfer fixture");
        const file = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/agents/${setup.testAgent.id}/exec/${transfer.request_id}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // Execution cancellation must not accept another resource merely because its numeric id is valid.
        expect(file.status).toBe(404);
    });

    it("reports lost transport and stops agent work when its server connection disappears", async () => {
        const pidFile = path.join(files.tempDirectory(), "pid");
        const command = exec(
            "--json",
            setup.testAgent.id,
            "--",
            "sh",
            "-c",
            'echo $$ > "$1"; exec sleep 60',
            "sh",
            pidFile,
        );
        onTestFinished(async () => {
            if (command.output === null) await command.kill("SIGKILL");
        });
        const pid = await waitForValue({
            description: "disconnect fixture started",
            predicate: async () =>
                Number(await fs.readFile(pidFile, "utf8").catch(() => "")) ||
                undefined,
        });
        processes.kill(setup.serverPid);
        const output = await command;
        // Network loss must remain a transport error, while generation teardown kills the remote child.
        expect(output.exitCode).toBe(125);
        expect(events(output.stdout).at(-1)?.type).toBe("error");
        await waitForValue({
            description: "disconnected agent child reaped",
            predicate: async () => gone(pid),
        });
    });
});
