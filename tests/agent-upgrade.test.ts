import { copyFileSync, chmodSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Agent, ApiClient, BinaryIdentity } from "@/api-client";
import {
    ProcessManager,
    SERVER_PATH,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "upgrade-external-agent";

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
});
