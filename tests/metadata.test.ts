import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Agent } from "#ui/api-client";

import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "test-agent-metadata";

describe("Metadata Content-Type Detection", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
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

        testAgent = setup.testAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
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

    it("should mark valid UTF-8 files editable regardless of extension", async () => {
        const filePath = tempFiles.create("plain content", { suffix: "" });
        const metadata = await testAgent.metadata(filePath);
        // Extensionless UTF-8 still opens in the editor after agent-side sniffing.
        expect(metadata.editable).toBe(true);
    });

    it("should not mark invalid UTF-8 files editable even with text extension", async () => {
        const filePath = tempFiles.create(Buffer.from([0xff, 0xfe, 0xfd]), {
            suffix: ".txt",
        });
        const metadata = await testAgent.metadata(filePath);
        // Extension must not override the UTF-8 validity check used by the editor gate.
        expect(metadata.editable).toBe(false);
    });

    it("should not mark multi-megabyte UTF-8 files editable", async () => {
        const largeContent = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
        const filePath = tempFiles.create(largeContent, { suffix: ".txt" });
        const metadata = await testAgent.metadata(filePath);
        // Large files stay download-only so the browser never loads them into a textarea.
        expect(metadata.editable).toBe(false);
    });

    it("should mark PNG magic bytes viewable regardless of extension", async () => {
        const pngHeader = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const filePath = tempFiles.create(pngHeader, { suffix: ".txt" });
        const metadata = await testAgent.metadata(filePath);
        // Image viewing is gated on content magic, not the filename suffix.
        expect(metadata.viewable_image).toBe(true);
        // PNG bytes are not valid UTF-8 text for the editor.
        expect(metadata.editable).toBe(false);
    });

    it("should not mark non-image bytes viewable even with image extension", async () => {
        const filePath = tempFiles.create(Buffer.from([0x00, 0x01, 0x02, 0x03]), {
            suffix: ".png",
        });
        const metadata = await testAgent.metadata(filePath);
        // A .png suffix alone must not open the image viewer.
        expect(metadata.viewable_image).toBe(false);
    });

    it("should not mark multi-tens-of-megabyte images viewable", async () => {
        const largePng = Buffer.alloc(20 * 1024 * 1024 + 1);
        largePng[0] = 0x89;
        largePng[1] = 0x50;
        largePng[2] = 0x4e;
        largePng[3] = 0x47;
        largePng[4] = 0x0d;
        largePng[5] = 0x0a;
        largePng[6] = 0x1a;
        largePng[7] = 0x0a;
        const filePath = tempFiles.create(largePng, { suffix: "" });
        const metadata = await testAgent.metadata(filePath);
        // Size gating avoids loading multi-tens-of-megabyte images into the browser.
        expect(metadata.viewable_image).toBe(false);
    });
});
