import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import type { ApiClient } from "#ui/api-client";
import {
    AGENT_PROTOCOL,
    FakeAgent,
    FakeAgentRejectedError,
    upgradeAgentSocket,
} from "./fake-agent";
import {
    generateDeviceId,
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "handshake-agent";

/** Body of a `426 Upgrade Required` answer. */
const protocolMismatchSchema = z.object({
    server_protocol: z.string(),
    server_version: z.string(),
    message: z.string(),
});

describe("agent websocket handshake", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let serverPid: number;
    let serverPort: number;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-handshake-cwd" }),
        });

        api = setup.apiClient;
        serverPid = setup.serverPid;
        serverPort = setup.serverPort;
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    /** Number of sessions the server has started so far, read from its log. */
    function sessionCount(): number {
        return (processes.getStdout(serverPid).match(/Session started/g) ?? [])
            .length;
    }

    /** The server process, for waiting on its log. */
    function serverProcess() {
        const process = processes.getProcess(serverPid);

        if (process === undefined) {
            throw new Error("server process is not tracked");
        }

        return process;
    }

    it("refuses a wrong or missing token before any session exists", async () => {
        const sessionsBefore = sessionCount();
        const agentsBefore = (await api.listAgents()).length;

        for (const token of ["wrong-token", null]) {
            const rejected = waitForLogMessage(
                serverProcess(),
                /Rejecting agent with a missing or invalid token/,
            );

            const outcome = await upgradeAgentSocket({ serverPort, token });

            // The credential is checked during the HTTP upgrade, so no socket is opened.
            expect(outcome).toMatchObject({ kind: "refused", status: 401 });
            await rejected;
        }

        // No session actor was started for either attempt.
        expect(sessionCount()).toBe(sessionsBefore);
        // Nothing unauthenticated can appear in the inventory.
        expect((await api.listAgents()).length).toBe(agentsBefore);
    });

    it("refuses a missing or unknown protocol with 426", async () => {
        for (const protocols of [[], ["redoor.v1"], ["redoor.v2"]]) {
            const outcome = await upgradeAgentSocket({
                serverPort,
                protocols,
                version: "0.0.0-old-agent",
            });

            // Incompatible agents fail the upgrade instead of misreading frames.
            expect(outcome.kind).toBe("refused");

            if (outcome.kind !== "refused") {
                return;
            }

            expect(outcome.status).toBe(426);
            const body = protocolMismatchSchema.parse(JSON.parse(outcome.body));
            // The body names the server's protocol so the agent can log what to upgrade.
            expect(body.server_protocol).toBe(AGENT_PROTOCOL);
            expect(body.message).toContain(AGENT_PROTOCOL);
        }

        const mismatches = await api.listProtocolMismatches();
        // The refused agent is remembered for the UI, with its own version. Retries from one
        // host and version replace each other, so only the last offer, the previous
        // generation, remains.
        expect(
            mismatches.attempts.some(
                (attempt) =>
                    attempt.agent_version === "0.0.0-old-agent" &&
                    attempt.offered_protocols.includes("redoor.v2"),
            ),
        ).toBe(true);
    });

    it("rejects a hello whose name belongs to another live agent", async () => {
        let error: unknown;

        try {
            await FakeAgent.connect({
                serverPort,
                agentName: AGENT_NAME,
            });
        } catch (caught) {
            error = caught;
        }

        // The server answers the hello with `rejected` instead of a takeover.
        expect(error).toBeInstanceOf(FakeAgentRejectedError);
        expect(error).toMatchObject({ reason: "duplicate_name" });
        const agents = await api.listAgents();
        // The real agent keeps its connection.
        expect(
            agents.find((agent) => agent.name === AGENT_NAME)?.status,
        ).toBe("connected");
        // The impostor never appears in the inventory: only one device carries the name.
        expect(
            agents.filter((agent) => agent.name === AGENT_NAME),
        ).toHaveLength(1);
    });

    it("rejects a hello whose id or name is not a valid device identity", async () => {
        const invalidHellos = [
            // The id is the old name-style identity, not an opaque device id.
            { agentId: "handshake-name-as-id", agentName: "handshake-bad-id" },
            // Upper-case and too-short ids look close to the format but are not in it.
            {
                agentId: "dev_ABCDEFGHIJKLMNOPQRST",
                agentName: "handshake-upper-id",
            },
            { agentId: "dev_abc", agentName: "handshake-short-id" },
            // Names cannot contain the CLI's `device:path` separator or a URL separator.
            { agentName: "handshake:colon" },
            { agentName: "handshake/slash" },
            { agentName: "" },
            // A name in the id format would make name-or-id lookups ambiguous.
            { agentName: generateDeviceId() },
        ];

        for (const hello of invalidHellos) {
            let error: unknown;

            try {
                await FakeAgent.connect({ serverPort, ...hello });
            } catch (caught) {
                error = caught;
            }

            // The router refuses the identity instead of registering a device under it.
            expect(error, JSON.stringify(hello)).toBeInstanceOf(
                FakeAgentRejectedError,
            );
            expect(error, JSON.stringify(hello)).toMatchObject({
                reason: "invalid_identity",
            });
        }

        const names = (await api.listAgents()).map((agent) => agent.name);

        // None of the refused identities reached the inventory.
        for (const hello of invalidHellos) {
            expect(names).not.toContain(hello.agentName);
        }

        // A name that only starts with `dev_` is a normal name and is accepted.
        const fake = await FakeAgent.connect({
            serverPort,
            agentName: "dev_handshake-name",
        });

        onTestFinished(() => fake.close());
        expect(fake.connectionId).not.toBe("");
    });

    it("closes a socket that sends frames before hello", async () => {
        const outcome = await upgradeAgentSocket({ serverPort });

        if (outcome.kind !== "open") {
            throw new Error(`upgrade refused with ${outcome.status}`);
        }

        const closed = new Promise<void>((resolve) =>
            outcome.socket.once("close", () => resolve()),
        );

        const logged = waitForLogMessage(
            serverProcess(),
            /Closing agent socket that sent a frame before hello: .*frame=result/,
        );

        outcome.socket.send(
            JSON.stringify({
                type: "result",
                id: 1,
                ok: { message: "forged" },
            }),
        );

        // An unidentified socket must not stay open to retry other frames.
        await closed;
        await logged;
    });

    it("lets a fake agent run commands over the authenticated connection", async () => {
        const fakeName = "handshake-fake-agent";
        const fake = await FakeAgent.connect({ serverPort, agentName: fakeName });
        onTestFinished(() => fake.close());
        fake.onCommand(({ id, command }) => {
            if (command.type === "Echo") {
                fake.respond(id, { message: "from fake" });
            }
        });

        const listed = await waitForValue({
            description: "fake agent connected",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.name === fakeName && agent.status === "connected",
                ),
        });

        // The welcome's connection id is the one the inventory reports.
        expect(listed.connectionId).toBe(fake.connectionId);
        // Results resolve the REST call although frames carry no agent id.
        expect((await listed.echo("ignored")).message).toBe("from fake");
    });

    it("keeps a standalone agent with a wrong token retrying instead of exiting", async () => {
        const agentPid = processes.spawnAgent({
            wsAddress: `ws://127.0.0.1:${serverPort}/api/v1/agent/ws`,
            name: "handshake-wrong-token",
            cwd: tempFiles.tempDirectory({ suffix: "-wrong-token" }),
            token: "not-the-agent-token",
        });

        // Only the ERROR line, not the WARN line that schedules the retry.
        const refusals = () =>
            (
                processes
                    .getStdout(agentPid)
                    .match(/\[ERROR\] Server refused the agent connection/g) ?? []
            ).length;

        await waitForValue({
            description: "a second refused connection attempt",
            predicate: async () => (refusals() >= 2 ? true : undefined),
        });
        // Nobody restarts a standalone agent, so a fixable refusal is retried, not fatal.
        expect(refusals()).toBeGreaterThanOrEqual(2);
        // The agent is still running, ready to connect once the token is fixed.
        expect(processes.getProcess(agentPid)?.exitCode).toBeNull();
        // The log tells the operator it keeps trying instead of failing silently.
        expect(processes.getStdout(agentPid)).toContain(
            "Retrying in the background until it is fixed",
        );
    });
});
