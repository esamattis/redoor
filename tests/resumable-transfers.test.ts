import {
    beforeAll,
    afterAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import type { Proxy } from "toxiproxy-node-client";
import { createMcpTestClient, type JsonObject } from "./mcp-client";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { ApiClient, type Agent } from "#ui/api-client";
import type { ResumableTransfer } from "#bindings/ResumableTransfer";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
    waitForPort,
    createToxiproxyAgent,
    TEST_USERNAME,
    TEST_PASSWORD,
    createAccessToken,
} from "./test-utils";

/** Mirrors `SEGMENT_SIZE` in crates/redoor-core/src/partials.rs: resume reuses whole segments only. */
const SEGMENT_SIZE = 64 * 1024 * 1024;

/**
 * Cross-agent copies stream at roughly 200 MB/s on a dev machine, so four segments leave a
 * multi-segment tail (~1 s) after the just-over-one-segment pause threshold. That keeps the
 * pause landing mid-stream with a wide margin while halving the bytes copied and hashed.
 */
const CROSS_AGENT_SIZE = 4 * SEGMENT_SIZE;

/**
 * Same-agent copies run at several GB/s and were observed ~170 MB in by the time the pause
 * arrived, so they keep eight segments to stay well clear of publishing before the pause.
 */
const LOCAL_SIZE = 8 * SEGMENT_SIZE;

/** Streaming digest checks exact content without allocating the large test file. */
async function digest(file: string) {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(file)) hash.update(chunk);

    return hash.digest("hex");
}

describe("resumable transfers", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();
    let api: ApiClient;
    let source: Agent;
    let dest: Agent;
    let root: string;
    let dataDir: string;
    let sourceHome: string;
    let destinationHome: string;
    let destPid: number;
    let serverPid: number;
    let sourcePid: number;
    let sourceWsUrl: string;
    let destWsUrl: string;
    let destinationProxy: Proxy | undefined;
    let serverPort: number;

    beforeAll(async () => {
        root = files.tempDirectory({ suffix: "-resumable" });
        const agentHome = files.tempDirectory({ suffix: "-resumable-home" });
        sourceHome = agentHome;

        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: "resume-source",
            agentCwd: root,
            agentEnv: {
                HOME: agentHome,
                REDOOR_APP_NAME: "redoor-resume-source",
            },
        });

        api = setup.apiClient;
        serverPid = setup.serverPid;
        sourcePid = setup.agentPid;
        sourceWsUrl = setup.wsUrl;
        serverPort = setup.serverPort;
        source = setup.testAgent;

        const destHome = files.tempDirectory({
            suffix: "-resumable-dest-home",
        });

        destinationHome = destHome;
        dataDir = path.join(
            destHome,
            ".local/share/redoor-resume-dest/partials",
        );

        const proxied = await createToxiproxyAgent({
            serverPort,
            agent: source,
            proxyNamePrefix: "resumable-destination",
        });

        const proxy = proxied.proxy;
        destinationProxy = proxy;
        destWsUrl = `ws://${proxy.listen}/ws`;
        destPid = processes.spawnAgent({
            wsAddress: destWsUrl,
            name: "resume-dest",
            cwd: root,
            home: root,
            env: { HOME: destHome, REDOOR_APP_NAME: "redoor-resume-dest" },
        });
        dest = await waitForValue({
            description: "destination registration",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.name === "resume-dest" &&
                        agent.status === "connected",
                ),
        });
        // This starts a server, two agents and a proxy; the server readiness helper alone
        // allows 30 s under parallel suite load, so its enclosing hook must allow that too.
    }, 30_000);

    afterAll(async () => {
        await processes.killAll();
        await destinationProxy?.remove();
        files.cleanup();
    });

    /** Keeps the durable namespace while replacing its process, including startup cleanup. */
    async function restartDestination() {
        process.kill(-destPid, "SIGKILL");
        await processes.waitForExit(destPid);
        await waitForValue({
            description: "destination disconnected",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.id === dest.id && agent.status === "disconnected",
                ),
        });
        destPid = processes.spawnAgent({
            wsAddress: destWsUrl,
            name: "resume-dest",
            cwd: root,
            home: root,
            env: {
                HOME: destinationHome,
                REDOOR_APP_NAME: "redoor-resume-dest",
            },
        });
        await api.waitForConnectedAgentNames(["resume-dest"], 30000);
    }

    /** Each test owns its paths and discards unfinished output before fixture teardown. */
    async function paused(
        local = false,
        move = false,
        options?: {
            stop?: (id: number) => Promise<void>;
            checkBusy?: boolean;
        },
    ): Promise<{
        sourcePath: string;
        destPath: string;
        partial: ResumableTransfer;
        id: number;
    }> {
        const sourcePath = path.join(root, `source-${crypto.randomUUID()}`);
        const destPath = `${sourcePath}-dest`;
        const destination = local ? source : dest;
        let id: number | undefined;
        onTestFinished(async () => {
            if (id !== undefined)
                await api.cancelTransfer(id).catch(() => undefined);
            const partials = await api.listPartials();
            await Promise.all(
                partials.partials
                    .filter((partial) => partial.dest.path === destPath)
                    .map((partial) => api.discardPartial(partial)),
            );
            await fs.rm(sourcePath, { force: true });
            await fs.rm(destPath, { force: true });
        });

        // A same-agent copy finishes about 170 ms after crossing the pause threshold, so one
        // progress poll stalled by suite load can miss the whole mid-stream window. Finishing
        // before it was seen is not a fault of the feature under test, so such an attempt starts
        // over with fresh fixtures.
        for (let attempt = 1; ; attempt += 1) {
            await fs.rm(destPath, { force: true });
            const file = await fs.open(sourcePath, "w");
            await file.truncate(local ? LOCAL_SIZE : CROSS_AGENT_SIZE);
            await file.write(Buffer.from("source marker"), 0, 13, 0);
            await file.close();

            if (local && move) {
                // Merge requires an existing destination to force the copy-and-delete branch.
                await fs.writeFile(destPath, "existing destination");
            }

            id = move
                ? (
                      await source.moveTo(
                          { agent: destination.id, path: destPath },
                          sourcePath,
                          { on_existing: "merge" },
                      )
                  ).move_request_id
                : (
                      await source.copyTo(
                          { agent: destination.id, path: destPath },
                          sourcePath,
                      )
                  ).copy_request_id;
            const transferId = id;

            const observed = await waitForValue({
                description: "copy has a durable prefix",
                intervalMs: 1,
                predicate: async () => {
                    const transfer = (
                        await api.getTransferProgress()
                    ).transfers.find(
                        (entry) => entry.request_id === transferId,
                    );

                    if (transfer?.state === "completed") {
                        return "finished";
                    }

                    return transfer?.state === "active" &&
                        transfer.transferred_bytes >= 70 * 1024 * 1024 &&
                        transfer.pausable &&
                        transfer.cancelable
                        ? "mid-stream"
                        : undefined;
                },
            });

            if (observed === "mid-stream") {
                break;
            }

            // Repeatedly finishing first would mean the copy can no longer be interrupted at all.
            expect(
                attempt,
                "copy kept finishing before it was seen mid-stream",
            ).toBeLessThan(3);
        }

        if (options?.checkBusy) {
            // Concurrent admission must leave the first attempt's private staging untouched.
            await expect(
                source.copyTo(
                    { agent: destination.id, path: destPath },
                    sourcePath,
                ),
            ).rejects.toThrow(/active transfer/i);
            expect(
                (await api.listPartials()).partials.some(
                    (partial) => partial.dest.path === destPath,
                ),
                "active output must not be offered for resume",
            ).toBe(false);
        }

        if (options?.stop) {
            await options.stop(id);
        } else {
            await api.pauseTransfer(id);
        }

        // Pause acknowledges durability and removes every active/history row for this attempt.
        expect(
            (await api.getTransferProgress()).transfers.some(
                (transfer) => transfer.request_id === id,
            ),
        ).toBe(Boolean(options?.stop));

        const partial = await waitForValue({
            description: "stopped partial rediscovery",
            predicate: async () =>
                (await api.listPartials()).partials.find(
                    (partial) => partial.dest.path === destPath,
                ),
        });

        expect(
            partial,
            "durable partials must be discoverable immediately after pause",
        ).toBeDefined();

        if (!partial) throw new Error("Missing paused partial");
        expect(
            partial.partial_bytes,
            "partial length must reflect actual on-disk writes",
        ).toBeGreaterThan(0);

        return { sourcePath, destPath, partial, id };
    }

    /** Completion must publish exact verified contents under a new transfer id. */
    async function completed(id: number, sourcePath: string, destPath: string) {
        const transfer = await waitForValue({
            description: "resumed publication",
            timeoutMs: 30000,
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === id &&
                        entry.state !== "active" &&
                        entry.state !== "canceling",
                ),
        });

        expect(
            transfer.state,
            "resume must publish rather than merely finish streaming",
        ).toBe("completed");

        // Hashing both files concurrently keeps the full byte-exact check at half the wall time.
        const [destDigest, sourceDigest] = await Promise.all([
            digest(destPath),
            digest(sourcePath),
        ]);

        expect(
            destDigest,
            "prefix and tail must match the source byte for byte",
        ).toBe(sourceDigest);
        expect(
            (await api.listPartials()).partials.some(
                (partial) => partial.dest.path === destPath,
            ),
            "publication must remove its manifest",
        ).toBe(false);

        return transfer;
    }

    it("pauses, probes, and resumes a cross-agent copy", async () => {
        const proxy = destinationProxy;

        if (proxy === undefined)
            throw new Error("Destination proxy was not started");

        // Keep the copy active across the busy-admission and inventory round trips.
        // Otherwise a fast CI runner can publish the file before pause reaches the router.
        const bandwidth = await proxy.addToxic({
            name: "hold-copy-open-for-busy-check",
            type: "bandwidth",
            stream: "downstream",
            toxicity: 1,
            attributes: { rate: 32 * 1024 },
        });

        let bandwidthRemoved = false;
        onTestFinished(async () => {
            if (!bandwidthRemoved) await bandwidth.remove();
        });
        const run = await paused(false, false, { checkBusy: true });
        await bandwidth.remove();
        bandwidthRemoved = true;

        const preflight = await api.copyPreflight({
            source: run.partial.source,
            dest: run.partial.dest,
        });

        expect(
            preflight.resume_candidate?.partial_bytes,
            "preflight is a cheap metadata probe",
        ).toBe(run.partial.partial_bytes);
        const resumed = await api.resumePartial(run.partial);
        expect(resumed.transfer_id, "resume creates a fresh attempt").not.toBe(
            run.id,
        );

        const transfer = await completed(
            resumed.transfer_id,
            run.sourcePath,
            run.destPath,
        );

        expect(
            transfer.resumed_bytes,
            "whole matching segments are reused",
        ).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }, 30000);

    it("resumes after toxiproxy interrupts the destination connection", async () => {
        const proxy = destinationProxy;

        if (proxy === undefined)
            throw new Error("Destination proxy was not started");

        const run = await paused(false, false, {
            stop: async (id) => {
                await proxy.update({
                    enabled: false,
                    listen: proxy.listen,
                    upstream: proxy.upstream,
                });
                onTestFinished(async () => {
                    await proxy.update({
                        enabled: true,
                        listen: proxy.listen,
                        upstream: proxy.upstream,
                    });
                });

                const failed = await waitForValue({
                    description: "interrupted copy outcome",
                    predicate: async () =>
                        (await api.getTransferProgress()).transfers.find(
                            (entry) =>
                                entry.request_id === id &&
                                entry.state === "errored",
                        ),
                });

                // Interruptions retain progress while ending the old attempt visibly.
                expect(failed.error).toContain("partial kept");
                await proxy.update({
                    enabled: true,
                    listen: proxy.listen,
                    upstream: proxy.upstream,
                });
            },
        });

        const copy = await source.copyTo(run.partial.dest, run.sourcePath);

        const transfer = await completed(
            copy.copy_request_id,
            run.sourcePath,
            run.destPath,
        );

        // Re-initiating uses the same automatic resume negotiation as the inventory button.
        expect(transfer.resumed_bytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }, 30000);

    it("pausing during verification persists the saved partial before acknowledgement", async () => {
        const run = await paused();
        const manifestPath = path.join(dataDir, `${run.partial.key}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        manifest.updated_at = 1;
        await fs.writeFile(manifestPath, JSON.stringify(manifest));

        const resumed = await source.copyTo(run.partial.dest, run.sourcePath, {
            on_existing: "override",
        });

        // Admission returns while hashing, allowing pause without waiting for a large prefix.
        await api.pauseTransfer(resumed.copy_request_id);
        const persisted = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        expect(
            persisted.updated_at,
            "verification pause must acknowledge an agent-side durable refresh",
        ).toBeGreaterThan(1);
        expect(
            persisted.signed.authorization.on_existing,
            "a verification pause must retain the current publication policy",
        ).toBe("override");
        expect(
            (await api.getTransferProgress()).transfers.some(
                (entry) => entry.request_id === resumed.copy_request_id,
            ),
            "successful pause removes the verification attempt entirely",
        ).toBe(false);
        const next = await api.resumePartial(run.partial);
        await completed(next.transfer_id, run.sourcePath, run.destPath);
    });

    it("MCP defaults to resuming a paused copy", async () => {
        const run = await paused();

        const created = await createAccessToken(api, {
            name: "resumable-copy-test",
            permissions: ["files:read", "files:write"],
            devices: { kind: "only", device_ids: [source.id, dest.id] },
        });

        const client = createMcpTestClient({
            endpoint: `http://127.0.0.1:${serverPort}/mcp`,
            token: created.token,
        });

        const copy = await client.callTool<
            JsonObject & { operation_id: string }
        >("copy_path", {
            source: { device_id: source.id, path: run.sourcePath },
            destination: { device_id: dest.id, path: run.destPath },
            on_existing: "error",
        });

        const operationId = copy.result.structuredContent?.operation_id;

        if (operationId === undefined) throw new Error("Missing MCP operation");
        await client.waitForOperation(operationId);

        const transfer = (await api.getTransferProgress()).transfers.find(
            (entry) =>
                entry.dest?.path === run.destPath &&
                entry.state === "completed",
        );

        // Omitting resume must reuse the authorized prefix, including from MCP clients.
        expect(transfer?.resumed_bytes).toBeGreaterThanOrEqual(
            64 * 1024 * 1024,
        );

        const [destDigest, sourceDigest] = await Promise.all([
            digest(run.destPath),
            digest(run.sourcePath),
        ]);

        expect(destDigest, "MCP publication verifies the entire file").toBe(
            sourceDigest,
        );
    // Prefix creation, the 30 s MCP operation budget and full-file hashing must all fit
    // inside this test's deadline when integration and browser workers share the CPU.
    }, 60_000);

    it("resumes a local copy after an agent crash", async () => {
        const run = await paused(true, false, {
            stop: async (id) => {
                process.kill(-sourcePid, "SIGKILL");
                await processes.waitForExit(sourcePid);
                await waitForValue({
                    description: "crashed local copy outcome",
                    predicate: async () =>
                        (await api.getTransferProgress()).transfers.find(
                            (entry) =>
                                entry.request_id === id &&
                                entry.state === "errored",
                        ),
                });
                sourcePid = processes.spawnAgent({
                    wsAddress: sourceWsUrl,
                    name: "resume-source",
                    cwd: root,
                    home: root,
                    env: {
                        HOME: sourceHome,
                        REDOOR_APP_NAME: "redoor-resume-source",
                    },
                });
            },
        });

        const copy = await source.copyTo(run.partial.dest, run.sourcePath);

        const transfer = await completed(
            copy.copy_request_id,
            run.sourcePath,
            run.destPath,
        );

        // A crash runs no stop handler, so rediscovery must rely on creation-time metadata.
        expect(transfer.resumed_bytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }, 30000);

    it("user cancellation while appending discards the partial and manifest", async () => {
        const run = await paused();
        const resumed = await api.resumePartial(run.partial);
        await waitForValue({
            description: "resumed tail is streaming",
            intervalMs: 1,
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === resumed.transfer_id &&
                        entry.state === "active" &&
                        !entry.verifying &&
                        entry.transferred_bytes > entry.resumed_bytes,
                ),
        });
        await api.cancelTransfer(resumed.transfer_id);
        await waitForValue({
            description: "canceled resumable tail",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === resumed.transfer_id &&
                        entry.state === "canceled",
                ),
        });
        // User cancellation acknowledges deletion, unlike a recoverable interruption.
        expect(
            (await api.listPartials()).partials.some(
                (entry) => entry.key === run.partial.key,
            ),
        ).toBe(false);
        await expect(
            fs.stat(path.join(dataDir, `${run.partial.key}.json`)),
        ).rejects.toThrow();
    });

    it("verifies and repairs a corrupted local copy prefix", async () => {
        const run = await paused(true);

        const manifest = JSON.parse(
            await fs.readFile(
                path.join(
                    sourceHome,
                    ".local/share/redoor-resume-source/partials",
                    `${run.partial.key}.json`,
                ),
                "utf8",
            ),
        );

        const file = await fs.open(manifest.partial_path, "r+");
        await file.write(Buffer.from("x"), 0, 1, 3);
        await file.close();
        const resumed = await api.resumePartial(run.partial);

        const transfer = await completed(
            resumed.transfer_id,
            run.sourcePath,
            run.destPath,
        );

        expect(
            transfer.resumed_bytes,
            "the first damaged segment must be recopied",
        ).toBe(0);
    });

    it("ignores changed sources and starts fresh", async () => {
        const run = await paused();
        const file = await fs.open(run.sourcePath, "r+");
        await file.write(Buffer.from("changed"), 0, 7, 0);
        await file.close();
        expect(
            (
                await api.copyPreflight({
                    source: run.partial.source,
                    dest: run.partial.dest,
                })
            ).resume_candidate,
            "stale source identities must never be offered to the user",
        ).toBeNull();
        const resumed = await api.resumePartial(run.partial);

        const transfer = await completed(
            resumed.transfer_id,
            run.sourcePath,
            run.destPath,
        );

        expect(
            transfer.resumed_bytes,
            "changed source starts from byte zero",
        ).toBe(0);
    });

    it("rejects tampered authorization and permits explicit discard", async () => {
        const run = await paused();
        const manifestPath = path.join(dataDir, `${run.partial.key}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        manifest.signed.authorization.source_path = "/private/source";
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        expect(
            (await api.listPartials()).partials.some(
                (partial) => partial.key === run.partial.key,
            ),
            "invalid signatures must be omitted",
        ).toBe(false);
        await expect(
            api.resumePartial(run.partial),
            "resume must re-read and verify authorization",
        ).rejects.toThrow("Invalid partial signature");
        await api.discardPartial(run.partial);
        await expect(
            fs.stat(manifest.partial_path),
            "discard removes the owned partial",
        ).rejects.toThrow();
        await expect(
            fs.stat(manifestPath),
            "discard removes its metadata too",
        ).rejects.toThrow();
    });

    it("resumes copy-and-delete moves and preserves sources until publication", async () => {
        const run = await paused(true, true);
        const originalHash = await digest(run.sourcePath);
        // Pausing a move must retain its source until verified publication completes.
        expect((await fs.stat(run.sourcePath)).size).toBe(LOCAL_SIZE);
        const resumed = await api.resumePartial(run.partial);

        const transfer = await waitForValue({
            description: "resumed move",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === resumed.transfer_id &&
                        entry.state !== "active" &&
                        entry.state !== "canceling",
                ),
        });

        expect(
            transfer.state,
            "the copy/delete move must finish both phases",
        ).toBe("completed");
        expect(
            await digest(run.destPath),
            "publication must precede destructive source cleanup",
        ).toBe(originalHash);
        await expect(
            fs.stat(run.sourcePath),
            "a successfully resumed move deletes exactly its original source",
        ).rejects.toThrow();
    });

    it("atomic rename removes a leftover move partial", async () => {
        const run = await paused(true, true);

        const moved = await source.moveTo(run.partial.dest, run.sourcePath, {
            on_existing: "override",
        });

        const transfer = await waitForValue({
            description: "atomic move after pause",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === moved.move_request_id &&
                        entry.state === "completed",
                ),
        });

        // A same-filesystem rename bypasses resumable staging and cleans the previous attempt.
        expect(transfer.atomic).toBe(true);
        expect(
            (await api.listPartials()).partials.some(
                (partial) => partial.key === run.partial.key,
            ),
        ).toBe(false);
    });

    it("startup cleanup expires owned partials and their manifests", async () => {
        const run = await paused();
        const manifestPath = path.join(dataDir, `${run.partial.key}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        manifest.updated_at = 0;
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        await restartDestination();
        // Startup must clean stale disk output without depending on a server inventory request.
        await expect(fs.stat(manifestPath)).rejects.toThrow();
        await expect(fs.stat(manifest.partial_path)).rejects.toThrow();
        expect(
            (await api.listPartials()).partials.some(
                (partial) => partial.key === run.partial.key,
            ),
        ).toBe(false);
    }, 30000);

    it("rediscovers a partial after both destination and server restarts", async () => {
        const run = await paused();
        await restartDestination();
        await waitForValue({
            description: "restarted destination partial",
            predicate: async () =>
                (await api.listPartials()).partials.find(
                    (partial) => partial.key === run.partial.key,
                ),
        });
        const serverExit = processes.waitForExit(serverPid);
        processes.kill(serverPid);
        await serverExit;
        serverPid = processes.spawnServer({});
        await waitForPort(serverPort);
        await api.login(TEST_USERNAME, TEST_PASSWORD);
        // Inventory can appear before the source reconnects; resume requires both endpoints.
        await api.waitForConnectedAgentNames(
            ["resume-source", "resume-dest"],
            30000,
        );

        const partial = await waitForValue({
            description: "server restart rebuilds signed inventory",
            predicate: async () =>
                (await api.listPartials()).partials.find(
                    (partial) => partial.key === run.partial.key,
                ),
        });

        // Discovery after independent restarts proves neither side relies on process resume state.
        expect(partial.partial_bytes).toBe(run.partial.partial_bytes);
        const resumed = await api.resumePartial(partial);
        await completed(resumed.transfer_id, run.sourcePath, run.destPath);
    }, 30000);

    it("repairs a corrupted cross-agent prefix and rejects a manifest on another agent", async () => {
        const run = await paused();
        const manifestPath = path.join(dataDir, `${run.partial.key}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

        const otherPath = path.join(
            sourceHome,
            ".local/share/redoor-resume-source/partials",
            `${run.partial.key}.json`,
        );

        await fs.mkdir(path.dirname(otherPath), { recursive: true });
        await fs.copyFile(manifestPath, otherPath);
        onTestFinished(() => fs.rm(otherPath, { force: true }));
        // A valid signature still belongs exclusively to its signed destination agent.
        expect(
            (await api.listPartials()).partials
                .filter((partial) => partial.key === run.partial.key)
                .map((partial) => partial.dest_agent_id),
        ).toEqual([dest.id]);
        const file = await fs.open(manifest.partial_path, "r+");
        await file.write(Buffer.from("x"), 0, 1, 3);
        await file.close();
        const resumed = await api.resumePartial(run.partial);

        const transfer = await completed(
            resumed.transfer_id,
            run.sourcePath,
            run.destPath,
        );

        expect(
            transfer.resumed_bytes,
            "the first mismatching segment must be retransferred",
        ).toBe(0);
    });

    it("restart begins from zero and cancel deletes durable staging", async () => {
        const run = await paused();

        const restart = await source.copyTo(run.partial.dest, run.sourcePath, {
            resume: "restart",
        });

        const transfer = await completed(
            restart.copy_request_id,
            run.sourcePath,
            run.destPath,
        );

        expect(
            transfer.resumed_bytes,
            "explicit restart must reject saved progress",
        ).toBe(0);
        const another = await paused();
        const resumed = await api.resumePartial(another.partial);
        await api.cancelTransfer(resumed.transfer_id);
        await waitForValue({
            description: "cancel cleanup",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) =>
                        entry.request_id === resumed.transfer_id &&
                        entry.state === "canceled",
                ),
        });
        expect(
            (await api.listPartials()).partials.some(
                (partial) => partial.key === another.partial.key,
            ),
            "user cancel deliberately discards progress",
        ).toBe(false);
    });
});
