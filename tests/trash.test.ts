import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "trash-test-agent";

describe("Trash API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let testAgent: Agent;
    let root: string;
    let trashRoot: string;

    beforeAll(async () => {
        root = tempFiles.tempDirectory({ suffix: "-trash-suite" });
        trashRoot = path.join(root, "trash-root");
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: root,
            agentEnv: { REDOOR_AGENT_TRASH_DIRECTORY: trashRoot },
        });
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("moves files, populated directories, and symlinks without changing inode identity", async () => {
        const file = path.join(root, "inode-file.txt");
        const directory = path.join(root, "populated-directory");
        const symlink = path.join(root, "source-link");
        await fs.writeFile(file, "file contents");
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "child.txt"), "child contents");
        await fs.symlink(file, symlink);
        const before = await fs.lstat(file);

        const response = await testAgent.deleteFile(file, { trash: true });
        await testAgent.deleteFile(directory, { trash: true });
        await testAgent.deleteFile(symlink, { trash: true });
        const listing = await testAgent.listTrash();
        const items = listing.locations.flatMap((location) => location.items);
        const fileItem = items.find((item) => item.original_path === file);
        const symlinkItem = items.find(
            (item) => item.original_path === symlink,
        );

        // The unchanged response model keeps permanent and trash deletion API-compatible.
        expect(response.path).toBe(file);
        // Listing all entry types proves trash uses a metadata move rather than file-only copying.
        expect(items.map((item) => item.original_path)).toEqual(
            expect.arrayContaining([file, directory, symlink]),
        );
        expect(fileItem).toBeDefined();
        if (!fileItem) {
            throw new Error("Trashed file was not listed");
        }
        if (!symlinkItem) {
            throw new Error("Trashed symlink was not listed");
        }
        const payload = path.join(trashRoot, "files", fileItem.name);
        // Device and inode continuity prove publication used rename semantics.
        expect((await fs.lstat(payload)).dev).toBe(before.dev);
        expect((await fs.lstat(payload)).ino).toBe(before.ino);
        // The regular file payload remains readable after its metadata-only move.
        await expect(fs.readFile(payload, "utf8")).resolves.toBe(
            "file contents",
        );
        // Symlink metadata proves trash moved the link itself instead of following its target.
        expect(
            (
                await fs.lstat(path.join(trashRoot, "files", symlinkItem.name))
            ).isSymbolicLink(),
        ).toBe(true);
    });

    it("uses collision-safe names for duplicate basenames and concurrent requests", async () => {
        const firstDirectory = path.join(root, "duplicate-a");
        const secondDirectory = path.join(root, "duplicate-b");
        await fs.mkdir(firstDirectory);
        await fs.mkdir(secondDirectory);
        const first = path.join(firstDirectory, "same.txt");
        const second = path.join(secondDirectory, "same.txt");
        await fs.writeFile(first, "first");
        await fs.writeFile(second, "second");

        await Promise.all([
            testAgent.deleteFile(first, { trash: true }),
            testAgent.deleteFile(second, { trash: true }),
        ]);
        const items = (await testAgent.listTrash()).locations.flatMap(
            (location) => location.items,
        );
        const duplicates = items.filter(
            (item) =>
                item.original_path === first || item.original_path === second,
        );

        // Unique payload names prove concurrent metadata reservations do not overwrite either item.
        expect(new Set(duplicates.map((item) => item.name)).size).toBe(2);
    });

    it("restores to the original path and removes metadata after publication", async () => {
        const source = path.join(root, "restore-me.txt");
        await fs.writeFile(source, "restore contents");
        const before = await fs.lstat(source);
        await testAgent.deleteFile(source, { trash: true });
        const listing = await testAgent.listTrash();
        const location = listing.locations.find((entry) =>
            entry.items.some((item) => item.original_path === source),
        );
        const item = location?.items.find(
            (entry) => entry.original_path === source,
        );
        if (!location || !item) {
            throw new Error("Restore item was not listed");
        }

        const response = await testAgent.restoreTrashItem({
            location_id: location.id,
            item_id: item.id,
            destination_path: source,
        });

        // Returning the destination confirms restore used the metadata-selected original path.
        expect(response.path).toBe(source);
        await expect(fs.readFile(source, "utf8")).resolves.toBe(
            "restore contents",
        );
        // Inode continuity proves restore also used atomic rename rather than copy/delete.
        expect((await fs.lstat(source)).ino).toBe(before.ino);
        await expect(
            fs.access(path.join(trashRoot, "info", `${item.name}.trashinfo`)),
        ).rejects.toThrow();
    });

    it("preserves payload and metadata when the restore destination is occupied", async () => {
        const source = path.join(root, "restore-conflict.txt");
        await fs.writeFile(source, "trashed contents");
        await testAgent.deleteFile(source, { trash: true });
        const listing = await testAgent.listTrash();
        const location = listing.locations.find((entry) =>
            entry.items.some((item) => item.original_path === source),
        );
        const item = location?.items.find(
            (entry) => entry.original_path === source,
        );
        if (!location || !item) {
            throw new Error("Conflict item was not listed");
        }
        await fs.writeFile(source, "occupied");

        const restore = testAgent.restoreTrashItem({
            location_id: location.id,
            item_id: item.id,
            destination_path: source,
        });

        // HTTP conflict communicates that no replacement was performed.
        await expect(restore).rejects.toMatchObject({ status: 409 });
        await expect(fs.readFile(source, "utf8")).resolves.toBe("occupied");
        await expect(
            fs.readFile(path.join(trashRoot, "files", item.name), "utf8"),
        ).resolves.toBe("trashed contents");
        await expect(
            fs.access(path.join(trashRoot, "info", `${item.name}.trashinfo`)),
        ).resolves.toBeUndefined();
    });

    it("returns null for unsafe original metadata and ignores malformed timestamps and orphans", async () => {
        const files = path.join(trashRoot, "files");
        const info = path.join(trashRoot, "info");
        await fs.writeFile(path.join(files, "unsafe"), "unsafe");
        await fs.writeFile(
            path.join(info, "unsafe.trashinfo"),
            `[Trash Info]
Path=relative/path
DeletionDate=2020-01-01T00:00:00
`,
        );
        await fs.writeFile(path.join(files, "malformed"), "malformed");
        await fs.writeFile(
            path.join(info, "malformed.trashinfo"),
            `[Trash Info]
Path=/tmp/file
DeletionDate=not-a-date
`,
        );
        await fs.writeFile(
            path.join(info, "orphan.trashinfo"),
            `[Trash Info]
Path=/tmp/orphan
DeletionDate=2020-01-01T00:00:00
`,
        );

        const items = (await testAgent.listTrash()).locations.flatMap(
            (location) => location.items,
        );

        // A trustworthy timestamp keeps the payload visible even when its original path is unsafe.
        expect(
            items.find((item) => item.name === "unsafe")?.original_path,
        ).toBeNull();
        // Missing trustworthy timestamps must never leak partially valid records into the API.
        expect(items.some((item) => item.name === "malformed")).toBe(false);
        // Metadata without a payload cannot produce a list item.
        expect(items.some((item) => item.name === "orphan")).toBe(false);
    });

    it("rejects missing sources and identifiers that were not returned by listing", async () => {
        const missing = path.join(root, "missing.txt");

        // Missing source errors must be immediate and must not reserve orphan metadata.
        await expect(
            testAgent.deleteFile(missing, { trash: true }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            testAgent.restoreTrashItem({
                location_id: "../trash",
                item_id: "../payload",
                destination_path: missing,
            }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("restores to an explicit destination instead of the metadata path", async () => {
        const source = path.join(root, "restore-to-custom-source.txt");
        const destination = path.join(root, "restore-to-custom-target.txt");
        await fs.writeFile(source, "custom destination contents");
        await testAgent.deleteFile(source, { trash: true });
        const listing = await testAgent.listTrash();
        const location = listing.locations.find((entry) =>
            entry.items.some((item) => item.original_path === source),
        );
        const item = location?.items.find(
            (entry) => entry.original_path === source,
        );
        if (!location || !item) {
            throw new Error("Custom-destination item was not listed");
        }

        const response = await testAgent.restoreTrashItem({
            location_id: location.id,
            item_id: item.id,
            destination_path: destination,
        });

        // The response proves the agent honored the submitted path rather than metadata.
        expect(response.path).toBe(destination);
        // Reading only the selected destination proves the payload was published there.
        await expect(fs.readFile(destination, "utf8")).resolves.toBe(
            "custom destination contents",
        );
        // The original path must stay absent after choosing a different restore location.
        await expect(fs.access(source)).rejects.toThrow();
    });

    it("rejects a forced trash root on another device without copying", async () => {
        const sharedMemory = "/dev/shm";
        let sharedMemoryStats: Awaited<ReturnType<typeof fs.stat>>;
        try {
            sharedMemoryStats = await fs.stat(sharedMemory);
            await fs.access(sharedMemory, fs.constants.W_OK);
        } catch {
            return;
        }
        const rootStats = await fs.stat(root);
        if (sharedMemoryStats.dev === rootStats.dev) {
            return;
        }
        const source = path.join(
            sharedMemory,
            `redoor-trash-cross-device-${process.pid}`,
        );
        await fs.writeFile(source, "must remain");
        onTestFinished(async () => {
            await fs.rm(source, { force: true });
        });

        const operation = testAgent.deleteFile(source, { trash: true });

        // A different device must fail rather than silently degrading to copy/delete.
        await expect(operation).rejects.toMatchObject({ status: 400 });
        // Source preservation proves the failed operation did not perform destructive cleanup.
        await expect(fs.readFile(source, "utf8")).resolves.toBe("must remain");
    });
});
