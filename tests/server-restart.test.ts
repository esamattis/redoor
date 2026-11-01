import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecRequest } from "#bindings/ExecRequest";
import { type Agent, type ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "server-restart-agent";

describe("server restart", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let agent: Agent;
    let serverPort: number;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-cwd" }),
        });

        api = setup.apiClient;
        agent = setup.testAgent;
        serverPort = setup.serverPort;
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    /** Waits until the server answers as a process other than the one with `bootId`. */
    async function waitForNewBootId(bootId: string, timeoutMs: number) {
        return waitForValue({
            timeoutMs,
            description: "restarted server with a new boot id",
            predicate: async () => {
                const info = await api.getServerInfo();

                return info.boot_id !== bootId ? info.boot_id : undefined;
            },
        });
    }

    it("reports a new boot id after a restart", async () => {
        const before = (await api.getServerInfo()).boot_id;

        // Clients tell processes apart by this id, so it must always be present.
        expect(before).not.toBe("");

        await api.restartServer();

        const after = await waitForNewBootId(before, 15000);

        // The re-exec keeps the PID, so only the boot id proves a new process answers.
        expect(after).not.toBe(before);
    }, 30000);

    it("restarts without waiting for a request that stays open", async () => {
        // A restarted server only knows the agent again once it reconnected.
        await waitForValue({
            timeoutMs: 30000,
            description: "agent connected to the current server",
            predicate: async () =>
                (await api.listAgents()).find(
                    (entry) =>
                        entry.name === AGENT_NAME &&
                        entry.status === "connected",
                ),
        });

        const before = (await api.getServerInfo()).boot_id;

        const request: ExecRequest = {
            argv: ["sleep", "120"],
            cwd: null,
            env: {},
            timeout_ms: null,
        };

        // The exec response streams until the command ends, so it holds a request open for
        // two minutes, far longer than the restart may wait.
        const exec = await fetch(
            `http://127.0.0.1:${serverPort}/api/v1/agents/${agent.id}/exec`,
            {
                method: "POST",
                headers: {
                    ...api.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
        );

        // The stream breaks when the server restarts, so its end is not awaited.
        void exec.text().catch(() => "");
        // The response headers arrived, so the request is open on the server.
        expect(exec.status).toBe(200);

        await api.restartServer();

        // The grace period is 5 seconds; without it the server would stay unreachable
        // until the command ended.
        const after = await waitForNewBootId(before, 20000);

        expect(after).not.toBe(before);
    }, 70000);
});
