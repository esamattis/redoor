import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { $ } from "zx";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { LsDirectoryResponse } from "#bindings/LsDirectoryResponse";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { CreateDirectoryResponse } from "#bindings/CreateDirectoryResponse";
import type { RawDeleteResponse } from "#bindings/RawDeleteResponse";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { Permission } from "#bindings/Permission";
import {
    ALL_PERMISSIONS,
    ProcessManager,
    TempFileManager,
    createAccessToken,
    remoteEnv,
    startServerAndAgent,
    waitForAgentReady,
} from "./test-utils";

describe("Remote CLI file commands", () => {
    const processes = new ProcessManager();
    const files = new TempFileManager();

    const binary =
        process.env.REDOOR_TEST_BINARY ?? path.resolve("target/debug/redoor");

    const secondId = "remote-files-second";

    let setup: Awaited<ReturnType<typeof startServerAndAgent>>;
    let home: string;
    let root: string;
    let secondRoot: string;
    let trash: string;
    let token: string;

    beforeAll(async () => {
        root = files.tempDirectory();
        secondRoot = files.tempDirectory();
        trash = path.join(files.tempDirectory(), "trash");
        setup = await startServerAndAgent({
            processManager: processes,
            agentName: "remote-files",
            agentCwd: root,
            agentEnv: { REDOOR_AGENT_TRASH_DIRECTORY: trash },
        });

        const server = processes.getProcess(setup.serverPid);

        if (server === undefined) throw new Error("Missing server process");
        const ready = waitForAgentReady(server, secondId);
        processes.spawnAgent({
            wsAddress: setup.wsUrl,
            name: secondId,
            cwd: secondRoot,
            home: secondRoot,
        });
        await ready;
        home = files.tempDirectory();

        token = (
            await createAccessToken(setup.apiClient, {
                name: "remote files test",
                permissions: ALL_PERMISSIONS,
            })
        ).token;
    }, 30_000);

    afterAll(async () => {
        await processes.killAll();
        files.cleanup();
    });

    /** Runs one CLI command with a token from the environment. */
    function remote(args: string[], bearer: string = token) {
        return $({
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: "remote-files-test",
                ...remoteEnv(setup.apiClient.baseUrl, bearer),
            },
            quiet: true,
            nothrow: true,
        })`exec ${binary} remote ${args}`;
    }

    /** Formats a `DEVICE:/path` argument on the main test agent. */
    function at(file: string, device: string = setup.testAgent.id) {
        return `${device}:${file}`;
    }

    it("lists directories and describes paths", async () => {
        const directory = path.join(root, "listing");
        await fs.mkdir(path.join(directory, "child"), { recursive: true });
        await fs.writeFile(path.join(directory, "note.txt"), "hello");

        const ls = await remote(["ls", at(directory)]);
        // The human listing shows each entry with its type.
        expect(ls.exitCode, ls.stderr).toBe(0);
        expect(ls.stdout).toMatch(/directory\s+\d+\s+.*child/);
        expect(ls.stdout).toMatch(/file\s+5\s+.*note\.txt/);

        const json = await remote(["ls", "--json", at(directory)]);
        const listing: LsDirectoryResponse = JSON.parse(json.stdout);
        // The JSON is the API's directory listing.
        expect(listing.path).toBe(directory);
        expect(listing.files.map((entry) => entry.name).sort()).toEqual([
            "child",
            "note.txt",
        ]);

        const stat = await remote([
            "stat",
            "--json",
            at(path.join(directory, "note.txt")),
        ]);

        const metadata: MetadataResponse = JSON.parse(stat.stdout);
        // Stat reports the API metadata of a single path.
        expect(metadata).toMatchObject({ is_file: true, file_size: 5 });

        const human = await remote(["stat", at(directory)]);
        // The human form names the type.
        expect(human.stdout).toContain("Type:      directory");
    });

    it("creates directories with plain mkdir semantics unless -p is given", async () => {
        const nested = path.join(root, "made", "deep");

        const missingParent = await remote(["mkdir", at(nested)]);
        // Like mkdir(1), a missing parent is an error without -p.
        expect(missingParent.exitCode).not.toBe(0);
        expect(missingParent.stderr).toContain("-p");
        expect(existsSync(nested)).toBe(false);

        const parents = await remote(["mkdir", "-p", "--json", at(nested)]);
        expect(parents.exitCode, parents.stderr).toBe(0);
        const created: CreateDirectoryResponse = JSON.parse(parents.stdout);
        // -p creates the whole chain.
        expect(created.path).toBe(nested);
        expect((await fs.stat(nested)).isDirectory()).toBe(true);

        const existing = await remote(["mkdir", at(nested)]);
        // An existing path is an error without -p, and accepted with it.
        expect(existing.exitCode).not.toBe(0);
        expect(existing.stderr).toContain("already exists");
        expect((await remote(["mkdir", "-p", at(nested)])).exitCode).toBe(0);
    });

    it("removes files to the trash by default and refuses directories without -r", async () => {
        const directory = path.join(root, "removable");
        const trashed = path.join(directory, "trashed.txt");
        const permanent = path.join(root, "permanent.txt");
        await fs.mkdir(directory);
        await fs.writeFile(trashed, "to trash");
        await fs.writeFile(permanent, "gone");

        const refused = await remote(["rm", at(directory)]);
        // Like rm(1), a directory needs -r.
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("use -r");
        expect(existsSync(directory)).toBe(true);

        const toTrash = await remote(["rm", "--json", at(trashed)]);
        expect(toTrash.exitCode, toTrash.stderr).toBe(0);
        const deleted: RawDeleteResponse = JSON.parse(toTrash.stdout);
        // The default is the trash, so the file can still be restored.
        expect(deleted.path).toBe(trashed);
        expect(existsSync(trashed)).toBe(false);
        expect(
            (await fs.readdir(path.join(trash, "files"))).some((name) =>
                name.startsWith("trashed"),
            ),
        ).toBe(true);

        const removed = await remote(["rm", "--permanent", at(permanent)]);
        // --permanent deletes without the trash.
        expect(removed.exitCode, removed.stderr).toBe(0);
        expect(existsSync(permanent)).toBe(false);
        expect(
            (await remote(["rm", "-r", "--permanent", at(directory)])).exitCode,
        ).toBe(0);
        expect(existsSync(directory)).toBe(false);
    });

    it("explains a missing files:delete permission", async () => {
        const file = path.join(root, "kept.txt");
        await fs.writeFile(file, "kept");

        const permissions: Permission[] = ALL_PERMISSIONS.filter(
            (permission) => permission !== "files:delete",
        );

        const limited = await createAccessToken(setup.apiClient, {
            name: "no delete",
            permissions,
        });

        const result = await remote(
            ["rm", "--permanent", at(file)],
            limited.token,
        );

        // The server's reason reaches the user, and the file survives.
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("files:delete");
        expect(existsSync(file)).toBe(true);
    });

    it("moves paths on one device and between devices", async () => {
        const source = path.join(root, "move-me.txt");
        const renamed = path.join(root, "moved.txt");
        await fs.writeFile(source, "moving");

        const local = await remote(["mv", "--json", at(source), at(renamed)]);
        expect(local.exitCode, local.stderr).toBe(0);
        // A same-device move renames the file.
        expect(JSON.parse(local.stdout)).toMatchObject({
            status: "completed",
            resolved_destination: at(renamed),
        });
        expect(existsSync(source)).toBe(false);
        expect(await fs.readFile(renamed, "utf8")).toBe("moving");

        const across = await remote([
            "mv",
            at(renamed),
            at(`${secondRoot}/`, secondId),
        ]);

        // Moving into an existing directory on another device keeps the basename.
        expect(across.exitCode, across.stderr).toBe(0);
        expect(existsSync(renamed)).toBe(false);
        expect(await fs.readFile(path.join(secondRoot, "moved.txt"), "utf8")).toBe(
            "moving",
        );

        const replacement = path.join(root, "replacement.txt");
        await fs.writeFile(replacement, "replaced");
        const target = at(path.join(secondRoot, "moved.txt"), secondId);

        const refused = await remote(["mv", at(replacement), target]);

        // An existing destination is only replaced when explicitly asked for.
        expect(refused.exitCode).not.toBe(0);
        expect(existsSync(replacement)).toBe(true);

        const forced = await remote(["mv", "-f", at(replacement), target]);

        // --force replaces the existing destination with the moved file.
        expect(forced.exitCode, forced.stderr).toBe(0);
        expect(await fs.readFile(path.join(secondRoot, "moved.txt"), "utf8")).toBe(
            "replaced",
        );
    });

    it("finds names and greps contents", async () => {
        const directory = path.join(root, "searchable");
        await fs.mkdir(directory);
        await fs.writeFile(
            path.join(directory, "needle-file.txt"),
            "before\nthe needle line\nafter\n",
        );

        const find = await remote(["find", at(directory), "needle"]);
        // find prints one matching path per line.
        expect(find.exitCode, find.stderr).toBe(0);
        expect(find.stdout.trim()).toBe(path.join(directory, "needle-file.txt"));

        const findJson: FileSearchResponse = JSON.parse(
            (await remote(["find", "--json", at(directory), "needle"])).stdout,
        );

        // The JSON is the API search response.
        expect(findJson.results.map((entry) => entry.name)).toEqual([
            "needle-file.txt",
        ]);

        const grep = await remote([
            "grep",
            "-F",
            "-C",
            "1",
            at(directory),
            "needle line",
        ]);

        const file = path.join(directory, "needle-file.txt");
        // grep prints ripgrep-style match and context lines.
        expect(grep.exitCode, grep.stderr).toBe(0);
        expect(grep.stdout.trim().split("\n")).toEqual([
            `${file}-1-before`,
            `${file}:2:the needle line`,
            `${file}-3-after`,
        ]);

        const grepJson: ContentGrepResponse = JSON.parse(
            (await remote(["grep", "--json", at(directory), "needle"])).stdout,
        );

        // The JSON is the API grep response.
        expect(grepJson.results).toEqual([
            expect.objectContaining({ path: file, line_number: 2 }),
        ]);
    });
});
