import { copyFileSync, chmodSync, statSync } from "node:fs";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import WebSocket from "ws";
import { z } from "zod";

import {
    ApiError,
    type Agent,
    type ApiClient,
    type BinaryIdentity,
} from "#ui/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "upgrade-external-agent";
const jsonControlMessageSchema = z.record(z.string(), z.unknown());

/** Waits for a websocket to become writable without relying on timing delays. */
async function waitForSocketOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
}

/** Reads one JSON control message from a websocket fixture. */
async function nextJsonMessage(
    socket: WebSocket,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        socket.once("message", (data) => {
            try {
                resolve(
                    jsonControlMessageSchema.parse(
                        JSON.parse(data.toString()),
                    ),
                );
            } catch (error) {
                reject(error);
            }
        });
        socket.once("error", reject);
    });
}

/** Compares every reported build field so dirty upgrades prove byte-identical selection. */
function expectSameIdentity(
    actual: BinaryIdentity,
    expected: BinaryIdentity,
): void {
    // Full identity equality proves the dirty path did not substitute a release artifact.
    expect(actual).toEqual(expected);
}

describe("connected external agent upgrade", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let agent: Agent;
    let agentPid: number;
    let serverPort: number;
    let executablePath: string;

    beforeAll(async () => {
        executablePath = tempFiles.tempFile({ suffix: "-redoor" });
        copyFileSync(SERVER_PATH, executablePath);
        chmodSync(executablePath, 0o751);
        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-cwd" }),
            agentExecutablePath: executablePath,
        });
        api = setup.apiClient;
        agent = setup.testAgent;
        agentPid = setup.agentPid;
        serverPort = setup.serverPort;
    }, 30000);

    afterAll(() => {
        processes.killAll();
        tempFiles.cleanup();
    });

    it("atomically replaces and self-execs the connected external agent", async () => {
        const serverInfo = await api.getServerInfo();
        const originalConnectionId = agent.connectionId;
        expect(originalConnectionId).not.toBeNull();

        const response = await agent.upgrade();
        // The endpoint acknowledges only after replacement and self-exec setup succeed.
        expect(response).toEqual({
            upgrading: true,
            target_version: serverInfo.version,
        });

        const upgraded = await waitForValue({
            timeoutMs: 30000,
            description: "upgraded agent replacement connection",
            predicate: async () => {
                const candidate = (await api.listAgents()).find(
                    (entry) => entry.name === AGENT_NAME,
                );
                return candidate?.status === "connected" &&
                    candidate.connectionId !== originalConnectionId &&
                    candidate.binary?.version === serverInfo.version
                    ? candidate
                    : undefined;
            },
        });
        const details = await upgraded.getDetails();
        // Self-exec must preserve the process identity instead of relying on a supervisor respawn.
        expect(details.pid).toBe(agentPid);
        // The replacement must report the same target version as the server.
        expect(details.binary.version).toBe(serverInfo.version);
        if (serverInfo.git_dirty || serverInfo.version_dirty) {
            expectSameIdentity(details.binary, {
                version: serverInfo.version,
                git_rev: serverInfo.git_rev,
                git_dirty: serverInfo.git_dirty,
                version_dirty: serverInfo.version_dirty,
                build_mode: serverInfo.build_mode,
                build_date: serverInfo.build_date,
            });
        }
        // Atomic executable replacement must retain all pre-existing mode bits.
        expect(statSync(executablePath).mode & 0o777).toBe(0o751);
        // A lightweight control command proves the replacement connection serves requests.
        expect((await upgraded.echo("upgrade-ready")).message).toBe(
            "upgrade-ready",
        );
    }, 60000);

    it("rejects an older agent before sending an upload command", async () => {
        const oldAgentName = "upgrade-unsupported-agent";
        const serverInfo = await api.getServerInfo();
        const control = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
        let transfer: WebSocket | undefined;
        onTestFinished(() => {
            control.close();
            transfer?.close();
        });
        await waitForSocketOpen(control);
        control.send(
            JSON.stringify({
                type: "agent_register",
                agent_id: oldAgentName,
                agent_name: oldAgentName,
                os: "linux",
                arch: "x86_64",
                hostname: "old-host",
                username: "old-user",
                cwd: "/tmp",
                token: serverInfo.agent_token,
                binary: {
                    version: "0.0.3",
                    git_rev: "old",
                    git_dirty: false,
                    version_dirty: false,
                    build_mode: "release",
                    build_date: "unknown",
                },
                // Deliberately omit supports_self_exec to model a pre-protocol agent.
            }),
        );
        const transferOpen = await nextJsonMessage(control);
        expect(transferOpen.type).toBe("transfer_socket_open");
        expect(typeof transferOpen.token).toBe("string");

        transfer = new WebSocket(
            `ws://127.0.0.1:${serverPort}/api/v1/agent-transfer/ws`,
        );
        await waitForSocketOpen(transfer);
        transfer.send(
            JSON.stringify({
                type: "authenticate",
                agent_id: oldAgentName,
                token: transferOpen.token,
            }),
        );
        const oldAgent = await waitForValue({
            description: "unsupported fixture transfer registration",
            predicate: async () => {
                const candidate = (await api.listAgents()).find(
                    (entry) => entry.name === oldAgentName,
                );
                return candidate?.status === "connected"
                    ? candidate
                    : undefined;
            },
        });
        // An omitted capability must remain visible as unsupported metadata.
        expect(oldAgent.supportsSelfExec).toBe(false);

        const receivedCommands: Array<Record<string, unknown>> = [];
        control.on("message", (data) => {
            receivedCommands.push(
                jsonControlMessageSchema.parse(JSON.parse(data.toString())),
            );
        });
        let error: unknown;
        try {
            await oldAgent.upgrade();
        } catch (caught) {
            error = caught;
        }
        // Conflict plus remediation tells operators how to make the upgrade safe.
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({
            status: 409,
            message: expect.stringContaining(
                "Install a current Redoor agent manually",
            ),
        });
        // No RawUpload command proves rejection happened before any remote mutation began.
        expect(receivedCommands).toEqual([]);
    });
});
