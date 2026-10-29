import type { Agent } from "#ui/api-client";
import type { GitWorktreeChanges } from "#bindings/GitWorktreeChanges";

/**
 * How long rows may keep asking before their paths go out together. The rows that scroll
 * into view at once ask from separate effects, so a short wait lets them share a request.
 */
const BATCH_DELAY_MS = 10;

/** What the batcher needs from an agent client, so tests can count the requests it sends. */
type WorktreeStatusSource = Pick<Agent, "id" | "gitWorktreeStatus">;

/** One row's pending query, settled when its path is counted or its query is cancelled. */
type Waiter = {
    resolve: (changes: GitWorktreeChanges) => void;
    reject: (reason: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
};

/**
 * Gathers the change counts that the rows of a worktree list ask for into one request per
 * agent at a time. A request per row used to fill the browser's few connections to the
 * server, so every other view waited behind the status walks.
 *
 * The agent answers each request after a few seconds with the checkouts it managed to count,
 * so the paths it did not reach go out again, first, in the next request together with the
 * rows that asked meanwhile.
 */
export class WorktreeStatusBatcher {
    /** One batcher per agent, so every list showing that agent shares its single request. */
    static #byAgent = new Map<string, WorktreeStatusBatcher>();

    /** The newest client for the agent, so a request carries the current credentials. */
    #agent: WorktreeStatusSource;
    /** Rows waiting for the next request. */
    #queued = new PathWaiters();
    /** The rows the request in flight answers, and how to abandon it once none still wait. */
    #inFlight: { waiters: PathWaiters; controller: AbortController } | null =
        null;
    /** Whether a request is already scheduled for the queued rows. */
    #scheduled = false;

    constructor(agent: WorktreeStatusSource) {
        this.#agent = agent;
    }

    /** Returns the agent's shared batcher, remembering the newest client for its requests. */
    static forAgent(agent: WorktreeStatusSource): WorktreeStatusBatcher {
        const existing = WorktreeStatusBatcher.#byAgent.get(agent.id);

        if (existing) {
            existing.#agent = agent;

            return existing;
        }

        const batcher = new WorktreeStatusBatcher(agent);
        WorktreeStatusBatcher.#byAgent.set(agent.id, batcher);

        return batcher;
    }

    /**
     * Resolves with the counts of the checkout containing `path`. Aborting `signal` drops the
     * row from its request, and abandons the request once no row waits for it, so leaving
     * the list frees the connection and the agent's walks at once.
     */
    load(path: string, signal: AbortSignal): Promise<GitWorktreeChanges> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);

                return;
            }

            const waiter: Waiter = {
                resolve,
                reject,
                signal,
                onAbort: () => this.#abandon(path, waiter),
            };

            signal.addEventListener("abort", waiter.onAbort, { once: true });
            this.#queued.add(path, waiter);
            this.#schedule();
        });
    }

    /** Sends the queued rows soon, unless a request is in flight; its end sends them. */
    #schedule() {
        if (this.#scheduled || this.#inFlight !== null) {
            return;
        }

        this.#scheduled = true;
        setTimeout(() => {
            this.#scheduled = false;
            void this.#send();
        }, BATCH_DELAY_MS);
    }

    /** Asks for every queued path in one request and settles the rows it answers. */
    async #send() {
        if (this.#inFlight !== null || this.#queued.isEmpty) {
            return;
        }

        const waiters = this.#queued;
        this.#queued = new PathWaiters();
        const controller = new AbortController();
        this.#inFlight = { waiters, controller };

        try {
            const response = await this.#agent.gitWorktreeStatus(
                waiters.paths,
                { signal: controller.signal },
            );

            for (const entry of response.statuses) {
                const result = entry.result;

                for (const waiter of waiters.take(entry.path)) {
                    if (result.type === "counted") {
                        waiter.resolve({
                            changed: result.changed,
                            untracked: result.untracked,
                            truncated: result.truncated,
                        });
                    } else {
                        waiter.reject(new Error(result.message));
                    }
                }
            }

            if (response.statuses.length === 0) {
                // The agent always counts at least one checkout, so asking again for the
                // same paths would only repeat an empty answer forever.
                waiters.rejectAll(
                    new Error("The agent counted no worktree changes"),
                );
            }

            // The paths the agent did not reach go first, since they have waited longest.
            waiters.append(this.#queued);
            this.#queued = waiters;
        } catch (error) {
            waiters.rejectAll(
                error instanceof Error
                    ? error
                    : new Error("Failed to count worktree changes"),
            );
        } finally {
            this.#inFlight = null;
            this.#schedule();
        }
    }

    /** Drops a cancelled row, and its request too once no other row waits for it. */
    #abandon(path: string, waiter: Waiter) {
        waiter.reject(waiter.signal.reason);
        this.#queued.remove(path, waiter);

        const inFlight = this.#inFlight;

        if (inFlight === null) {
            return;
        }

        inFlight.waiters.remove(path, waiter);

        if (inFlight.waiters.isEmpty) {
            inFlight.controller.abort();
        }
    }
}

/** The rows waiting for each path, in the order the paths were first asked for. */
class PathWaiters {
    #byPath = new Map<string, Waiter[]>();

    /** The paths to ask for, oldest first. */
    get paths(): string[] {
        return [...this.#byPath.keys()];
    }

    /** True when no row waits, so there is nothing to ask for. */
    get isEmpty(): boolean {
        return this.#byPath.size === 0;
    }

    /** Queues a row behind the other rows of the same path. */
    add(path: string, waiter: Waiter) {
        const pending = this.#byPath.get(path);

        if (pending) {
            pending.push(waiter);
        } else {
            this.#byPath.set(path, [waiter]);
        }
    }

    /** Queues every row of `other` behind these, keeping the order they asked in. */
    append(other: PathWaiters) {
        for (const [path, pending] of other.#byPath) {
            for (const waiter of pending) {
                this.add(path, waiter);
            }
        }
    }

    /** Forgets a row, and its path once no row waits for it, so the path is not asked for. */
    remove(path: string, waiter: Waiter) {
        const pending = this.#byPath.get(path);

        if (!pending) {
            return;
        }

        const remaining = pending.filter((candidate) => candidate !== waiter);

        if (remaining.length === 0) {
            this.#byPath.delete(path);
        } else {
            this.#byPath.set(path, remaining);
        }
    }

    /** Removes and returns the rows of an answered path, which no longer listen for aborts. */
    take(path: string): Waiter[] {
        const pending = this.#byPath.get(path) ?? [];
        this.#byPath.delete(path);

        for (const waiter of pending) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }

        return pending;
    }

    /** Fails every row, for a request that failed as a whole. */
    rejectAll(reason: Error) {
        for (const path of this.paths) {
            for (const waiter of this.take(path)) {
                waiter.reject(reason);
            }
        }
    }
}
