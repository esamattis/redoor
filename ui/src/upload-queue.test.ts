import { QueryClient } from "@tanstack/react-query";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { RawUploadResponse } from "#bindings/RawUploadResponse";
import { ApiClient, type Agent } from "#ui/api-client";
import {
    MAX_CONCURRENT_UPLOADS,
    MAX_QUEUED_UPLOADS,
    UploadQueue,
} from "#ui/upload-queue";

/** A promise the test settles by hand, to hold uploads in flight while it inspects the queue. */
type Deferred = {
    promise: Promise<RawUploadResponse>;
    resolve: () => void;
    reject: (error: Error) => void;
};

/** Creates a controllable upload result. */
function deferred(): Deferred {
    const handlers: Pick<Deferred, "resolve" | "reject"> = {
        resolve: () => {},
        reject: () => {},
    };

    const promise = new Promise<RawUploadResponse>((resolve, reject) => {
        handlers.resolve = () =>
            resolve({ path: "/home/agent/file", bytes_written: 0 });
        handlers.reject = reject;
    });

    return { promise, ...handlers };
}

/** Describes a connected agent, the only kind that can receive uploads. */
const agentInfo: AgentInfoResponse = {
    id: "agent-1",
    name: "Agent One",
    cwd: "/home/agent",
    managed: false,
    configuration_editable: false,
    ssh_target: null,
    status: "connected",
    connected_at: 1,
    connection_id: "socket-1",
    last_seen_at: 1,
    connection_issue: null,
    provisioning_status: [],
    binary: null,
    supports_native_open: false,
    supports_move_to_trash: false,
    supports_trash: false,
    supports_upload_preconditions: false,
    uid: null,
    is_root: false,
    duplicate_id: null,
};

/** Builds a queue whose agent's requests are controlled by the test, never sent anywhere. */
function createQueue() {
    const queryClient = new QueryClient();

    const agent: Agent = new ApiClient("http://localhost:1").agentFor(
        agentInfo,
    );

    const uploads: Deferred[] = [];
    const createdDirectories: string[] = [];

    const uploadSpy = vi.spyOn(agent, "upload").mockImplementation(() => {
        const pending = deferred();
        uploads.push(pending);

        return pending.promise;
    });

    vi.spyOn(agent, "createDirectory").mockImplementation(async (path) => {
        createdDirectories.push(path);

        return { path };
    });

    const onSettled = vi.fn();
    const unloadTarget = new EventTarget();

    const queue = new UploadQueue({
        queryClient,
        resolveAgent: (agentId) => (agentId === agent.id ? agent : undefined),
        resolveVault: () =>
            Promise.reject(new Error("No vault in these tests")),
        onSettled,
        unloadTarget,
    });

    onTestFinished(() => {
        vi.restoreAllMocks();
        queryClient.clear();
    });

    return {
        queue,
        uploads,
        uploadSpy,
        createdDirectories,
        onSettled,
        unloadTarget,
    };
}

/** Makes a small in-memory source file for a relative path. */
function source(relativePath: string) {
    return { file: new File(["x"], "f.txt"), relativePath };
}

/** Counts rows by status so assertions read as queue states. */
function countByStatus(queue: UploadQueue, status: string) {
    return queue.getSnapshot().items.filter((item) => item.status === status)
        .length;
}

describe("UploadQueue concurrency", () => {
    test("starts at most the concurrency limit and fills freed slots", async () => {
        const { queue, uploads } = createQueue();

        const result = queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: Array.from({ length: 8 }, (_, index) =>
                source(`file-${index}.txt`),
            ),
        });

        expect(result).toEqual({ ok: true, fileCount: 8 });

        await vi.waitFor(() =>
            expect(uploads).toHaveLength(MAX_CONCURRENT_UPLOADS),
        );

        // Running more uploads at once would crowd out control requests on the connection.
        expect(countByStatus(queue, "uploading")).toBe(MAX_CONCURRENT_UPLOADS);
        // The rest wait for a slot rather than starting.
        expect(countByStatus(queue, "waiting")).toBe(3);

        uploads[0]?.resolve();

        await vi.waitFor(() => expect(uploads).toHaveLength(6));

        // A finished upload frees exactly one slot for the next waiting file.
        expect(countByStatus(queue, "uploading")).toBe(MAX_CONCURRENT_UPLOADS);
        expect(countByStatus(queue, "done")).toBe(1);
    });

    test("creates a shared parent directory once and settles after the last upload", async () => {
        const { queue, uploads, createdDirectories, onSettled } = createQueue();

        queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: [source("photos/a.jpg"), source("photos/b.jpg")],
        });

        await vi.waitFor(() => expect(uploads).toHaveLength(2));

        // Both files need the same parent, so asking the agent twice would be wasted work.
        expect(createdDirectories).toEqual(["/home/agent/photos"]);

        uploads[0]?.resolve();
        await vi.waitFor(() => expect(countByStatus(queue, "done")).toBe(1));
        // Listings must not refresh while another upload is still running.
        expect(onSettled).not.toHaveBeenCalled();

        uploads[1]?.reject(new Error("disk full"));
        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

        const failed = queue
            .getSnapshot()
            .items.find((item) => item.relativePath === "photos/b.jpg");

        // The failure stays on its own row so the user can see which file did not arrive.
        expect(failed?.error).toBe("disk full");
    });

    test("sends the batch's conflict policy with every file", async () => {
        const { queue, uploads, uploadSpy } = createQueue();

        queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "merge",
            files: [source("photos/a.jpg"), source("b.jpg")],
        });

        await vi.waitFor(() => expect(uploads).toHaveLength(2));

        // Every request must carry the user's choice, since the server no longer replaces by default.
        expect(uploadSpy.mock.calls.map((call) => call[2])).toEqual([
            { on_existing: "merge" },
            { on_existing: "merge" },
        ]);
    });

    test("fails files whose agent is no longer known", async () => {
        const { queue, onSettled } = createQueue();

        queue.enqueue({
            agentId: "gone",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: [source("a.txt")],
        });

        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

        // An upload with no agent to send it to must end visibly instead of waiting forever.
        expect(queue.getSnapshot().items[0]?.error).toBe(
            "Upload agent is unavailable.",
        );
    });
});

describe("UploadQueue validation and lifetime", () => {
    test("refuses a batch that would exceed the queue limit without queueing part of it", () => {
        const { queue } = createQueue();

        const result = queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: Array.from({ length: MAX_QUEUED_UPLOADS + 1 }, (_, index) =>
                source(`file-${index}.txt`),
            ),
        });

        // Oversized selections are refused whole, so a drop never half-uploads.
        expect(result.ok).toBe(false);
        expect(queue.getSnapshot().items).toHaveLength(0);
    });

    test("rejects paths that escape the destination", () => {
        const { queue } = createQueue();

        const result = queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: [source("../outside.txt")],
        });

        // A relative path with `..` could write outside the chosen directory.
        expect(result).toEqual({
            ok: false,
            message: "Invalid upload path: ../outside.txt",
        });
    });

    test("warns before the page unloads only while uploads are pending", async () => {
        const { queue, uploads, unloadTarget } = createQueue();

        queue.enqueue({
            agentId: "agent-1",
            destinationPath: "/home/agent",
            onExisting: "error",
            files: [source("a.txt")],
        });

        await vi.waitFor(() => expect(uploads).toHaveLength(1));

        const whilePending = new Event("beforeunload", { cancelable: true });
        unloadTarget.dispatchEvent(whilePending);
        // Leaving now would lose the File handles of running uploads, so the user is warned.
        expect(whilePending.defaultPrevented).toBe(true);

        uploads[0]?.resolve();
        await vi.waitFor(() => expect(countByStatus(queue, "done")).toBe(1));

        const afterSettled = new Event("beforeunload", { cancelable: true });
        unloadTarget.dispatchEvent(afterSettled);
        // With nothing pending there is nothing to lose, so leaving must not be blocked.
        expect(afterSettled.defaultPrevented).toBe(false);
    });
});
