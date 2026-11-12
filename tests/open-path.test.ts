import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import type { Agent, ApiClient } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
    webSocketDataToString,
} from "./test-utils";
import { openTerminal } from "./terminal-test-utils";

const processManager = new ProcessManager();

const tempFiles = new TempFileManager();

// The agent reports paths from the shell's physical cwd, so compare with the real path.
const agentCwd = realpathSync(
    tempFiles.tempDirectory({ suffix: "-open-path-agent" }),
);

let api: ApiClient;

let testAgent: Agent;

/** The one UI event this file is about; every other event is ignored. */
const openPathEventSchema = z.object({
    type: z.literal("open_path"),
    agent_id: z.string(),
    device_name: z.string(),
    path: z.string(),
    kind: z.union([z.literal("file"), z.literal("directory")]),
});

type OpenPathEvent = z.infer<typeof openPathEventSchema>;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: "open-path-agent",
        agentCwd,
        // A fixture shell instead of the user's own, whose profile could rebuild PATH.
        agentEnv: { SHELL: "/bin/sh" },
    });

    api = started.apiClient;
    testAgent = started.testAgent;
}, 30_000);

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
});

/** Opens the browser event socket and records every `open_path` event it receives. */
async function recordOpenPathEvents(): Promise<OpenPathEvent[]> {
    const events: OpenPathEvent[] = [];

    const socket = new WebSocket(api.getUiWebSocketUrl(), {
        headers: api.getAuthHeaders(),
    });

    onTestFinished(() => socket.close());

    // The server only pings once it queued the subscription with the router, which then
    // handles it before any later open request.
    const subscribed = new Promise<void>((resolve) =>
        socket.once("ping", () => resolve()),
    );

    socket.on("message", (data) => {
        const event = openPathEventSchema.safeParse(
            JSON.parse(webSocketDataToString(data)),
        );

        if (event.success) {
            events.push(event.data);
        }
    });
    await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    await subscribed;

    return events;
}

/** Waits until `count` open requests reached the browser socket. */
function waitForEvents(events: OpenPathEvent[], count: number) {
    return waitForValue({
        description: `${count} open_path events`,
        intervalMs: 20,
        predicate: async () => (events.length >= count ? events : undefined),
    });
}

describe("rd-open", () => {
    it("opens files and directories of the terminal in the browsers", async () => {
        writeFileSync(join(agentCwd, "notes.txt"), "notes\n");
        mkdirSync(join(agentCwd, "sub"));
        const events = await recordOpenPathEvents();
        const { viewer } = await openTerminal(api, testAgent, agentCwd);

        // A new shell tells the person the command exists.
        await viewer.waitForOutput("Tip: run rd-open <path>");

        // printf builds each marker from two parts, so the echoed command line never matches.
        viewer.type("rd-open notes.txt && printf '__OPENED_%s__\\n' file\n");
        await viewer.waitForOutput("__OPENED_file__");
        viewer.type(
            "cd sub && rd-open ../sub/. && printf '__OPENED_%s__\\n' dir\n",
        );
        await viewer.waitForOutput("__OPENED_dir__");

        // The agent decided the kind and the path is absolute and normalized, so the browser
        // can build the file browser URL without asking the agent again.
        expect(await waitForEvents(events, 2)).toEqual([
            {
                type: "open_path",
                agent_id: testAgent.id,
                device_name: testAgent.name,
                path: join(agentCwd, "notes.txt"),
                kind: "file",
            },
            {
                type: "open_path",
                agent_id: testAgent.id,
                device_name: testAgent.name,
                path: join(agentCwd, "sub"),
                kind: "directory",
            },
        ]);
    });

    it("explains failures in the terminal and opens nothing", async () => {
        const events = await recordOpenPathEvents();
        const { viewer } = await openTerminal(api, testAgent, agentCwd);

        viewer.type(
            "rd-open missing.txt || printf '__FAILED_%s__\\n' missing\n",
        );
        const missing = await viewer.waitForOutput("__FAILED_missing__");
        // The person learns the path does not exist instead of seeing nothing happen.
        expect(missing).toContain(
            `${join(agentCwd, "missing.txt")}: No such file or directory`,
        );

        viewer.type(
            "REDOOR_OPEN_TOKEN=forged rd-open . || printf '__FAILED_%s__\\n' forged\n",
        );
        const forged = await viewer.waitForOutput("__FAILED_forged__");
        // Only the shell's own token is accepted, so other processes cannot steer browsers.
        expect(forged).toContain("not running in an open redoor terminal");

        viewer.type(
            "env -u REDOOR_OPEN_SOCKET rd-open . || printf '__FAILED_%s__\\n' outside\n",
        );
        const outside = await viewer.waitForOutput("__FAILED_outside__");
        // Outside a redoor terminal the command says where it works.
        expect(outside).toContain(
            "rd-open only works inside a redoor terminal",
        );

        // A request that succeeds after the failures proves they were all handled first.
        viewer.type("rd-open . && printf '__OPENED_%s__\\n' barrier\n");
        await viewer.waitForOutput("__OPENED_barrier__");

        // Only the final request reached the browsers.
        expect(await waitForEvents(events, 1)).toEqual([
            expect.objectContaining({ path: agentCwd, kind: "directory" }),
        ]);
    });
});
