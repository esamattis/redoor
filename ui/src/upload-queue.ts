import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { newWriteKeys, type UnlockedVault } from "#ui/vault/vault-keys";

import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { Agent } from "#ui/api-client";
import { joinBrowserPath } from "#ui/components/browser/utils";
import { ExternalStore } from "#ui/utils/external-store";
import { getErrorMessage } from "#ui/utils/error";

/** Bounds memory held by queued `File` handles, since they keep their sources reachable. */
export const MAX_QUEUED_UPLOADS = 100;

/** Keeps uploads from filling the connection, so control requests stay responsive. */
export const MAX_CONCURRENT_UPLOADS = 5;

/** One file to upload and where it goes below the destination directory. */
export type UploadSourceFile = {
    file: File;
    relativePath: string;
};

/** A complete selection, queued all at once or not at all. */
export type UploadBatch = {
    agentId: string;
    destinationPath: string;
    files: UploadSourceFile[];
    directories?: string[];
    /** The conflict policy the user chose for this batch, so uploads never replace silently. */
    onExisting: CopyExistingMode;
    /**
     * Encrypts every file with the vault; the relative paths already carry the
     * `.redoorvault` suffix, so conflicts are checked against the encrypted names.
     */
    encrypt?: boolean;
};

/** A queued file with its progress, kept after completion so the queue view can settle. */
export type UploadQueueItem = UploadSourceFile & {
    id: number;
    agentId: string;
    destinationPath: string;
    onExisting: CopyExistingMode;
    encrypt: boolean;
    status: "waiting" | "uploading" | "done";
    error: string | null;
};

/** An empty directory to create, which does not occupy an upload slot. */
type UploadDirectory = {
    id: number;
    agentId: string;
    destinationPath: string;
    relativePath: string;
    status: "waiting" | "creating" | "done";
};

/** What the UI reads: the rows of the current batch and their directories. */
export type UploadQueueSnapshot = {
    readonly items: readonly UploadQueueItem[];
    readonly directories: readonly UploadDirectory[];
};

/** Tells the caller how many files were accepted, or why the whole batch was refused. */
export type EnqueueResult =
    { ok: true; fileCount: number } | { ok: false; message: string };

/** What the queue needs from the application. */
export type UploadQueueOptions = {
    /** Mutations run through the query client so they show up like every other mutation. */
    queryClient: QueryClient;
    /** Looks up the request client of an agent when its upload starts, so status changes apply. */
    resolveAgent: (agentId: string) => Agent | undefined;
    /** Called once when the last pending upload finishes, to refresh listings it changed. */
    onSettled: () => void;
    /** The unlocked vault for encrypted uploads, asking the user to unlock when locked. */
    resolveVault: () => Promise<UnlockedVault>;
    /** Where the unload warning is attached; omitted where there is no window, as in tests. */
    unloadTarget?: EventTarget;
};

/** One request the queue sends to an agent. */
type UploadOperation =
    | { type: "directory"; agent: Agent; path: string }
    | {
          type: "file";
          agent: Agent;
          path: string;
          file: File;
          onExisting: CopyExistingMode;
          encrypt: boolean;
      };

/** Rejects paths that could address files outside the selected destination. */
export function normalizeRelativePath(path: string) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    const components = normalized.split("/");

    if (
        normalized.length === 0 ||
        normalized.startsWith("/") ||
        components.some(
            (component) =>
                component.length === 0 ||
                component === "." ||
                component === "..",
        )
    ) {
        throw new Error(`Invalid upload path: ${path || "(empty)"}`);
    }

    return normalized;
}

/** Returns a safe parent path for creating directories before a nested file upload. */
function getUploadParentPath(item: UploadQueueItem) {
    const separator = item.relativePath.lastIndexOf("/");

    return separator === -1
        ? item.destinationPath
        : joinBrowserPath(
              item.destinationPath,
              item.relativePath.slice(0, separator),
          );
}

/**
 * Owns the upload queue: its rows, its concurrency limit and the requests it sends. It lives
 * for the whole page, so uploads continue while the user navigates, and React only enqueues
 * into it and subscribes to its snapshot.
 *
 * Files stay `File` handles from the picker or the drop all the way to `Agent.upload`, which
 * streams them as the request body, so a large file is never read into memory here. At most
 * `MAX_CONCURRENT_UPLOADS` run at once, which leaves room on the agent's connection for
 * control requests while uploads are in flight.
 */
export class UploadQueue extends ExternalStore<UploadQueueSnapshot> {
    private nextId = 1;
    private readonly preparedDirectories = new Map<string, Promise<void>>();
    private readonly requests: MutationObserver<void, Error, UploadOperation>;
    private isGuardingUnload = false;

    /** Binds the request runner to the query client so uploads are visible as mutations. */
    constructor(private readonly options: UploadQueueOptions) {
        super({ items: [], directories: [] });

        this.requests = new MutationObserver(options.queryClient, {
            mutationFn: async (operation: UploadOperation) => {
                if (operation.type === "directory") {
                    await operation.agent.createDirectory(operation.path);

                    return;
                }

                if (operation.encrypt) {
                    // The keys are asked for per file instead of kept in the queue, so
                    // locking the vault also takes them from uploads that already ran.
                    const vault = await options.resolveVault();

                    // A fresh file key for every file, wrapped with the current generation.
                    await operation.agent.vaultUpload(operation.path, {
                        content: operation.file,
                        keys: await newWriteKeys(vault),
                        on_existing: operation.onExisting,
                    });

                    return;
                }

                await operation.agent.upload(operation.path, operation.file, {
                    on_existing: operation.onExisting,
                });
            },
        });
    }

    /** Adds one complete source manifest so oversized selections never enter partially. */
    enqueue(batch: UploadBatch): EnqueueResult {
        if (
            batch.files.length === 0 &&
            (batch.directories?.length ?? 0) === 0
        ) {
            return { ok: false, message: "No files were selected." };
        }

        const current = this.getSnapshot();
        const hasPending = this.hasPendingWork();
        const retainedItems = hasPending ? current.items : [];
        const retainedDirectories = hasPending ? current.directories : [];

        if (retainedItems.length + batch.files.length > MAX_QUEUED_UPLOADS) {
            return {
                ok: false,
                message: `Upload queues are limited to ${MAX_QUEUED_UPLOADS} files.`,
            };
        }

        try {
            const items = batch.files.map((source) => ({
                ...source,
                relativePath: normalizeRelativePath(source.relativePath),
                id: this.takeId(),
                agentId: batch.agentId,
                destinationPath: batch.destinationPath,
                onExisting: batch.onExisting,
                encrypt: batch.encrypt ?? false,
                status: "waiting" as const,
                error: null,
            }));

            const uniqueDirectories = new Set(
                (batch.directories ?? []).map(normalizeRelativePath),
            );

            const directories = Array.from(
                uniqueDirectories,
                (relativePath) => ({
                    id: this.takeId(),
                    agentId: batch.agentId,
                    destinationPath: batch.destinationPath,
                    relativePath,
                    status: "waiting" as const,
                }),
            );

            this.update({
                items: [...retainedItems, ...items],
                directories: [...retainedDirectories, ...directories],
            });

            this.pump();

            return { ok: true, fileCount: items.length };
        } catch (error) {
            return {
                ok: false,
                message: getErrorMessage(
                    error,
                    "The upload paths are invalid.",
                ),
            };
        }
    }

    /** Hands out ids that stay unique across batches, so rows keep a stable React key. */
    private takeId(): number {
        const id = this.nextId;
        this.nextId += 1;

        return id;
    }

    /** True while anything of the current batch is waiting or running. */
    private hasPendingWork(): boolean {
        const snapshot = this.getSnapshot();

        return (
            snapshot.items.some((item) => item.status !== "done") ||
            snapshot.directories.some(
                (directory) => directory.status !== "done",
            )
        );
    }

    /** Publishes a snapshot, then keeps the unload warning in step with whether work is pending. */
    private update(next: UploadQueueSnapshot): void {
        this.publish(next);
        this.syncUnloadGuard();
    }

    /** Warns before the page unloads, because active `File` handles would be lost with it. */
    private readonly warnBeforeUnload = (event: Event) => {
        event.preventDefault();
    };

    /** Attaches the warning while work is pending and removes it afterwards. */
    private syncUnloadGuard(): void {
        const target = this.options.unloadTarget;
        const shouldGuard = this.hasPendingWork();

        if (target === undefined || shouldGuard === this.isGuardingUnload) {
            return;
        }

        this.isGuardingUnload = shouldGuard;

        if (shouldGuard) {
            target.addEventListener("beforeunload", this.warnBeforeUnload);
        } else {
            target.removeEventListener("beforeunload", this.warnBeforeUnload);
        }
    }

    /**
     * Starts everything that may run now: all waiting directories, and as many waiting files
     * as there are free slots. Claiming happens in the same synchronous step as starting, so
     * two quick calls can never start the same row twice.
     */
    private pump(): void {
        const snapshot = this.getSnapshot();

        const freeSlots = Math.max(
            0,
            MAX_CONCURRENT_UPLOADS -
                snapshot.items.filter((item) => item.status === "uploading")
                    .length,
        );

        const claimedItems = snapshot.items
            .filter((item) => item.status === "waiting")
            .slice(0, freeSlots);

        const claimedDirectories = snapshot.directories.filter(
            (directory) => directory.status === "waiting",
        );

        if (claimedItems.length === 0 && claimedDirectories.length === 0) {
            return;
        }

        const claimedItemIds = new Set(claimedItems.map((item) => item.id));

        const claimedDirectoryIds = new Set(
            claimedDirectories.map((directory) => directory.id),
        );

        this.update({
            items: snapshot.items.map((item) =>
                claimedItemIds.has(item.id)
                    ? { ...item, status: "uploading" as const }
                    : item,
            ),
            directories: snapshot.directories.map((directory) =>
                claimedDirectoryIds.has(directory.id)
                    ? { ...directory, status: "creating" as const }
                    : directory,
            ),
        });

        for (const directory of claimedDirectories) {
            this.runDirectory(directory);
        }

        for (const item of claimedItems) {
            this.runItem(item);
        }
    }

    /** Creates one requested empty directory; failures surface through file uploads instead. */
    private runDirectory(directory: UploadDirectory): void {
        const agent = this.options.resolveAgent(directory.agentId);

        const path = joinBrowserPath(
            directory.destinationPath,
            directory.relativePath,
        );

        const operation = agent
            ? this.prepareDirectory(agent, path)
            : Promise.reject(new Error("Upload agent is unavailable."));

        void operation
            .catch(() => undefined)
            .finally(() => this.finishDirectory(directory.id));
    }

    /** Ensures the parent exists, uploads the file and records the outcome on its row. */
    private runItem(item: UploadQueueItem): void {
        const agent = this.options.resolveAgent(item.agentId);

        const operation = agent
            ? this.prepareDirectory(agent, getUploadParentPath(item)).then(() =>
                  this.requests.mutate({
                      type: "file",
                      agent,
                      path: joinBrowserPath(
                          item.destinationPath,
                          item.relativePath,
                      ),
                      file: item.file,
                      onExisting: item.onExisting,
                      encrypt: item.encrypt,
                  }),
              )
            : Promise.reject(new Error("Upload agent is unavailable."));

        void operation
            .then(() => this.finishItem(item.id, null))
            .catch((cause: unknown) =>
                this.finishItem(
                    item.id,
                    getErrorMessage(cause, "Upload failed"),
                ),
            );
    }

    /** Shares one directory request between every file that needs the same parent. */
    private prepareDirectory(agent: Agent, path: string): Promise<void> {
        const key = `${agent.id}\0${path}`;
        const existing = this.preparedDirectories.get(key);

        if (existing) {
            return existing;
        }

        const request = this.requests.mutate({
            type: "directory",
            agent,
            path,
        });

        this.preparedDirectories.set(key, request);

        return request;
    }

    /** Records one terminal result while retaining the row for the queue view. */
    private finishItem(id: number, error: string | null): void {
        const snapshot = this.getSnapshot();

        this.update({
            ...snapshot,
            items: snapshot.items.map((item) =>
                item.id === id
                    ? { ...item, status: "done" as const, error }
                    : item,
            ),
        });

        this.afterWorkFinished();
    }

    /** Marks directory preparation complete even when its error is surfaced by a file upload. */
    private finishDirectory(id: number): void {
        const snapshot = this.getSnapshot();

        this.update({
            ...snapshot,
            directories: snapshot.directories.map((directory) =>
                directory.id === id
                    ? { ...directory, status: "done" as const }
                    : directory,
            ),
        });

        this.afterWorkFinished();
    }

    /** Frees slots for waiting files, and once everything is done refreshes what it changed. */
    private afterWorkFinished(): void {
        this.pump();

        if (!this.hasPendingWork()) {
            // A later batch must not reuse a directory result that may be stale by then.
            this.preparedDirectories.clear();
            this.options.onSettled();
        }
    }
}
