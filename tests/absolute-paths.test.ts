import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { request as httpRequest } from "node:http";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";
import type { Agent, ApiClient } from "@/api-client";

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
const defaultDirectory = tempFiles.tempDirectory({ suffix: "-default" });
const outsideDirectory = tempFiles.tempDirectory({ suffix: "-outside" });
let agent: Agent;
let api: ApiClient;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: "absolute-path-agent",
        agentCwd: defaultDirectory,
    });
    agent = started.testAgent;
    api = started.apiClient;
}, 30_000);

afterAll(() => {
    tempFiles.cleanup();
    processManager.killAll();
});

describe("absolute filesystem path contract", () => {
    it("accesses filesystem paths outside the default directory", async () => {
        const sourcePath = path.join(outsideDirectory, "source.txt");
        const uploadPath = path.join(outsideDirectory, "uploaded.txt");
        const directoryPath = path.join(outsideDirectory, "created");
        const copyPath = path.join(outsideDirectory, "copied.txt");
        await fs.writeFile(sourcePath, "outside-default");

        const listing = await agent.ls(outsideDirectory);
        // Listing an unrelated absolute tree proves the startup default is not a root boundary.
        expect("files" in listing).toBe(true);

        const downloaded = Buffer.from(await agent.raw(sourcePath)).toString();
        // Reading outside the default proves absolute paths are sent unchanged to the OS.
        expect(downloaded).toBe("outside-default");

        await agent.upload(uploadPath, new File(["uploaded"], "uploaded.txt"));
        // The uploaded file verifies nonexistent absolute destinations are accepted lexically.
        expect(await fs.readFile(uploadPath, "utf8")).toBe("uploaded");

        await agent.createDirectory(directoryPath);
        // Directory creation outside the default proves mkdir has the same absolute contract.
        expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);

        await agent.copyTo({ agent: agent.id, path: copyPath }, sourcePath);
        await waitForValue({
            predicate: async () =>
                fs.readFile(copyPath, "utf8").catch(() => undefined),
            description: "absolute-path copy completion",
        });
        // Same-agent copy must retain full source and destination paths.
        expect(await fs.readFile(copyPath, "utf8")).toBe("outside-default");

        await agent.deleteFile(copyPath);
        // Deletion outside the default confirms no endpoint reintroduces cwd scoping.
        await expect(fs.stat(copyPath)).rejects.toThrow();
    });

    it("rejects relative paths at every public boundary", async () => {
        const agentId = encodeURIComponent(agent.id);
        // Browser routes must reject cwd-relative addressing before building a URL.
        expect(() => agent.getBrowserUrl("relative")).toThrow(
            "Filesystem path must be absolute",
        );
        // REST listing must reject cwd-relative addressing before sending a request.
        await expect(agent.ls("relative")).rejects.toThrow(
            "Filesystem path must be absolute",
        );
        // Raw URLs are public boundaries used by download, upload, and delete operations.
        expect(() => agent.getRawUrl("relative")).toThrow(
            "Filesystem path must be absolute",
        );
        // Directory creation must not reinterpret a relative destination beneath cwd.
        await expect(agent.createDirectory("relative")).rejects.toThrow(
            "Filesystem path must be absolute",
        );

        for (const request of [
            {
                source: { agent: agent.id, path: "relative" },
                dest: { agent: agent.id, path: "/tmp/destination" },
            },
            {
                source: { agent: agent.id, path: "/tmp/source" },
                dest: { agent: agent.id, path: "relative" },
            },
        ]) {
            const response = await fetch(`${api.baseUrl}/api/v1/copy`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...api.getAuthHeaders(),
                },
                body: JSON.stringify(request),
            });
            // Both copy endpoints must reject relative values independently.
            expect(response.status).toBe(400);
            // Copy uses the same stable path validation error as direct operations.
            expect(await response.text(), JSON.stringify(request)).toBe(
                JSON.stringify({ error: "Filesystem path must be absolute" }),
            );
        }

        const terminalResponse = await new Promise<{
            status: number | undefined;
            body: string;
        }>((resolve, reject) => {
            const request = httpRequest(
                `${api.baseUrl}/api/v1/agents/${agentId}/terminal/ws?rows=24&cols=80&cwd=relative`,
                {
                    headers: {
                        Connection: "Upgrade",
                        Upgrade: "websocket",
                        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                        "Sec-WebSocket-Version": "13",
                        ...api.getAuthHeaders(),
                    },
                },
                (response) => {
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                        body += chunk;
                    });
                    response.on("end", () =>
                        resolve({ status: response.statusCode, body }),
                    );
                },
            );
            request.on("error", reject);
            request.end();
        });
        // Terminal setup validates cwd before accepting a WebSocket upgrade.
        expect(terminalResponse.status).toBe(400);
        // The terminal boundary reports the same malformed-path contract.
        expect(terminalResponse.body).toBe(
            JSON.stringify({ error: "Filesystem path must be absolute" }),
        );

        // No rejected relative destination may be resolved beneath the default directory.
        await expect(
            fs.stat(path.join(defaultDirectory, "relative")),
        ).rejects.toThrow();
    });
});
