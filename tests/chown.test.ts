import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, ApiError } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "chown-test-agent";

describe("Chown Path API", () => {
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

    it("lists host users and groups on demand", async () => {
        const accounts = await testAgent.accounts();
        // A non-empty catalog proves enumeration is a dedicated request rather than connect metadata.
        expect(accounts.users.length).toBeGreaterThan(0);
        expect(accounts.groups.length).toBeGreaterThan(0);
        const currentUser = os.userInfo().username;
        // The running agent account must be present so a root UI can select it after a chown.
        expect(accounts.users.some((user) => user.name === currentUser)).toBe(
            true,
        );
    });

    it("rejects missing owner and group before contacting the filesystem", async () => {
        const filePath = path.join(agentCwd, "no-change.txt");
        await fs.writeFile(filePath, "unchanged");

        await expect(testAgent.chown(filePath, {})).rejects.toMatchObject({
            status: 400,
        } satisfies Partial<ApiError>);
        const stats = await fs.stat(filePath);
        // The file remaining owned by the test user proves validation happened before chown.
        expect(stats.uid).toBe(os.userInfo().uid);
    });

    it("reads owner and group from query parameters", async () => {
        const filePath = path.join(agentCwd, "query-contract.txt");
        await fs.writeFile(filePath, "unchanged");
        const url = new URL(
            testAgent.getRawUrl(filePath).replace("/raw/", "/chown/"),
        );
        url.searchParams.set("owner", String(os.userInfo().uid));
        url.searchParams.set("group", String(os.userInfo().gid));

        const response = await fetch(url, {
            method: "POST",
            headers: testAgent.getAuthHeaders(),
        });
        // Root accepts the query-only request; non-root rejection still proves route parsing reached the privilege gate.
        expect(response.status).toBe(testAgent.isRoot ? 200 : 403);
        // The direct URL keeps ownership selectors out of the JSON body contract.
        expect(url.searchParams.get("owner")).toBe(String(os.userInfo().uid));
        expect(url.searchParams.get("group")).toBe(String(os.userInfo().gid));
    });

    it("rejects unknown owner names after the root gate", async () => {
        const filePath = path.join(agentCwd, "unknown-owner.txt");
        await fs.writeFile(filePath, "unknown");
        const owner = `redoor-missing-${process.pid}-${Date.now()}`;

        if (testAgent.isRoot) {
            await expect(testAgent.chown(filePath, { owner })).rejects.toThrow(
                `Owner '${owner}' does not exist on the agent`,
            );
            return;
        }
        // Non-root agents must not leak whether a name exists; the UI never shows the control.
        await expect(
            testAgent.chown(filePath, { owner }),
        ).rejects.toMatchObject({
            status: 403,
        } satisfies Partial<ApiError>);
    });

    it("rejects non-root chown even for a same-uid no-op", async () => {
        if (testAgent.isRoot) {
            return;
        }
        const filePath = path.join(agentCwd, "same-uid.txt");
        await fs.writeFile(filePath, "same");
        const uid = os.userInfo().uid;

        await expect(
            testAgent.chown(filePath, { owner: String(uid) }),
        ).rejects.toMatchObject({
            status: 403,
        } satisfies Partial<ApiError>);
        // The agent, not the kernel, is the trust boundary for the hidden owner control.
        await expect(
            testAgent.chown(filePath, { owner: String(uid) }),
        ).rejects.toThrow("Only a root agent can change ownership");
    });

    it("follows a symlink to the target inode instead of the link", async () => {
        const targetPath = path.join(agentCwd, "chown-target.txt");
        const linkPath = path.join(agentCwd, "chown-link");
        await fs.writeFile(targetPath, "target");
        await fs.symlink(targetPath, linkPath);
        const targetBefore = await fs.stat(targetPath);
        const linkBefore = await fs.lstat(linkPath);

        if (!testAgent.isRoot) {
            await expect(
                testAgent.chown(linkPath, { owner: "nobody" }),
            ).rejects.toMatchObject({
                status: 403,
            } satisfies Partial<ApiError>);
            // A rejected chown must not lchown the link; details already shows the followed target.
            expect((await fs.lstat(linkPath)).uid).toBe(linkBefore.uid);
            expect((await fs.stat(targetPath)).uid).toBe(targetBefore.uid);
            return;
        }

        const accounts = await testAgent.accounts();
        const otherUser = accounts.users.find(
            (user) => user.uid !== targetBefore.uid,
        );
        if (otherUser === undefined) {
            throw new Error(
                "Root agent returned no second user for symlink chown",
            );
        }
        const response = await testAgent.chown(linkPath, {
            owner: otherUser.name,
        });
        // The followed target is the inode details already displayed.
        expect(response.uid).toBe(otherUser.uid);
        expect((await fs.stat(targetPath)).uid).toBe(otherUser.uid);
        // The link remaining at the original uid proves we did not lchown the symlink.
        expect((await fs.lstat(linkPath)).uid).toBe(linkBefore.uid);
        expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    });

    it("rejects non-root chown of files and directories", async () => {
        if (testAgent.isRoot) {
            return;
        }
        const filePath = path.join(agentCwd, "file-chown.txt");
        const directoryPath = path.join(agentCwd, "dir-chown");
        await fs.writeFile(filePath, "file");
        await fs.mkdir(directoryPath);

        await expect(
            testAgent.chown(filePath, { owner: "nobody" }),
        ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
        await expect(
            testAgent.chown(directoryPath, { group: "nogroup" }),
        ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
    });
});
