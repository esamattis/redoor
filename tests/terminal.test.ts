import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";
import {
    TEST_TERMINAL_SIZE,
    TerminalViewer,
    createTerminalSession,
    openTerminal,
} from "./terminal-test-utils";
import type { Agent, ApiClient } from "#ui/api-client";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

const agentCwd = tempFiles.tempDirectory({ suffix: "-terminal-agent" });

const alternateCwd = join(agentCwd, "alternate");

mkdirSync(alternateCwd);

let api: ApiClient;

let testAgent: Agent;

let agentPid: number;

/** The agent's cap on running shells. */
const MAX_TERMINALS_PER_AGENT = 8;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: "terminal-agent",
        agentCwd,
    });

    api = started.apiClient;
    testAgent = started.testAgent;
    agentPid = started.agentPid;
}, 30_000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** Whether a local process still exists; the agent runs on this machine. */
function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

/** Waits until a process is gone. */
async function waitForExit(pid: number, description: string): Promise<void> {
    await waitForValue({
        predicate: async () => (isRunning(pid) ? undefined : true),
        timeoutMs: 5_000,
        intervalMs: 50,
        description,
    });
}

/** Asks the shell for its pid and returns it. */
async function shellPid(viewer: TerminalViewer, tag: string): Promise<number> {
    viewer.type(`printf '__PID_${tag}_%s__\\n' $$\n`);

    const output = await viewer.waitForOutputMatching(
        new RegExp(`__PID_${tag}_(\\d+)__`),
    );

    const pid = Number(output.match(new RegExp(`__PID_${tag}_(\\d+)__`))?.[1]);
    // A numeric pid proves the command ran in the shell behind this socket.
    expect(pid).toBeGreaterThan(0);

    return pid;
}

/** Waits for a session's listed status. */
async function waitForListedStatus(id: string, type: string) {
    return waitForValue({
        description: `terminal session ${id} to be ${type}`,
        predicate: async () =>
            (await api.listTerminalSessions()).sessions.find(
                (session) => session.id === id && session.status.type === type,
            ),
    });
}

describe("terminal sessions", () => {
    it("keeps an idle terminal usable across keepalive pings", async () => {
        const { viewer } = await openTerminal(api, testAgent, agentCwd);
        await new Promise<void>((resolve) =>
            viewer.socket.once("ping", () => resolve()),
        );
        const marker = "__REDOOR_IDLE_TERMINAL__";
        viewer.type(`printf '${marker}'\n`);

        // Output after the keepalive proves no reconnect or terminal reset occurred.
        expect(await viewer.waitForOutput(marker)).toContain(marker);
    });

    it("starts concurrent shells in their requested working directories", async () => {
        const first = await openTerminal(api, testAgent, agentCwd);
        const second = await openTerminal(api, testAgent, alternateCwd);
        const command = "printf '__REDOOR_CWD__%s__\\n' \"$PWD\"\n";
        first.viewer.type(command);
        second.viewer.type(command);

        // Each shell starts in the directory its session was created with.
        expect(
            await first.viewer.waitForOutput(`__REDOOR_CWD__${agentCwd}__`),
        ).toBeTruthy();
        expect(
            await second.viewer.waitForOutput(
                `__REDOOR_CWD__${alternateCwd}__`,
            ),
        ).toBeTruthy();
    });

    it("lists a created session with its metadata", async () => {
        const session = await createTerminalSession(api, testAgent, agentCwd);
        const listed = await waitForListedStatus(session.id, "running");

        // The list carries what another window needs to restore the tab.
        expect(listed).toMatchObject({
            agent_id: testAgent.id,
            cwd: agentCwd,
            title: `${testAgent.name} test`,
            number: 1,
        });
    });

    it("lists the shell's foreground command and current directory", async () => {
        const { session, viewer } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        // The kernel reports the resolved directory, so compare against the real path.
        const jobDir = realpathSync(alternateCwd);

        viewer.type(`cd '${alternateCwd}' && sleep 300\n`);

        const running = await waitForValue({
            description: "the running sleep to be listed",
            timeoutMs: 15_000,
            predicate: async () =>
                (await api.listTerminalSessions()).sessions.find(
                    (entry) =>
                        entry.id === session.id &&
                        entry.activity.command !== null,
                ),
        });

        // The foreground job is named with its arguments, not just the shell.
        expect(running.activity.command).toBe("sleep 300");
        // The directory follows the shell's `cd`, while `cwd` stays where it started.
        expect(running.activity.current_dir).toBe(jobDir);
        expect(running.cwd).toBe(agentCwd);

        // Ctrl+C ends the job and returns to the prompt.
        viewer.type("\u0003");

        const idle = await waitForValue({
            description: "the shell prompt to be listed",
            timeoutMs: 15_000,
            predicate: async () =>
                (await api.listTerminalSessions()).sessions.find(
                    (entry) =>
                        entry.id === session.id &&
                        entry.activity.command === null,
                ),
        });

        // An idle shell runs nothing but stays in the directory it changed to.
        expect(idle.activity.current_dir).toBe(jobDir);
    });

    it("re-attaches to the same shell with its screen after the socket closes", async () => {
        const { session, viewer } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        const pid = await shellPid(viewer, "FIRST");
        viewer.type(
            "trap '' HUP; sleep 120 & printf '__BG_%s__\\n' $!; echo marker-before-detach\n",
        );

        const output = await viewer.waitForOutputMatching(
            /__BG_(\d+)__[\s\S]*marker-before-detach\r?\n/,
        );

        const backgroundPid = Number(output.match(/__BG_(\d+)__/)?.[1]);
        viewer.socket.close();
        await viewer.waitForClose();

        const reattached = new TerminalViewer(api, session.id, {
            rows: 24,
            cols: 80,
        });

        await reattached.waitForReady();
        // The snapshot restores what was on screen before the socket closed.
        expect(
            await reattached.waitForOutput("marker-before-detach"),
        ).toBeTruthy();
        // It is the same shell, not a new one.
        expect(await shellPid(reattached, "SECOND")).toBe(pid);
        // A job started before detaching is still running.
        expect(isRunning(backgroundPid)).toBe(true);
    });

    it("hands the session to a second viewer and only takes its input", async () => {
        const { session, viewer: first } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        const second = new TerminalViewer(api, session.id, {
            rows: 24,
            cols: 80,
        });

        await second.waitForReady();

        // The first viewer is told it was taken over, then disconnected.
        expect(await first.waitForEvent("taken_over")).toEqual({
            type: "taken_over",
        });
        await first.waitForClose();
        first.type("echo typed-by-first\n");
        second.type("echo typed-by-second\n");
        // Only the current viewer types into the shell.
        expect(
            await second.waitForOutputMatching(/typed-by-second\r?\n/),
        ).not.toContain("typed-by-first");
    });

    it("streams resizes to the PTY", async () => {
        const { viewer } = await openTerminal(api, testAgent, agentCwd);
        viewer.resize(31, 97);
        viewer.type("stty size; printf '__REDOOR_%s__' SIZE\n");

        // The dimensions prove validated resizes reached the PTY ioctl.
        expect(await viewer.waitForOutput("__REDOOR_SIZE__")).toContain(
            "31 97",
        );
    });

    it("kills the shell and its jobs on delete and tells the attached viewer", async () => {
        const { session, viewer } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        viewer.type(
            "trap '' HUP; sleep 60 & child=$!; trap - HUP; printf '__REDOOR_%s__%s__%s__\\n' KILL $$ $child\n",
        );

        const output = await viewer.waitForOutputMatching(
            /__REDOOR_KILL__\d+__\d+__/,
        );

        const [, shell, background] =
            output.match(/__REDOOR_KILL__(\d+)__(\d+)__/) ?? [];

        await api.deleteTerminalSession(session.id);

        // The attached viewer learns the session was closed rather than seeing a drop.
        expect(await viewer.waitForEvent("closed")).toEqual({ type: "closed" });
        await waitForExit(Number(shell), "terminal shell to exit");
        await waitForExit(
            Number(background),
            "terminal background job to exit",
        );
        // The session is gone from the list every window restores from.
        expect(
            (await api.listTerminalSessions()).sessions.some(
                (listed) => listed.id === session.id,
            ),
        ).toBe(false);
    });

    it("keeps an exited session with its last screen and exit status", async () => {
        const { session, viewer } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        const marker = `exit-marker-${Date.now()}`;
        viewer.type(`echo ${marker}; exit 3\r`);

        // The shell's status reaches the viewer after its last output.
        expect(await viewer.waitForEvent("exit")).toEqual({
            type: "exit",
            code: 3,
            signal: null,
        });
        expect(viewer.output).toContain(marker);
        await viewer.waitForClose();

        const listed = await waitForListedStatus(session.id, "exited");
        // The listing tells a reloaded window why the shell ended.
        expect(listed.status).toEqual({
            type: "exited",
            message: "Shell exited with code 3",
        });

        const reattached = new TerminalViewer(api, session.id, {
            rows: 24,
            cols: 80,
        });

        // Attaching later shows the last screen, then the exit status, then closes.
        expect(await reattached.waitForEvent("exit")).toEqual({
            type: "exit",
            code: 3,
            signal: null,
        });
        expect(reattached.output).toContain(marker);
        await reattached.waitForClose();
    });

    it("preserves input sent before the shell is ready", async () => {
        const session = await createTerminalSession(api, testAgent, agentCwd);

        const viewer = new TerminalViewer(api, session.id, {
            rows: 24,
            cols: 80,
        });

        await new Promise<void>((resolve) =>
            viewer.socket.once("open", () => resolve()),
        );
        const marker = "__REDOOR_EARLY_INPUT__";
        viewer.type(`printf '${marker}'\n`);

        // Input typed during setup waits for the PTY instead of being dropped.
        expect(await viewer.waitForOutput(marker)).toContain(marker);
    });

    it("refuses a session beyond the agent's terminal limit until one is closed", async () => {
        const sessions = [];

        for (let index = 0; index < MAX_TERMINALS_PER_AGENT; index += 1) {
            sessions.push(
                await createTerminalSession(api, testAgent, agentCwd),
            );
        }

        // A full agent is a clear conflict at creation, not a dead tab.
        await expect(
            testAgent.createTerminalSession({
                cwd: agentCwd,
                title: "one too many",
                number: 9,
                size: { rows: 24, cols: 80 },
            }),
        ).rejects.toMatchObject({
            status: 409,
            message: "Too many terminals are open on this agent",
        });

        const first = sessions[0];

        if (first === undefined) {
            throw new Error("no session was created");
        }

        await api.deleteTerminalSession(first.id);
        // Closing a session frees its slot; the shell runs once the create answers.
        expect(
            (await createTerminalSession(api, testAgent, agentCwd)).status.type,
        ).toBe("running");
    });

    it("answers unknown or malformed session ids with 404", async () => {
        const unknown = "00000000-0000-4000-8000-000000000000";

        for (const id of [unknown, "not-a-uuid"]) {
            // A missing session, such as after a server restart, is a 404.
            await expect(
                api.deleteTerminalSession(id),
                id,
            ).rejects.toMatchObject({
                status: 404,
            });
        }

        const attachStatus = await new Promise<number>((resolve, reject) => {
            const socket = new TerminalViewer(api, unknown, {
                rows: 24,
                cols: 80,
            }).socket;

            socket.on("unexpected-response", (_request, response) => {
                resolve(response.statusCode ?? 0);
                socket.terminate();
            });
            socket.on("open", () =>
                reject(new Error("attached to an unknown session")),
            );
        });

        // The attach socket is refused before the upgrade, so a reloaded tab can tell.
        expect(attachStatus).toBe(404);
    });

    it("rejects a relative working directory", async () => {
        const response = await fetch(
            `${api.baseUrl}/api/v1/agents/${testAgent.id}/terminals`,
            {
                method: "POST",
                headers: {
                    ...api.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    cwd: "relative",
                    title: "t",
                    number: 1,
                    size: { rows: 24, cols: 80 },
                }),
            },
        );

        // Session creation validates cwd like every other path-taking route.
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: "Filesystem path must be absolute",
        });
    });

    it("keeps the shell and its screen across a server restart", async () => {
        const { session, viewer } = await openTerminal(
            api,
            testAgent,
            agentCwd,
        );

        const pid = await shellPid(viewer, "BEFORE_RESTART");
        const bootId = (await api.getServerInfo()).boot_id;
        await api.restartServer();
        await waitForValue({
            timeoutMs: 20_000,
            description: "restarted server",
            predicate: async () => {
                const info = await api.getServerInfo().catch(() => undefined);

                return info !== undefined && info.boot_id !== bootId
                    ? true
                    : undefined;
            },
        });

        // The restarted server learns the session from the agent's report once it is back, so
        // browser tabs return without the server saving anything.
        await waitForValue({
            timeoutMs: 30_000,
            description: "session reported by the reconnected agent",
            predicate: async () =>
                (await api.listTerminalSessions()).sessions.find(
                    (listed) => listed.id === session.id,
                ),
        });

        const reattached = new TerminalViewer(
            api,
            session.id,
            TEST_TERMINAL_SIZE,
        );

        await reattached.waitForReady();
        // The agent kept the screen, so the output from before the restart is restored.
        expect(
            await reattached.waitForOutput(`__PID_BEFORE_RESTART_${pid}__`),
        ).toBeTruthy();
        // It is the same shell, which kept running while the server restarted.
        expect(await shellPid(reattached, "AFTER_RESTART")).toBe(pid);
    }, 60_000);

    // Last: it stops the suite's agent.
    it("keeps sessions listed while their agent is away", async () => {
        const { session } = await openTerminal(api, testAgent, agentCwd);
        processManager.kill(agentPid);
        await waitForValue({
            description: "agent disconnected",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.id === testAgent.id &&
                        agent.status !== "connected",
                ),
        });

        const listed = (await api.listTerminalSessions()).sessions.find(
            (entry) => entry.id === session.id,
        );

        // The shell may come back with its agent, so its tab stays as it was.
        expect(listed?.status).toEqual({ type: "running" });

        const viewer = new TerminalViewer(api, session.id, TEST_TERMINAL_SIZE);
        await viewer.waitForClose();
        // Without an event the browser treats it as a dropped connection and retries.
        expect(viewer.events).toEqual([]);
    });
});
