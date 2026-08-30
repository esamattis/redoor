import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, ApiError } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "chmod-test-agent";

describe("Chmod Path API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let testAgent: Agent;
    let agentCwd: string;

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    beforeAll(async () => {
        agentCwd = tempFiles.tempDirectory({ suffix: "-agent-cwd" });
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd,
        });
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("changes ordinary mode bits for files and directories", async () => {
        const filePath = path.join(agentCwd, "mode-file.txt");
        const directoryPath = path.join(agentCwd, "mode-dir");
        await fsp.writeFile(filePath, "mode");
        await fsp.mkdir(directoryPath);
        fs.chmodSync(filePath, 0o644);
        fs.chmodSync(directoryPath, 0o755);

        const fileResponse = await testAgent.chmod(filePath, 0o600);
        const directoryResponse = await testAgent.chmod(directoryPath, 0o700);

        // The response identifies the path the details view mutated.
        expect(fileResponse.path).toBe(filePath);
        expect(directoryResponse.path).toBe(directoryPath);
        // Echoed permissions let the grid, symbolic line, and octal line update together.
        expect(fileResponse.permissions).toBe(0o600);
        expect(directoryResponse.permissions).toBe(0o700);
        // Disk mode must match the response so a later ls cannot disagree with the mutation.
        expect(fs.statSync(filePath).mode & 0o777).toBe(fileResponse.permissions);
        expect(fs.statSync(directoryPath).mode & 0o777).toBe(
            directoryResponse.permissions,
        );
    });

    it("toggles one permission bit without clearing the rest", async () => {
        const filePath = path.join(agentCwd, "toggle.txt");
        await fsp.writeFile(filePath, "toggle");
        fs.chmodSync(filePath, 0o644);

        const response = await testAgent.chmod(filePath, 0o644 | 0o100);

        // Adding execute for the owner is the same 9-bit mask the interactive grid sends.
        expect(response.permissions).toBe(0o744);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o744);
    });

    it("rejects permissions outside the ordinary 9-bit mask", async () => {
        const filePath = path.join(agentCwd, "invalid-mode.txt");
        await fsp.writeFile(filePath, "invalid");
        fs.chmodSync(filePath, 0o644);

        await expect(testAgent.chmod(filePath, 0o1000)).rejects.toMatchObject({
            status: 400,
        } satisfies Partial<ApiError>);
        // The original mode remaining proves the agent did not apply a special-bit request.
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);
    });

    it("preserves setuid, setgid, and sticky bits while replacing rwx", async () => {
        const filePath = path.join(agentCwd, "special.txt");
        await fsp.writeFile(filePath, "special");
        fs.chmodSync(filePath, 0o4755);

        const response = await testAgent.chmod(filePath, 0o644);
        const mode = fs.statSync(filePath).mode;

        expect(response.permissions).toBe(0o644);
        expect(mode & 0o777).toBe(0o644);
        // Special bits must survive because the details grid does not edit setuid/setgid/sticky.
        expect(mode & 0o7000).toBe(0o4000);
    });

    it("changes the symlink target mode instead of the link inode", async () => {
        const targetPath = path.join(agentCwd, "link-target.txt");
        const linkPath = path.join(agentCwd, "mode-link");
        await fsp.writeFile(targetPath, "target");
        await fsp.symlink(targetPath, linkPath);
        fs.chmodSync(targetPath, 0o644);
        const linkModeBefore = fs.lstatSync(linkPath).mode;

        const response = await testAgent.chmod(linkPath, 0o600);

        expect(response.permissions).toBe(0o600);
        // Details already follows the path, so chmod must mutate that same target inode.
        expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        // The link's own mode staying put proves we did not lchmod the symlink.
        expect(fs.lstatSync(linkPath).mode).toBe(linkModeBefore);
    });

    it("lets an owner agent chmod without being root", async () => {
        const filePath = path.join(agentCwd, "owner-mode.txt");
        await fsp.writeFile(filePath, "owner");
        fs.chmodSync(filePath, 0o640);

        const response = await testAgent.chmod(filePath, 0o600);

        expect(response.permissions).toBe(0o600);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        // This coverage is specifically for non-root owners; root would also succeed.
        expect(fs.statSync(filePath).uid).toBe(os.userInfo().uid);
    });

    it("denies chmod of a foreign-uid path when the agent is not root", async () => {
        if (testAgent.isRoot) {
            return;
        }
        const uid = process.getuid?.();
        if (uid === undefined) {
            return;
        }
        const foreignPath = "/etc/hosts";
        let stats: fs.Stats;
        try {
            stats = fs.statSync(foreignPath);
        } catch {
            return;
        }
        if (stats.uid === uid) {
            return;
        }

        await expect(testAgent.chmod(foreignPath, 0o644)).rejects.toMatchObject({
            status: 403,
        } satisfies Partial<ApiError>);
    });
});
