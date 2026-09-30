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
    waitForAgentTransfer,
} from "./test-utils";
import type { ArchiveUploadResponse } from "#bindings/ArchiveUploadResponse";
import type { CancelUploadRequestResponse } from "#bindings/CancelUploadRequestResponse";

describe("Remote cp and streaming archive upload", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();
    let setup: Awaited<ReturnType<typeof startServerAndAgent>>;
    let secondId: string;
    let home: string;
    const binary =
        process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");

    beforeAll(async () => {
        setup = await startServerAndAgent({
            processManager: processes,
            agentName: "remote-cp-source",
            agentCwd: files.tempDirectory(),
        });
        const server = processes.getProcess(setup.serverPid);
        if (server === undefined) throw new Error("Missing server process");
        const ready = waitForAgentTransfer(server, "remote-cp-dest");
        processes.spawnAgent({
            wsAddress: setup.wsUrl,
            name: "remote-cp-dest",
            cwd: files.tempDirectory(),
            home: files.tempDirectory(),
        });
        await ready;
        const second = (await setup.apiClient.listAgents()).find(
            (agent) => agent.name === "remote-cp-dest",
        );
        if (second === undefined) throw new Error("Missing second agent");
        secondId = second.id;
        home = files.tempDirectory();
        const directory = path.join(home, ".local/share/cp-test");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        // Seed the cookie issued by the real login API, using the durable cookie_store wire format.
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

    /** Every invocation reloads the saved login and retains stdout/stderr for contract assertions. */
    function cp(...args: string[]) {
        return $({
            env: { ...process.env, HOME: home, REDOOR_APP_NAME: "cp-test" },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote cp ${args}`;
    }

    /** Direct REST requests use the real cookie and deliberately omit Content-Length for streams. */
    function archiveUrl(destination: string, mode = "error") {
        const encoded = destination
            .split("/")
            .filter(Boolean)
            .map(encodeURIComponent)
            .join("/");
        return `${setup.apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(setup.testAgent.id)}/archive/${encoded}?on_existing=${mode}`;
    }

    it("copies files in every direction, handles directory destinations and reports strict conflicts", async () => {
        const root = files.tempDirectory();
        const source = path.join(root, "report: # ?.txt");
        await fs.writeFile(source, "exact file payload");
        const remoteDirectory = files.tempDirectory();
        const remote = `${setup.testAgent.id}:${remoteDirectory}`;
        const localSource = `./${path.relative(process.cwd(), source)}`;
        const upload = await cp("--json", localSource, remote);
        // A separate CLI process must authenticate, percent-encode paths and append the basename.
        expect(upload.exitCode, upload.stderr).toBe(0);
        expect(upload.stderr).toBe("");
        expect(JSON.parse(upload.stdout).resolved_destination).toBe(
            `${remote}/${path.basename(source)}`,
        );
        const conflict = await cp("--json", source, remote);
        // Archive uploads must require an explicit choice to replace an existing destination.
        expect(conflict.exitCode).toBe(1);
        expect(JSON.parse(conflict.stdout).status).toBe("failed");
        await fs.writeFile(source, "replacement");
        const overwrite = await cp(
            "--quiet",
            "--on-existing",
            "override",
            source,
            remote,
        );
        // Quiet suppresses successful progress/completion in both streams.
        expect(overwrite.exitCode, overwrite.stderr).toBe(0);
        expect(overwrite.stdout + overwrite.stderr).toBe("");
        const second = path.join(files.tempDirectory(), "renamed.txt");
        const copy = await cp(
            "--json",
            `${remote}/${path.basename(source)}`,
            `${secondId}:${second}`,
        );
        // Server-side copying must wait for the second agent to publish before returning.
        expect(copy.exitCode, copy.stderr).toBe(0);
        expect(await fs.readFile(second, "utf8")).toBe("replacement");
        const copyConflict = await cp(
            "--json",
            `${remote}/${path.basename(source)}`,
            `${secondId}:${second}`,
        );
        // An asynchronous server-side conflict must become a CLI failure after progress reaches its terminal state.
        expect(copyConflict.exitCode).toBe(1);
        expect(JSON.parse(copyConflict.stdout).status).toBe("failed");
        const downloadDirectory = files.tempDirectory();
        const download = await cp(
            "--json",
            `${secondId}:${second}`,
            downloadDirectory,
        );
        expect(download.exitCode, download.stderr).toBe(0);
        // Existing local directories use exactly the same basename rule as remote destinations.
        expect(
            await fs.readFile(
                path.join(downloadDirectory, "renamed.txt"),
                "utf8",
            ),
        ).toBe("replacement");
        const downloadConflict = await cp(
            "--json",
            `${secondId}:${second}`,
            downloadDirectory,
        );
        // Strict downloads must preserve an existing resolved file rather than silently replacing it.
        expect(downloadConflict.exitCode).toBe(1);
        expect(JSON.parse(downloadConflict.stdout).status).toBe("failed");
        const merge = await cp(
            "--quiet",
            "--on-existing",
            "merge",
            `${secondId}:${second}`,
            downloadDirectory,
        );
        expect(merge.exitCode, merge.stderr).toBe(0);
        const badRemote = await cp(
            "--json",
            localSource,
            `${setup.testAgent.id}:relative`,
        );
        expect(badRemote.exitCode).toBe(1);
        expect(JSON.parse(badRemote.stdout).error).toContain("absolute");
    });

    it.each(["upload", "download", "copy"])(
        "cancels CLI %s on interruption and removes incomplete output",
        async (direction) => {
            const source = path.join(files.tempDirectory(), "large.bin");
            const file = await fs.open(source, "w");
            await file.truncate(1024 * 1024 * 1024);
            await file.close();
            const parent = files.tempDirectory();
            const destination = path.join(parent, "result.bin");
            const remoteSource = `${setup.testAgent.id}:${source}`;
            const args =
                direction === "upload"
                    ? [source, `${setup.testAgent.id}:${destination}`]
                    : direction === "download"
                      ? [remoteSource, destination]
                      : [remoteSource, `${secondId}:${destination}`];
            const command = cp("--json", ...args);
            onTestFinished(async () => {
                if (command.output === null) await command.kill("SIGKILL");
            });
            const active = await waitForValue({
                description: `CLI ${direction} streaming`,
                predicate: async () =>
                    (
                        await setup.apiClient.getTransferProgress()
                    ).transfers.find(
                        (entry) =>
                            entry.state === "active" &&
                            entry.transferred_bytes > 0 &&
                            (direction === "download"
                                ? entry.path === source
                                : entry.dest?.path === destination ||
                                  entry.path === destination),
                    ),
            });
            await command.kill("SIGINT");
            const output = await command;
            // The CLI must handle the signal, report one JSON failure, and exit unsuccessfully.
            expect(output.exitCode, output.stderr).toBe(1);
            expect(JSON.parse(output.stdout).error).toContain("interrupted");
            await waitForValue({
                description: `CLI ${direction} worker cleanup`,
                predicate: async () => {
                    const state = (
                        await setup.apiClient.getTransferProgress()
                    ).transfers.find(
                        (entry) => entry.request_id === active.request_id,
                    );
                    return (
                        state !== undefined &&
                        !["active", "canceling"].includes(state.state) &&
                        (await fs.readdir(parent)).length === 0
                    );
                },
            });
            // Neither local download staging nor remote upload/copy staging may survive interruption.
            expect(await fs.readdir(parent)).toEqual([]);
        },
    );

    it("round-trips recursive archives, renamed roots, empty directories and GNU long paths", async () => {
        const source = files.tempDirectory();
        const longDirectory = "long".repeat(35);
        await fs.mkdir(path.join(source, longDirectory, "empty"), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(source, longDirectory, "file.txt"),
            "nested payload",
        );
        const destination = path.join(files.tempDirectory(), "renamed");
        const remote = `${setup.testAgent.id}:${destination}`;
        const rejected = await cp(source, remote);
        // Directory copies require explicit recursive intent before any upload is admitted.
        expect(rejected.exitCode).toBe(1);
        const upload = await cp("-r", "--json", source, remote);
        expect(upload.exitCode, upload.stderr).toBe(0);
        const secondPath = path.join(files.tempDirectory(), "second-tree");
        const copied = await cp(
            "-r",
            "--quiet",
            remote,
            `${secondId}:${secondPath}`,
        );
        expect(copied.exitCode, copied.stderr).toBe(0);
        const local = path.join(files.tempDirectory(), "downloaded");
        const downloaded = await cp(
            "-r",
            "--json",
            `${secondId}:${secondPath}`,
            local,
        );
        expect(downloaded.exitCode, downloaded.stderr).toBe(0);
        // Extraction must remove only the server's archive root, not add an extra source-name layer.
        expect(
            await fs.readFile(
                path.join(local, longDirectory, "file.txt"),
                "utf8",
            ),
        ).toBe("nested payload");
        expect(
            (
                await fs.stat(path.join(local, longDirectory, "empty"))
            ).isDirectory(),
        ).toBe(true);
        const resolved = path.join(local, path.basename(secondPath));
        await fs.mkdir(resolved);
        await fs.writeFile(path.join(resolved, "destination-only"), "keep");
        const merged = await cp(
            "-r",
            "--quiet",
            "--on-existing",
            "merge",
            `${secondId}:${secondPath}`,
            local,
        );
        expect(merged.exitCode, merged.stderr).toBe(0);
        // Merge preserves destination-only entries inside the resolved resulting tree.
        expect(
            await fs.readFile(path.join(resolved, "destination-only"), "utf8"),
        ).toBe("keep");
        const overridden = await cp(
            "-r",
            "--quiet",
            "--on-existing",
            "override",
            `${secondId}:${secondPath}`,
            local,
        );
        expect(overridden.exitCode, overridden.stderr).toBe(0);
        expect(
            await fs
                .stat(path.join(resolved, "destination-only"))
                .catch(() => null),
        ).toBeNull();
    });

    it("keeps control requests responsive during chunked archives and cleans up canceled uploads", async () => {
        const source = files.tempDirectory();
        await fs.writeFile(path.join(source, "file.txt"), "archive payload");
        const tarPath = files.tempFile({ suffix: ".tar" });
        await $({ quiet: true })`tar -cf ${tarPath} -C ${source} file.txt`;
        const tar = await fs.readFile(tarPath);
        const parent = files.tempDirectory();
        const destination = path.join(parent, "tree");
        const abort = new AbortController();
        onTestFinished(() => abort.abort());
        let bodyController:
            ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                bodyController = controller;
                controller.enqueue(tar.subarray(0, 512));
            },
        });
        const token = randomUUID();
        const request: RequestInit & { duplex: "half" } = {
            method: "PUT",
            headers: {
                ...setup.apiClient.getAuthHeaders(),
                "X-Redoor-Upload-Request": token,
            },
            body,
            duplex: "half",
            signal: abort.signal,
        };
        const uploading = fetch(archiveUrl(destination), request).catch(
            () => undefined,
        );
        const transfer = await waitForValue({
            description: "chunked archive admitted",
            predicate: async () =>
                (await setup.apiClient.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.path === destination && entry.state === "active",
                ),
        });
        const echo = await setup.testAgent.echo("control still responsive");
        // The body remains blocked, so echo success proves control is independent of payload IO.
        expect(echo.message).toBe("control still responsive");
        const competing = path.join(parent, "competing");
        const duplicate = await fetch(archiveUrl(competing), {
            method: "PUT",
            headers: {
                ...setup.apiClient.getAuthHeaders(),
                "X-Redoor-Upload-Request": token,
            },
            body: tar,
        });
        // A second request must not take ownership of the first upload's cancellation token.
        expect(duplicate.status).toBe(409);
        expect(await fs.stat(competing).catch(() => null)).toBeNull();
        const malformed = await fetch(archiveUrl(competing), {
            method: "PUT",
            headers: {
                ...setup.apiClient.getAuthHeaders(),
                "X-Redoor-Upload-Request": "invalid",
            },
            body: tar,
        });
        // Header validation must fail before starting a competing agent extraction worker.
        expect(malformed.status).toBe(400);
        const canceled = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/upload-requests/${token}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        const cancellation: CancelUploadRequestResponse = await canceled.json();
        // Correlation must cancel this upload without relying on an ambiguous destination-path lookup.
        expect(canceled.status).toBe(200);
        expect(cancellation.request_token).toBe(token);
        if (cancellation.transfer === null)
            throw new Error(
                "A streaming upload must already have an active transfer ID",
            );
        expect(cancellation.transfer.transfer_id).toBe(transfer.request_id);
        abort.abort();
        await uploading;
        bodyController?.close();
        await waitForValue({
            description: "canceled archive staging removed",
            predicate: async () => (await fs.readdir(parent)).length === 0,
        });
        // Cancellation must leave neither the result nor a partial extracted staging directory.
        expect(await fs.readdir(parent)).toEqual([]);
        const successfulToken = randomUUID();
        const successful = await fetch(archiveUrl(destination), {
            method: "PUT",
            headers: {
                ...setup.apiClient.getAuthHeaders(),
                "X-Redoor-Upload-Request": successfulToken,
            },
            body: tar,
        });
        const result: ArchiveUploadResponse = await successful.json();
        // The dedicated response confirms tar worker completion and reports its streamed byte count.
        expect(successful.status).toBe(200);
        expect(result).toEqual({
            path: destination,
            bytes_written: tar.length,
        });
        const noLongerActive = await fetch(
            `${setup.apiClient.baseUrl}/api/v1/upload-requests/${successfulToken}`,
            { method: "DELETE", headers: setup.apiClient.getAuthHeaders() },
        );
        // Completed HTTP handlers must release token mappings rather than retaining an unbounded registry.
        expect(noLongerActive.status).toBe(404);
        const conflict = await fetch(archiveUrl(destination), {
            method: "PUT",
            headers: setup.apiClient.getAuthHeaders(),
            body: tar,
        });
        expect(conflict.status).toBe(409);
        await fs.writeFile(path.join(destination, "destination-only"), "keep");
        const merged = await fetch(archiveUrl(destination, "merge"), {
            method: "PUT",
            headers: setup.apiClient.getAuthHeaders(),
            body: tar,
        });
        // Archive uploads must expose the same merge policy as server-side copies.
        expect(merged.status).toBe(200);
        expect(
            await fs.readFile(
                path.join(destination, "destination-only"),
                "utf8",
            ),
        ).toBe("keep");
        const replaced = await fetch(archiveUrl(destination, "override"), {
            method: "PUT",
            headers: setup.apiClient.getAuthHeaders(),
            body: tar,
        });
        expect(replaced.status).toBe(200);
        expect(
            await fs
                .stat(path.join(destination, "destination-only"))
                .catch(() => null),
        ).toBeNull();
    });

    it("requires complete tar termination before creating or overriding destinations", async () => {
        const source = files.tempDirectory();
        await fs.writeFile(path.join(source, "file.txt"), "payload");
        const tarPath = files.tempFile({ suffix: ".tar" });
        await $({ quiet: true })`tar -cf ${tarPath} -C ${source} file.txt`;
        const tar = await fs.readFile(tarPath);
        const invalidBodies = [
            Buffer.alloc(0),
            tar.subarray(0, 1024), // Complete member, no terminators.
            tar.subarray(0, 1536), // Missing second zero terminator.
            tar.subarray(0, 515), // Truncated payload.
            tar.subarray(0, 700), // Truncated member padding.
            tar.subarray(0, 1800), // Truncated second terminator.
            Buffer.concat([tar, Buffer.from("trailing garbage")]),
            Buffer.concat([tar, Buffer.alloc(512, 120)]),
            Buffer.concat([tar, Buffer.alloc(1)]),
        ];
        for (const existing of [false, true]) {
            for (const body of invalidBodies) {
                const parent = files.tempDirectory();
                const destination = path.join(parent, "result");
                if (existing) {
                    await fs.mkdir(destination);
                    await fs.writeFile(
                        path.join(destination, "keep.txt"),
                        "original",
                    );
                }
                const response = await fetch(
                    archiveUrl(destination, "override"),
                    {
                        method: "PUT",
                        headers: setup.apiClient.getAuthHeaders(),
                        body,
                    },
                );
                // Even a complete extracted member must not authorize publication without valid termination.
                expect(
                    response.ok,
                    `existing=${existing}, bytes=${body.length}`,
                ).toBe(false);
                await response.text();
                await waitForValue({
                    description: "invalid archive staging removed",
                    predicate: async () =>
                        (await fs.readdir(parent)).every(
                            (name) => name === "result",
                        ),
                });
                // Failed overrides must preserve the entire old tree and failed new uploads must publish nothing.
                expect(await fs.readdir(parent)).toEqual(
                    existing ? ["result"] : [],
                );
                if (existing) {
                    expect(await fs.readdir(destination)).toEqual(["keep.txt"]);
                    expect(
                        await fs.readFile(
                            path.join(destination, "keep.txt"),
                            "utf8",
                        ),
                    ).toBe("original");
                }
            }
        }
        for (const body of [
            tar,
            tar.subarray(0, 2048),
            Buffer.alloc(1024),
            Buffer.alloc(10240),
        ]) {
            const parent = files.tempDirectory();
            const destination = path.join(parent, "result");
            await fs.mkdir(destination);
            await fs.writeFile(path.join(destination, "old.txt"), "old");
            const response = await fetch(archiveUrl(destination, "override"), {
                method: "PUT",
                headers: setup.apiClient.getAuthHeaders(),
                body,
            });
            // Both minimal and record-padded termination must permit legitimate replacement, including empty trees.
            expect(response.status).toBe(200);
            expect((await response.json()).bytes_written).toBe(body.length);
            expect(await fs.readdir(parent)).toEqual(["result"]);
            const hasFile = body === tar || body.length === 2048;
            expect(await fs.readdir(destination)).toEqual(
                hasFile ? ["file.txt"] : [],
            );
            if (hasFile) {
                expect(
                    await fs.readFile(
                        path.join(destination, "file.txt"),
                        "utf8",
                    ),
                ).toBe("payload");
            }
        }
    });

    it("keeps a terminated archive reversible until the producer ends and validates late bytes", async () => {
        const parent = files.tempDirectory();
        const destination = path.join(parent, "result");
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "keep.txt"), "original");
        const abort = new AbortController();
        onTestFinished(() => abort.abort());
        let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                producer = controller;
                controller.enqueue(Buffer.alloc(1024));
            },
        });
        const request: RequestInit & { duplex: "half" } = {
            method: "PUT",
            headers: setup.apiClient.getAuthHeaders(),
            body,
            duplex: "half",
            signal: abort.signal,
        };
        const uploading = fetch(archiveUrl(destination, "override"), request);
        await waitForValue({
            description: "terminated archive still receiving producer bytes",
            predicate: async () =>
                (await setup.apiClient.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.path === destination &&
                        entry.transferred_bytes === 1024 &&
                        entry.state === "active",
                ),
        });
        // A complete terminator cannot make publication irreversible while the HTTP producer is still active.
        expect(
            await fs.readFile(path.join(destination, "keep.txt"), "utf8"),
        ).toBe("original");
        expect((await setup.testAgent.echo("draining archive")).message).toBe(
            "draining archive",
        );
        if (producer === undefined) throw new Error("Missing archive producer");
        producer.enqueue(Buffer.alloc(512, 120));
        producer.close();
        const response = await uploading;
        // Garbage arriving in a later transport chunk must invalidate the otherwise complete empty archive.
        expect(response.ok).toBe(false);
        await response.text();
        await waitForValue({
            description: "late invalid archive staging removed",
            predicate: async () => (await fs.readdir(parent)).length === 1,
        });
        // Cleanup and rejection must preserve the previous destination even after valid terminators were sent.
        expect(await fs.readdir(parent)).toEqual(["result"]);
        expect(await fs.readdir(destination)).toEqual(["keep.txt"]);
        expect(
            await fs.readFile(path.join(destination, "keep.txt"), "utf8"),
        ).toBe("original");
    });

    it("rejects oversized GNU and PAX metadata declarations without publishing a tree", async () => {
        const source = files.tempDirectory();
        await fs.writeFile(path.join(source, "file.txt"), "payload");
        const tarPath = files.tempFile({ suffix: ".tar" });
        await $({ quiet: true })`tar -cf ${tarPath} -C ${source} file.txt`;
        const tar = await fs.readFile(tarPath);
        for (const kind of ["L", "K", "x", "g"]) {
            const header = Buffer.from(tar.subarray(0, 512));
            header[156] = kind.charCodeAt(0);
            header.fill(0, 124, 136);
            header.write((8 * 1024 ** 3).toString(8).padStart(11, "0"), 124);
            header.fill(32, 148, 156);
            const checksum = header.reduce((sum, byte) => sum + byte, 0);
            header.write(checksum.toString(8).padStart(6, "0"), 148);
            header[154] = 0;
            header[155] = 32;
            const parent = files.tempDirectory();
            const response = await fetch(archiveUrl(path.join(parent, "result")), {
                method: "PUT",
                headers: setup.apiClient.getAuthHeaders(),
                body: header,
            });
            // A header-only huge declaration must be input rejection, not truncated-metadata/internal failure.
            expect(response.status).toBe(400);
            expect((await response.json()).error).toContain("64 KiB limit");
            await waitForValue({
                description: "oversized metadata staging removed",
                predicate: async () => (await fs.readdir(parent)).length === 0,
            });
            // Rejected metadata must leave neither a published destination nor staging state.
            expect(await fs.readdir(parent)).toEqual([]);
        }
    });

    it("rejects escaping, linked and truncated archive members without publishing partial trees", async () => {
        const source = files.tempDirectory();
        await fs.writeFile(path.join(source, "file.txt"), "payload");
        const tarPath = files.tempFile({ suffix: ".tar" });
        await $({ quiet: true })`tar -cf ${tarPath} -C ${source} file.txt`;
        const tar = await fs.readFile(tarPath);
        const escaping = Buffer.from(tar);
        escaping.fill(0, 0, 100);
        escaping.write("../escaped", 0);
        escaping.fill(32, 148, 156);
        const checksum = escaping
            .subarray(0, 512)
            .reduce((sum, byte) => sum + byte, 0);
        escaping.write(checksum.toString(8).padStart(6, "0"), 148);
        escaping[154] = 0;
        escaping[155] = 32;
        await fs.symlink("file.txt", path.join(source, "link"));
        await $({ quiet: true })`tar -cf ${tarPath} -C ${source} link`;
        const linked = await fs.readFile(tarPath);
        for (const body of [escaping, linked, tar.subarray(0, 515)]) {
            const parent = files.tempDirectory();
            const destination = path.join(parent, "result");
            const response = await fetch(archiveUrl(destination), {
                method: "PUT",
                headers: setup.apiClient.getAuthHeaders(),
                body,
            });
            // Invalid extraction must report failure, not a completed archive response.
            expect(response.ok).toBe(false);
            await waitForValue({
                description: "failed archive staging removed",
                predicate: async () => (await fs.readdir(parent)).length === 0,
            });
            expect(await fs.readdir(parent)).toEqual([]);
        }
    });
});
