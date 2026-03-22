import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import path from "node:path";

import {
    AGENT_PATH,
    ProcessManager,
    SERVER_PATH,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "test-agent-metadata";

describe("Metadata Content-Type Detection", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let apiClient: ApiClient;
    let serverPid: number;
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
        processManager.killAll();
    });

    it("should detect shell script without extension via shebang", async () => {
        // Create a shell script without extension
        const scriptContent = "#!/bin/bash\necho 'Hello World'";
        const scriptPath = tempFiles.create(scriptContent, { suffix: "" });

        // Download the file to trigger metadata detection
        const response = await testAgent.download(scriptPath);

        // Verify Content-Type header is text/plain (detected from shebang)
        expect(response.headers.get("Content-Type")).toBe("text/plain");
    });

    it("should detect Python script without extension via shebang", async () => {
        const scriptContent = "#!/usr/bin/env python3\nprint('Hello')";
        const scriptPath = tempFiles.create(scriptContent, { suffix: "" });

        const response = await testAgent.download(scriptPath);
        expect(response.headers.get("Content-Type")).toBe("text/plain");
    });

    it("should detect PNG file without extension via magic bytes", async () => {
        // PNG magic bytes: 0x89 0x50 0x4E 0x47
        const pngHeader = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const pngPath = tempFiles.create(pngHeader, { suffix: "" });

        const response = await testAgent.download(pngPath);
        expect(response.headers.get("Content-Type")).toBe("image/png");
    });

    it("should detect PDF file without extension via magic bytes", async () => {
        const pdfHeader = Buffer.from("%PDF-1.4");
        const pdfPath = tempFiles.create(pdfHeader, { suffix: "" });

        const response = await testAgent.download(pdfPath);
        expect(response.headers.get("Content-Type")).toBe("application/pdf");
    });

    it("should detect ELF binary without extension via magic bytes", async () => {
        // ELF magic bytes: 0x7F 'E' 'L' 'F'
        const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
        const elfPath = tempFiles.create(elfHeader, { suffix: "" });

        const response = await testAgent.download(elfPath);
        expect(response.headers.get("Content-Type")).toBe(
            "application/x-executable",
        );
    });

    it("should detect ZIP file without extension via magic bytes", async () => {
        // ZIP magic bytes: PK\x03\x04
        const zipHeader = Buffer.from("PK\x03\x04");
        const zipPath = tempFiles.create(zipHeader, { suffix: "" });

        const response = await testAgent.download(zipPath);
        expect(response.headers.get("Content-Type")).toBe("application/zip");
    });

    it("should detect GZIP file without extension via magic bytes", async () => {
        // GZIP magic bytes: 0x1F 0x8B
        const gzipHeader = Buffer.from([0x1f, 0x8b]);
        const gzipPath = tempFiles.create(gzipHeader, { suffix: "" });

        const response = await testAgent.download(gzipPath);
        expect(response.headers.get("Content-Type")).toBe("application/gzip");
    });

    it("should fall back to octet-stream for unknown binary without extension", async () => {
        // Unknown binary content
        const unknownContent = Buffer.from([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
        ]);
        const unknownPath = tempFiles.create(unknownContent, { suffix: "" });

        const response = await testAgent.download(unknownPath);
        expect(response.headers.get("Content-Type")).toBe(
            "application/octet-stream",
        );
    });

    it("should still use extension-based detection when extension is present", async () => {
        // Create a file with .txt extension but PNG header
        // Extension should take precedence
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const filePath = tempFiles.create(pngHeader, { suffix: ".txt" });

        const response = await testAgent.download(filePath);
        // Should be text/plain based on extension, not image/png based on content
        expect(response.headers.get("Content-Type")).toBe("text/plain");
    });
});
