import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContentGrepEvent } from "#bindings/ContentGrepEvent";
import type { FileSearchEvent } from "#bindings/FileSearchEvent";
import type { FindRequest } from "#bindings/FindRequest";
import type { GrepRequest } from "#bindings/GrepRequest";
import type { Agent, ApiClient } from "#ui/api-client";
import { encodeFilesystemPath } from "#ui/api-paths";
import {
    escapeRegExp,
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
} from "./test-utils";

const AGENT_NAME = "search-stream-agent";

/** Fields of a path or content search body, plus the signal that abandons the request. */
type SearchPost = Partial<FindRequest> &
    Partial<GrepRequest> & { query: string; signal?: AbortSignal };

/** The error body the server answers failed requests with. */
type ErrorBody = { error: string };

describe("streaming path and content search", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let agent: Agent;
    let agentPid: number;
    let searchRoot: string;

    beforeAll(async () => {
        const started = await startServerAndAgent({
            processManager: processes,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-search-stream" }),
        });

        api = started.apiClient;
        agent = started.testAgent;
        agentPid = started.agentPid;
        searchRoot = tempFiles.tempDirectory({ suffix: "-search-stream-root" });

        for (const index of [1, 2, 3]) {
            await fs.writeFile(
                path.join(searchRoot, `stream-target-${index}.txt`),
                `before\nstream-needle ${index}\nafter\n`,
            );
        }
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    /** URL of a search route below `root`. */
    function searchUrl(route: string, root: string): string {
        return `${api.baseUrl}/api/v1/agents/${encodeURIComponent(agent.id)}/${route}/${encodeFilesystemPath(root)}`;
    }

    /** Posts a search body to a route. */
    function postSearch(
        route: string,
        root: string,
        search: SearchPost,
    ): Promise<Response> {
        const { signal, ...body } = search;

        return fetch(searchUrl(route, root), {
            method: "POST",
            headers: {
                ...agent.getAuthHeaders(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
        });
    }

    /** Parses a whole NDJSON body. */
    async function events<T>(response: Response): Promise<T[]> {
        const text = await response.text();

        return text
            .split("\n")
            .filter((line) => line !== "")
            .map((line): T => JSON.parse(line));
    }

    /**
     * Builds a maze of folders whose paths double with every level, without a cycle, so a
     * search of it only ends when it is stopped. Every level holds `fileName`.
     */
    async function symlinkMaze(fileName: string, contents: string) {
        const maze = tempFiles.tempDirectory({ suffix: "-search-maze" });
        const levels = 40;

        for (let level = 0; level <= levels; level++) {
            const directory = path.join(maze, `level-${level}`);

            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, fileName), contents);

            if (level < levels) {
                const next = path.join(maze, `level-${level + 1}`);

                await fs.symlink(next, path.join(directory, "a"));
                await fs.symlink(next, path.join(directory, "b"));
            }
        }

        return path.join(maze, "level-0");
    }

    /** The running agent process, whose log tells when it stopped a search. */
    function agentProcess() {
        const process = processes.getProcess(agentPid);

        if (!process) {
            throw new Error("Agent process not found");
        }

        return process;
    }

    it("streams path matches as NDJSON ending with done", async () => {
        const response = await postSearch("find-stream", searchRoot, {
            query: "streamtarget",
        });

        // The search started, so the matches follow a success status.
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "application/x-ndjson",
        );

        const lines = await events<FileSearchEvent>(response);
        const last = lines.at(-1);

        // The stream ends with its summary, which only a finished search sends.
        expect(last).toMatchObject({ type: "done", timed_out: false });
        // Every match came before the summary, with the score clients rank by.
        expect(
            lines
                .slice(0, -1)
                .map((event) =>
                    event.type === "match" ? path.basename(event.entry.path) : null,
                )
                .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
        ).toEqual([
            "stream-target-1.txt",
            "stream-target-2.txt",
            "stream-target-3.txt",
        ]);
        expect(
            lines.every(
                (event) => event.type === "done" || event.entry.score > 0,
            ),
        ).toBe(true);
    });

    it("streams content matches as NDJSON ending with done", async () => {
        const response = await postSearch("grep-stream", searchRoot, {
            query: "stream-needle",
            before_context: 1,
        });

        expect(response.status).toBe(200);

        const lines = await events<ContentGrepEvent>(response);

        // The stream ends with its summary.
        expect(lines.at(-1)).toMatchObject({
            type: "done",
            timed_out: false,
            truncated: false,
        });

        const matches = lines.flatMap((event) =>
            event.type === "match" ? [event.entry] : [],
        );

        // Each file's matching line arrives with its context.
        expect(matches).toHaveLength(3);
        expect(
            matches.every(
                (entry) =>
                    entry.line_number === 2 &&
                    entry.before_context[0]?.line === "before",
            ),
        ).toBe(true);
    });

    it("answers early agent errors with an HTTP error instead of a stream", async () => {
        const missing = await postSearch(
            "find-stream",
            path.join(searchRoot, "missing"),
            { query: "anything" },
        );

        // A root that does not exist is reported before any data, as a 404.
        expect(missing.status).toBe(404);

        const invalidRegex = await postSearch("grep-stream", searchRoot, {
            query: "(",
        });

        // An invalid expression is the caller's mistake.
        expect(invalidRegex.status).toBe(400);
        const invalidRegexBody: ErrorBody = await invalidRegex.json();

        expect(invalidRegexBody.error).toMatch(
            /regular expression/,
        );

        const emptyQuery = await postSearch("find-stream", searchRoot, {
            query: " ",
        });

        // An empty query is rejected by the agent's validation.
        expect(emptyQuery.status).toBe(400);

        const badTimeout = await postSearch("grep-stream", searchRoot, {
            query: "x",
            timeout: 0,
        });

        // The server rejects options it never sends to the agent.
        expect(badTimeout.status).toBe(400);
    });

    it("stops the agent's path search when the client disconnects", async () => {
        const maze = await symlinkMaze("maze-target.txt", "");
        await agent.updateLoggingLevel("debug");

        const controller = new AbortController();

        const response = await postSearch(
            "find-stream",
            maze,
            { query: "mazetarget", timeout: 60, signal: controller.signal },
        );

        expect(response.status).toBe(200);

        const reader = response.body?.getReader();

        if (reader === undefined) {
            throw new Error("The stream has no body");
        }

        const first = await reader.read();
        const text = new TextDecoder().decode(first.value);

        // Matches arrive while the endless walk is still running.
        expect(text).toContain('"type":"match"');
        expect(text).not.toContain('"type":"done"');

        const canceled = waitForLogMessage(
            agentProcess(),
            new RegExp(`File search canceled: path=${escapeRegExp(maze)}`),
        );

        controller.abort();

        // Without the cancel the agent would keep walking for the whole minute.
        await canceled;
    });

    it("stops the agent's content search when the client disconnects", async () => {
        const maze = await symlinkMaze("maze.txt", "nothing to find\n");
        await agent.updateLoggingLevel("debug");

        const controller = new AbortController();

        const started = waitForLogMessage(
            agentProcess(),
            new RegExp(`Content grep scan started: path=${escapeRegExp(maze)}`),
        );

        const response = await postSearch(
            "grep-stream",
            maze,
            {
                query: "absent-needle",
                fixed_string: true,
                timeout: 60,
                signal: controller.signal,
            },
        );

        // Headers go out once the agent validated the search, before any match exists.
        expect(response.status).toBe(200);
        await started;

        const canceled = waitForLogMessage(
            agentProcess(),
            new RegExp(`Content grep canceled: path=${escapeRegExp(maze)}`),
        );

        controller.abort();

        // The scan stops at once instead of running into its deadline.
        await canceled;
    });

    it("keeps the JSON search routes' response shape", async () => {
        const found = await agent.searchFiles(searchRoot, "streamtarget", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
        });

        // The JSON route still answers with the whole list and its summary.
        expect(found.results).toHaveLength(3);
        expect(found.timed_out).toBe(false);
        // Results are ranked best first, as before streaming.
        expect(
            found.results.every(
                (entry, index) =>
                    index === 0 ||
                    (found.results[index - 1]?.score ?? 0) >= entry.score,
            ),
        ).toBe(true);

        const grepped = await agent.grepContent(searchRoot, "stream-needle", {
            timeoutSeconds: 5,
            includeHidden: false,
            respectGitignore: true,
            fixedString: true,
        });

        // The content route keeps every summary field next to its matches.
        expect(grepped).toMatchObject({
            timed_out: false,
            cancelled: false,
            truncated: false,
            omitted_long_lines: 0,
        });
        expect(grepped.results).toHaveLength(3);
    });
});
