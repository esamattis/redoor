import React from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import type { Agent } from "#ui/api-client";
import { getErrorMessage, joinBrowserPath } from "#ui/components/browser/utils";

export const MAX_QUEUED_UPLOADS = 100;
export const MAX_CONCURRENT_UPLOADS = 5;

export type UploadSourceFile = {
    file: File;
    relativePath: string;
};

export type UploadBatch = {
    agentId: string;
    destinationPath: string;
    files: UploadSourceFile[];
    directories?: string[];
};

export type UploadQueueItem = UploadSourceFile & {
    id: number;
    agentId: string;
    destinationPath: string;
    status: "waiting" | "uploading" | "done";
    error: string | null;
};

type UploadDirectory = {
    id: number;
    agentId: string;
    destinationPath: string;
    relativePath: string;
    status: "waiting" | "creating" | "done";
};

type UploadQueue = {
    items: UploadQueueItem[];
    directories: UploadDirectory[];
};

type EnqueueResult =
    { ok: true; fileCount: number } | { ok: false; message: string };

let nextUploadId = 1;

export const uploadQueueAtom = atom<UploadQueue>({
    items: [],
    directories: [],
});

/** Rejects paths that could address files outside the selected destination. */
function normalizeRelativePath(path: string) {
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

/** Adds one complete source manifest so oversized selections never enter partially. */
export const enqueueUploadBatchAtom = atom(
    null,
    (get, set, batch: UploadBatch): EnqueueResult => {
        if (
            batch.files.length === 0 &&
            (batch.directories?.length ?? 0) === 0
        ) {
            return { ok: false, message: "No files were selected." };
        }

        const queue = get(uploadQueueAtom);
        const hasPendingUploads = queue.items.some(
            (item) => item.status !== "done",
        );
        const retainedItems = hasPendingUploads ? queue.items : [];
        const retainedDirectories = hasPendingUploads ? queue.directories : [];
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
                id: nextUploadId++,
                agentId: batch.agentId,
                destinationPath: batch.destinationPath,
                status: "waiting" as const,
                error: null,
            }));
            const uniqueDirectories = new Set(
                (batch.directories ?? []).map(normalizeRelativePath),
            );
            const directories = Array.from(
                uniqueDirectories,
                (relativePath) => ({
                    id: nextUploadId++,
                    agentId: batch.agentId,
                    destinationPath: batch.destinationPath,
                    relativePath,
                    status: "waiting" as const,
                }),
            );

            set(uploadQueueAtom, {
                items: [...retainedItems, ...items],
                directories: [...retainedDirectories, ...directories],
            });
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
    },
);

/** Atomically reserves available upload slots before asynchronous work starts. */
const claimWaitingUploadsAtom = atom(null, (get, set) => {
    const queue = get(uploadQueueAtom);
    const activeCount = queue.items.filter(
        (item) => item.status === "uploading",
    ).length;
    const claimedIds = new Set(
        queue.items
            .filter((item) => item.status === "waiting")
            .slice(0, Math.max(0, MAX_CONCURRENT_UPLOADS - activeCount))
            .map((item) => item.id),
    );
    if (claimedIds.size === 0) {
        return [];
    }

    const claimedItems = queue.items.filter((item) => claimedIds.has(item.id));
    set(uploadQueueAtom, {
        ...queue,
        items: queue.items.map((item) =>
            claimedIds.has(item.id)
                ? { ...item, status: "uploading" as const }
                : item,
        ),
    });
    return claimedItems;
});

/** Reserves empty-directory work separately because it does not consume upload slots. */
const claimWaitingDirectoriesAtom = atom(null, (get, set) => {
    const queue = get(uploadQueueAtom);
    const claimed = queue.directories.filter(
        (directory) => directory.status === "waiting",
    );
    if (claimed.length === 0) {
        return [];
    }
    const claimedIds = new Set(claimed.map((directory) => directory.id));
    set(uploadQueueAtom, {
        ...queue,
        directories: queue.directories.map((directory) =>
            claimedIds.has(directory.id)
                ? { ...directory, status: "creating" as const }
                : directory,
        ),
    });
    return claimed;
});

/** Records one terminal result while retaining rows for the queue view. */
const finishUploadAtom = atom(
    null,
    (get, set, result: { id: number; error: string | null }) => {
        const queue = get(uploadQueueAtom);
        set(uploadQueueAtom, {
            ...queue,
            items: queue.items.map((item) =>
                item.id === result.id
                    ? {
                          ...item,
                          status: "done" as const,
                          error: result.error,
                      }
                    : item,
            ),
        });
    },
);

/** Marks directory preparation complete even when its error is surfaced by a file upload. */
const finishDirectoryAtom = atom(null, (get, set, id: number) => {
    const queue = get(uploadQueueAtom);
    set(uploadQueueAtom, {
        ...queue,
        directories: queue.directories.map((directory) =>
            directory.id === id
                ? { ...directory, status: "done" as const }
                : directory,
        ),
    });
});

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

/** Runs the page-lifetime scheduler and keeps full document unloads from losing active files. */
export function UploadQueueManager(props: {
    agents: Agent[];
    onUploadsChanged: () => Promise<void>;
}) {
    const queue = useAtomValue(uploadQueueAtom);
    const claimWaitingUploads = useSetAtom(claimWaitingUploadsAtom);
    const claimWaitingDirectories = useSetAtom(claimWaitingDirectoriesAtom);
    const finishUpload = useSetAtom(finishUploadAtom);
    const finishDirectory = useSetAtom(finishDirectoryAtom);
    const agentsRef = React.useRef(props.agents);
    const preparedDirectories = React.useRef(new Map<string, Promise<void>>());
    const hadActiveUploads = React.useRef(false);

    agentsRef.current = props.agents;

    React.useEffect(() => {
        const prepareDirectory = (agent: Agent, path: string) => {
            const key = `${agent.id}\0${path}`;
            const existing = preparedDirectories.current.get(key);
            if (existing) {
                return existing;
            }
            const request = agent.createDirectory(path).then(() => undefined);
            preparedDirectories.current.set(key, request);
            return request;
        };
        const claimedDirectories = claimWaitingDirectories();
        claimedDirectories.forEach((directory) => {
            const agent = agentsRef.current.find(
                (candidate) => candidate.id === directory.agentId,
            );
            const path = joinBrowserPath(
                directory.destinationPath,
                directory.relativePath,
            );
            const operation = agent
                ? prepareDirectory(agent, path)
                : Promise.reject(new Error("Upload agent is unavailable."));
            void operation
                .catch(() => undefined)
                .finally(() => finishDirectory(directory.id));
        });

        const claimedItems = claimWaitingUploads();
        claimedItems.forEach((item) => {
            const agent = agentsRef.current.find(
                (candidate) => candidate.id === item.agentId,
            );
            const operation = agent
                ? prepareDirectory(agent, getUploadParentPath(item)).then(() =>
                      agent.upload(
                          joinBrowserPath(
                              item.destinationPath,
                              item.relativePath,
                          ),
                          item.file,
                      ),
                  )
                : Promise.reject(new Error("Upload agent is unavailable."));

            void operation
                .then(() => finishUpload({ id: item.id, error: null }))
                .catch((error: unknown) =>
                    finishUpload({
                        id: item.id,
                        error: getErrorMessage(error, "Upload failed"),
                    }),
                );
        });
    }, [
        claimWaitingDirectories,
        claimWaitingUploads,
        finishDirectory,
        finishUpload,
        queue,
    ]);

    React.useEffect(() => {
        const hasActiveUploads = queue.items.some(
            (item) => item.status !== "done",
        );
        if (hadActiveUploads.current && !hasActiveUploads) {
            void props.onUploadsChanged();
        }
        hadActiveUploads.current = hasActiveUploads;
    }, [props, queue.items]);

    React.useEffect(() => {
        if (!queue.items.some((item) => item.status !== "done")) {
            return;
        }
        /** Lets the browser present its standard warning when active File objects would be lost. */
        const preventUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", preventUnload);
        return () => window.removeEventListener("beforeunload", preventUnload);
    }, [queue.items]);

    return null;
}
