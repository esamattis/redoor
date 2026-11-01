import { copyFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import type { AgentDetailsResponse } from "#bindings/AgentDetailsResponse";
import type { BinaryIdentity } from "#bindings/BinaryIdentity";
import { type Agent, type ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import { FakeAgent } from "./fake-agent";
import {
    ProcessManager,
    SERVER_PATH,
    TEST_APP_NAME,
    TEST_SERVER_HOME,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "upgrade-external-agent";

/**
 * Waits until the agent's background upgrade ends, which the server notices once the agent
 * is back on a new connection, and returns the finished job.
 */
async function waitForFinishedUpgrade(target: Agent, description: string) {
    return waitForValue({
        timeoutMs: 30000,
        description,
        predicate: async () => {
            const { job } = await target.getUpgradeStatus();

            return job?.phase.phase === "completed" ||
                job?.phase.phase === "failed"
                ? job
                : undefined;
        },
    });
}

describe("connected external agent upgrade", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let agent: Agent;
    let agentPid: number;
    let serverPort: number;
    let executablePath: string;
    let targetVersion: string;

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
        const serverInfo = await api.getServerInfo();
        const details = await agent.getDetails();
        targetVersion = serverInfo.version;

        // Seed the namespaced XDG cache the server uses so upgrades never hit GitHub.
        const cachedBinary = join(
            TEST_SERVER_HOME,
            ".cache",
            TEST_APP_NAME,
            "binaries",
            targetVersion,
            details.os,
            details.arch,
            "redoor",
        );

        mkdirSync(join(cachedBinary, ".."), { recursive: true });
        copyFileSync(SERVER_PATH, cachedBinary);
        chmodSync(cachedBinary, 0o755);
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    it("rejects an invalid target version before replacing the agent", async () => {
        let error: unknown;

        try {
            await agent.upgrade("../invalid");
        } catch (caught) {
            error = caught;
        }

        // Invalid versions must not become release URL or cache path components.
        expect(error).toBeInstanceOf(ApiError);
        // A client error lets the UI report the bad manual value without implying an outage.
        expect(error).toMatchObject({
            status: 400,
            message: "Invalid Redoor release version: ../invalid",
        });
        // Rejection before upload must leave the original connection serving commands.
        expect((await agent.echo("upgrade-not-started")).message).toBe(
            "upgrade-not-started",
        );
        // A refused request starts no background upgrade.
        expect((await agent.getUpgradeStatus()).job).toBeNull();
    });

    it("atomically replaces and self-execs the connected external agent", async () => {
        const originalConnectionId = agent.connectionId;
        expect(originalConnectionId).not.toBeNull();

        const response = await agent.upgrade(targetVersion);
        // The request only starts the upgrade, which then runs in the background.
        expect(response).toEqual({
            upgrading: true,
            target_version: targetVersion,
        });

        const job = await waitForFinishedUpgrade(agent, "release upgrade end");
        // The server reports success only once the agent is back on the target version.
        expect(job.phase).toEqual({ phase: "completed" });
        // The job names what was installed, so the UI can say so after a reload.
        expect(job).toMatchObject({
            target_version: targetVersion,
            source: "published_release",
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
                    candidate.binary?.version === targetVersion
                    ? candidate
                    : undefined;
            },
        });

        const details = await upgraded.getDetails();
        // Self-exec must preserve the process identity instead of relying on a supervisor respawn.
        expect(details.pid).toBe(agentPid);
        // The replacement must report the manually selected target version.
        expect(details.binary.version).toBe(targetVersion);
        // Atomic executable replacement must retain all pre-existing mode bits.
        expect(statSync(executablePath).mode & 0o777).toBe(0o751);
        // A lightweight control command proves the replacement connection serves requests.
        expect((await upgraded.echo("upgrade-ready")).message).toBe(
            "upgrade-ready",
        );

        await upgraded.dismissUpgrade();
        // A dismissed result is forgotten, so the UI stops showing it.
        expect((await upgraded.getUpgradeStatus()).job).toBeNull();
    }, 60000);

    it("force-installs the exact running server binary", async () => {
        const serverInfo = await api.getServerInfo();

        const currentAgent = (await api.listAgents()).find(
            (entry) =>
                entry.name === AGENT_NAME && entry.status === "connected",
        );

        // A connected generation is required to prove force installation reconnects it.
        expect(currentAgent?.connectionId).not.toBeNull();
        expect(currentAgent).toBeDefined();

        const response = await agent.forceInstallRunningBinary();
        // The force endpoint reports the version baked into the running server executable.
        expect(response).toEqual({
            upgrading: true,
            target_version: serverInfo.version,
        });

        const job = await waitForFinishedUpgrade(agent, "force install end");
        // Completion requires the exact server build, which the agent reconnected with.
        expect(job.phase).toEqual({ phase: "completed" });
        expect(job.source).toBe("running_server");

        const upgraded = await waitForValue({
            timeoutMs: 30000,
            description: "force-installed agent replacement connection",
            predicate: async () => {
                const candidate = (await api.listAgents()).find(
                    (entry) => entry.name === AGENT_NAME,
                );

                return candidate?.status === "connected" &&
                    candidate.connectionId !== currentAgent?.connectionId
                    ? candidate
                    : undefined;
            },
        });

        const details = await upgraded.getDetails();
        // Exact identity equality proves the running image was used instead of a release cache.
        expect(details.binary).toEqual({
            version: serverInfo.version,
            git_rev: serverInfo.git_rev,
            git_dirty: serverInfo.git_dirty,
            version_dirty: serverInfo.version_dirty,
            build_mode: serverInfo.build_mode,
            build_date: serverInfo.build_date,
        });
        // Self-exec must preserve PID for the force path as well.
        expect(details.pid).toBe(agentPid);
    }, 60000);

    it("runs one upgrade at a time and fails it when the upload completes before any byte", async () => {
        const earlyAgentName = "upgrade-early-completion-agent";
        const serverInfo = await api.getServerInfo();
        const arch = process.arch === "arm64" ? "aarch64" : "x86_64";

        const binary: BinaryIdentity = {
            version: serverInfo.version,
            git_rev: "early",
            git_dirty: false,
            version_dirty: false,
            build_mode: "debug",
            build_date: "unknown",
        };

        const earlyAgent = await FakeAgent.connect({
            serverPort,
            agentName: earlyAgentName,
            arch,
            hostname: "early-host",
            username: "early-user",
            binary,
        });

        onTestFinished(() => earlyAgent.close());

        const listed = await waitForValue({
            description: "early-completion fixture transfer registration",
            predicate: async () => {
                const candidate = (await api.listAgents()).find(
                    (entry) => entry.name === earlyAgentName,
                );

                return candidate?.status === "connected"
                    ? candidate
                    : undefined;
            },
        });

        earlyAgent.onCommand(({ id, command }) => {
            if (command.type === "GetAgentDetails") {
                const details: AgentDetailsResponse = {
                    id: earlyAgentName,
                    name: earlyAgentName,
                    pid: 1,
                    cwd: "/tmp",
                    config_path: "",
                    exe_path: "/tmp/early-redoor",
                    load_average_one: 0,
                    load_average_five: 0,
                    load_average_fifteen: 0,
                    system_uptime: 0,
                    os: "linux",
                    arch,
                    hostname: "early-host",
                    external_ip: null,
                    username: "early-user",
                    connected_at: 0,
                    binary,
                    mount_points: [],
                    uid: 1000,
                    is_root: false,
                };

                earlyAgent.respond(id, details);
            }
        });

        await listed.forceInstallRunningBinary();

        const upload = await earlyAgent.nextCommand("RawUpload");

        // While the upload is held, the upgrade is running and owns the agent's executable.
        expect((await listed.getUpgradeStatus()).job?.phase.phase).toBe(
            "uploading",
        );

        let secondError: unknown;

        try {
            await listed.forceInstallRunningBinary();
        } catch (caught) {
            secondError = caught;
        }

        // A second upgrade would write the same executable at the same time.
        expect(secondError).toMatchObject({
            status: 409,
            message: "An upgrade of this agent is already running",
        });

        let dismissError: unknown;

        try {
            await listed.dismissUpgrade();
        } catch (caught) {
            dismissError = caught;
        }

        // A running upgrade cannot be dismissed, or its outcome would be lost.
        expect(dismissError).toBeInstanceOf(ApiError);
        expect(dismissError).toMatchObject({ status: 409 });

        // Finishing before granting upload credit means the agent never received the binary.
        earlyAgent.respond(upload.id, null);

        const job = await waitForFinishedUpgrade(
            listed,
            "early-completion upgrade end",
        );

        const receivedCommandTypes = earlyAgent.commands.map(
            ({ command }) => command.type,
        );

        // An upload that stored no bytes must fail instead of restarting the agent.
        expect(job.phase).toEqual({
            phase: "failed",
            error: "Unexpected early upgrade upload completion",
        });
        // The upload was attempted, but self-exec must never follow it.
        expect(receivedCommandTypes).toContain("RawUpload");
        expect(receivedCommandTypes).not.toContain("SelfExec");

        await listed.dismissUpgrade();
        // A finished failure can be dismissed once it was seen.
        expect((await listed.getUpgradeStatus()).job).toBeNull();
    });
});
