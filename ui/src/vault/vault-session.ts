/**
 * The browser's vault lock state: which vault keys this tab holds, shared between tabs and
 * optionally kept across reloads.
 *
 * Keys are non-extractable `CryptoKey`s. Tabs share them over a `BroadcastChannel`
 * (`CryptoKey` can be cloned between tabs), so unlocking once unlocks every tab, and locking
 * or rotating in one tab locks all of them. The user picks how long the vault stays unlocked
 * without use (`VaultLockAfter`). Every choice but the shortest also keeps the keys in
 * IndexedDB, still non-extractable, so script cannot export them. The idle lock of kept keys
 * is only enforced by this code: with no tab open nothing runs, so expired keys stay on disk
 * until the next page load deletes them, and anyone who can use or copy this browser profile
 * can open the vault until then.
 *
 * Code that needs the vault calls `requestUnlock`, which resolves at once while unlocked and
 * otherwise asks the vault dialog (rendered once in the app shell) to create or unlock the
 * vault.
 */
import { z } from "zod";
import { ExternalStore } from "#ui/utils/external-store";
import { callerStack, vaultDebug } from "#ui/vault/vault-debug";
import type { UnlockedVault } from "#ui/vault/vault-keys";

/**
 * How long an unlocked vault stays unlocked, picked in the vault dialog. `idleMs` is the idle
 * lock (null: none). `keptOnDevice` keeps the keys in IndexedDB across reloads and browser
 * restarts: a lock of an hour or more is pointless if closing the tab ends it, while the
 * shortest choice is for users who do not want the key on disk at all. A fixed list, so every
 * tab and kept record agrees on the choices, and the longest idle lock stays below the ~24.8
 * days that `setTimeout` can wait.
 */
export const VAULT_LOCK_AFTER = {
    "15_minutes": { idleMs: 15 * 60 * 1000, keptOnDevice: false },
    "1_hour": { idleMs: 60 * 60 * 1000, keptOnDevice: true },
    "24_hours": { idleMs: 24 * 60 * 60 * 1000, keptOnDevice: true },
    "1_week": { idleMs: 7 * 24 * 60 * 60 * 1000, keptOnDevice: true },
    never: { idleMs: null, keptOnDevice: true },
} as const satisfies Record<
    string,
    { idleMs: number | null; keptOnDevice: boolean }
>;

/** A choice of `VAULT_LOCK_AFTER`. */
export type VaultLockAfter = keyof typeof VAULT_LOCK_AFTER;

/** The shortest choice, so an unlock without a deliberate pick locks soon and stays off disk. */
export const DEFAULT_VAULT_LOCK_AFTER: VaultLockAfter = "15_minutes";

/** Parses lock choices that arrive from other tabs and IndexedDB. */
const lockAfterSchema = z.enum([
    "15_minutes",
    "1_hour",
    "24_hours",
    "1_week",
    "never",
]) satisfies z.ZodType<VaultLockAfter>;

/**
 * How often a kept vault's last use is written to IndexedDB at most. Every encrypted file
 * read touches the vault, and a minute of slack on a lock measured in quarter hours or more
 * is not worth a database write per read.
 */
const KEPT_LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

const CHANNEL_NAME = "redoor-vault";

const DATABASE_NAME = "redoor-vault";

const STORE_NAME = "keys";

const RECORD_KEY = "vault";

/** What the UI shows about the lock. */
export type VaultLockState = {
    status: "locked" | "unlocked";
    /** The unlocked current generation, so the UI can notice a rotation elsewhere. */
    currentKeyId: string | null;
    /** Unlocked and kept in IndexedDB, so it survives reloads and browser restarts. */
    persisted: boolean;
    /** How long the vault stays unlocked without use. */
    lockAfter: VaultLockAfter;
    /** Why the vault dialog is open, or null when no flow waits for an unlock. */
    pendingReason: string | null;
};

/** The keys as they cross tabs and IndexedDB; parsed because both are outside input. */
const storedVaultSchema = z.object({
    vaultId: z.string(),
    currentKeyId: z.string(),
    keys: z.array(z.tuple([z.string(), z.instanceof(CryptoKey)])),
});

type StoredVault = z.infer<typeof storedVaultSchema>;

/**
 * The IndexedDB record: the keys plus the idle lock, so a browser that was closed past the
 * lock finds the vault locked when it comes back.
 */
const keptVaultSchema = storedVaultSchema.extend({
    // TEMPORARY MIGRATION: records kept before the lock choice existed have neither field and
    // meant "no idle lock", so they default to that. Can go once every kept vault has been
    // unlocked again with a lock choice, e.g. a few releases after the one that added it.
    lockAfter: lockAfterSchema.default("never"),
    lastUsedAt: z.number().default(0),
});

type KeptVault = z.infer<typeof keptVaultSchema>;

/** Messages between tabs. */
const channelMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("unlocked"),
        vault: storedVaultSchema,
        lockAfter: lockAfterSchema,
        // The sender's last use, so a tab that joins late gets only the remaining idle time.
        lastUsedAt: z.number(),
    }),
    z.object({ type: z.literal("locked") }),
    z.object({ type: z.literal("ask") }),
    z.object({ type: z.literal("touched") }),
]);

type ChannelMessage = z.infer<typeof channelMessageSchema>;

/** How a set of adopted keys locks, and where they came from. */
type AdoptOptions = {
    lockAfter: VaultLockAfter;
    /** Only feeds the debug log, to tell this tab's unlock from another tab's or IndexedDB's. */
    source: string;
    /** When the idle lock counts from: now, except for kept keys restored on load. */
    lastUsedAt?: number;
};

/** A flow waiting for the vault. */
type PendingUnlock = {
    resolve: (vault: UnlockedVault) => void;
    reject: (error: Error) => void;
};

/** Thrown to flows waiting for an unlock the user cancelled. */
export class VaultUnlockCancelled extends Error {
    constructor() {
        super("The vault was not unlocked");
        this.name = "VaultUnlockCancelled";
    }
}

/** Converts keys to their cloneable form. */
function toStored(vault: UnlockedVault): StoredVault {
    return {
        vaultId: vault.vaultId,
        currentKeyId: vault.currentKeyId,
        keys: [...vault.keys.entries()],
    };
}

/** Converts cloned keys back. */
function fromStored(stored: StoredVault): UnlockedVault {
    return {
        vaultId: stored.vaultId,
        currentKeyId: stored.currentKeyId,
        keys: new Map(stored.keys),
    };
}

/** Opens the IndexedDB database that holds kept keys. */
function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, 1);

        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
    });
}

/** Runs one IndexedDB request in its own transaction. */
async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    const database = await openDatabase();

    try {
        return await new Promise<T>((resolve, reject) => {
            const request = run(
                database.transaction(STORE_NAME, mode).objectStore(STORE_NAME),
            );

            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error ?? new Error("IndexedDB"));
        });
    } finally {
        database.close();
    }
}

/** Owns the lock state of this tab. */
export class VaultSession extends ExternalStore<VaultLockState> {
    private vault: UnlockedVault | null = null;
    private lockAfter: VaultLockAfter = DEFAULT_VAULT_LOCK_AFTER;
    private idleTimer: number | null = null;
    /** When this tab last wrote the kept vault's last use, to throttle those writes. */
    private keptLastUsedWrittenAt = 0;
    /** When the idle lock counts from, shared with tabs that join while unlocked. */
    private lastUsedAt = 0;
    private channel: BroadcastChannel | null = null;
    private readonly pending: PendingUnlock[] = [];

    constructor() {
        super({
            status: "locked",
            currentKeyId: null,
            persisted: false,
            lockAfter: DEFAULT_VAULT_LOCK_AFTER,
            pendingReason: null,
        });
    }

    /**
     * Joins the other tabs and restores kept keys. `currentKeyId` is the server's current
     * generation: kept keys of another generation were rotated elsewhere, so they are
     * deleted and the user unlocks again. Kept keys unused for longer than their idle lock
     * are deleted too, because the vault would have locked had the browser stayed open.
     */
    async start(currentKeyId: () => Promise<string | null>): Promise<void> {
        if ("BroadcastChannel" in globalThis) {
            this.channel = new BroadcastChannel(CHANNEL_NAME);
            this.channel.onmessage = (event: MessageEvent<unknown>) => {
                const parsed = channelMessageSchema.safeParse(event.data);

                if (parsed.success) {
                    this.receive(parsed.data);
                }
            };

            this.channel.postMessage({ type: "ask" } satisfies ChannelMessage);
        }

        const stored = await this.readKept().catch(() => null);

        vaultDebug("session start", {
            hasKeptKeys: stored !== null,
            alreadyUnlocked: this.vault !== null,
        });

        if (stored === null || this.vault !== null) {
            return;
        }

        const idleMs = VAULT_LOCK_AFTER[stored.lockAfter].idleMs;

        if (idleMs !== null && Date.now() - stored.lastUsedAt >= idleMs) {
            vaultDebug("kept keys passed their idle lock, forgetting them", {
                lockAfter: stored.lockAfter,
            });
            await this.forgetKept();

            return;
        }

        // An unreachable server (or an expired session) cannot prove a rotation, so the kept
        // keys stay; writes with an outdated generation are refused by the server anyway.
        const expected = await currentKeyId().catch(() => undefined);

        if (expected !== undefined && expected !== stored.currentKeyId) {
            vaultDebug(
                "kept keys are of a rotated generation, forgetting them",
            );
            await this.forgetKept();

            return;
        }

        this.adopt(fromStored(stored), {
            lockAfter: stored.lockAfter,
            source: "kept keys",
            lastUsedAt: stored.lastUsedAt,
        });
    }

    /** The unlocked vault, or null while locked. */
    current(): UnlockedVault | null {
        return this.vault;
    }

    /**
     * Resolves with the unlocked vault, asking the user to unlock or create it first when
     * needed. Rejects with `VaultUnlockCancelled` if they cancel.
     */
    requestUnlock(reason: string): Promise<UnlockedVault> {
        if (this.vault !== null) {
            this.touch();

            return Promise.resolve(this.vault);
        }

        vaultDebug("unlock requested", {
            reason,
            alreadyWaiting: this.pending.length,
            stack: callerStack(),
        });

        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            this.publishState(reason);
        });
    }

    /** Ends every waiting flow because the user closed the dialog. */
    cancelPending(): void {
        vaultDebug("unlock cancelled", {
            waiting: this.pending.length,
            stack: callerStack(),
        });

        for (const waiting of this.pending.splice(0)) {
            waiting.reject(new VaultUnlockCancelled());
        }

        this.publishState(null);
    }

    /**
     * Installs freshly unlocked keys in this tab and every other one, locking after
     * `lockAfter` without use. Choices kept on the device also go to IndexedDB, so they
     * survive reloads until that lock.
     */
    async unlock(
        vault: UnlockedVault,
        lockAfter: VaultLockAfter,
    ): Promise<void> {
        vaultDebug("unlocking", { lockAfter, waiting: this.pending.length });

        if (VAULT_LOCK_AFTER[lockAfter].keptOnDevice) {
            await this.writeKept({
                ...toStored(vault),
                lockAfter,
                lastUsedAt: Date.now(),
            });
        } else {
            await this.forgetKept().catch(() => undefined);
        }

        this.adopt(vault, { lockAfter, source: "this tab" });
        this.post({
            type: "unlocked",
            vault: toStored(vault),
            lockAfter,
            lastUsedAt: this.lastUsedAt,
        });
    }

    /**
     * Switches this tab to the keys of a rotation it just made. Every other tab locks and
     * kept keys are deleted, because they hold the replaced generation and must unlock
     * again before writing. This tab keeps the lock the user picked at unlock, so a choice
     * kept on the device keeps the new keys there.
     */
    async rotated(vault: UnlockedVault): Promise<void> {
        vaultDebug("rotated, locking other tabs");
        const lockAfter = this.lockAfter;
        await this.lock();

        if (VAULT_LOCK_AFTER[lockAfter].keptOnDevice) {
            await this.writeKept({
                ...toStored(vault),
                lockAfter,
                lastUsedAt: Date.now(),
            });
        }

        this.adopt(vault, { lockAfter, source: "rotation" });
    }

    /**
     * Locks every tab and deletes kept keys. The kept copy goes first, so the lock shown
     * to the user is never undone by a reload that races the deletion.
     */
    async lock(): Promise<void> {
        vaultDebug("locking", { stack: callerStack() });
        await this.forgetKept().catch(() => undefined);
        this.drop();
        this.post({ type: "locked" });
    }

    /**
     * Restarts the idle timer of every tab, because the vault was just used: one tab must
     * not lock all of them while another is in use.
     */
    touch(): void {
        this.restartIdleTimer();
        this.post({ type: "touched" });
        void this.recordKeptUse().catch(() => undefined);
    }

    /**
     * Restarts this tab's idle timer from `lastUsedAt`, or stops it when the vault has no
     * idle lock. Kept keys restored on load pass their stored last use, so a reload does not
     * count as use and grant a fresh idle period.
     */
    private restartIdleTimer(lastUsedAt = Date.now()): void {
        this.lastUsedAt = lastUsedAt;

        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        const idleMs = VAULT_LOCK_AFTER[this.lockAfter].idleMs;

        if (this.vault === null || idleMs === null) {
            return;
        }

        this.idleTimer = window.setTimeout(
            () => {
                vaultDebug("idle timeout reached", {
                    lockAfter: this.lockAfter,
                });
                void this.lock();
            },
            Math.max(0, lastUsedAt + idleMs - Date.now()),
        );
    }

    /**
     * Moves the kept vault's last use forward, so a reload after a long pause measures the
     * idle lock from the last use rather than from the unlock. Throttled, because file reads
     * touch the vault constantly.
     */
    private async recordKeptUse(): Promise<void> {
        const now = Date.now();

        if (
            this.vault === null ||
            !VAULT_LOCK_AFTER[this.lockAfter].keptOnDevice ||
            VAULT_LOCK_AFTER[this.lockAfter].idleMs === null ||
            now - this.keptLastUsedWrittenAt < KEPT_LAST_USED_WRITE_INTERVAL_MS
        ) {
            return;
        }

        this.keptLastUsedWrittenAt = now;
        await this.updateKeptLastUsed(now);
    }

    /** Takes keys in, starts their idle lock and wakes waiting flows. */
    private adopt(vault: UnlockedVault, options: AdoptOptions): void {
        const lastUsedAt = options.lastUsedAt ?? Date.now();

        vaultDebug("adopting unlocked keys", {
            source: options.source,
            lockAfter: options.lockAfter,
            wasUnlocked: this.vault !== null,
            waking: this.pending.length,
        });

        this.vault = vault;
        this.lockAfter = options.lockAfter;
        // A kept record already holds this time, so the next use writes again only after the
        // throttle interval.
        this.keptLastUsedWrittenAt = lastUsedAt;
        this.restartIdleTimer(lastUsedAt);

        for (const waiting of this.pending.splice(0)) {
            waiting.resolve(vault);
        }

        this.publishState(null);
    }

    /** Forgets keys in this tab only. */
    private drop(): void {
        vaultDebug("dropping keys", {
            wasUnlocked: this.vault !== null,
            stillWaiting: this.pending.length,
        });

        this.vault = null;

        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        this.publishState(this.snapshotReason());
    }

    /** Handles a message from another tab. */
    private receive(message: ChannelMessage): void {
        if (message.type !== "touched") {
            vaultDebug("message from another tab", { type: message.type });
        }

        if (message.type === "unlocked") {
            this.adopt(fromStored(message.vault), {
                lockAfter: message.lockAfter,
                source: "other tab",
                lastUsedAt: message.lastUsedAt,
            });
        } else if (message.type === "locked") {
            this.drop();
        } else if (message.type === "touched") {
            this.restartIdleTimer();
        } else if (this.vault !== null) {
            // A new tab asks; answer so it starts unlocked like the others.
            this.post({
                type: "unlocked",
                vault: toStored(this.vault),
                lockAfter: this.lockAfter,
                lastUsedAt: this.lastUsedAt,
            });
        }
    }

    /** Sends a message to the other tabs. */
    private post(message: ChannelMessage): void {
        this.channel?.postMessage(message);
    }

    /** The reason of the open dialog, kept while flows still wait. */
    private snapshotReason(): string | null {
        return this.pending.length > 0
            ? this.getSnapshot().pendingReason
            : null;
    }

    /** Publishes the lock state. */
    private publishState(pendingReason: string | null): void {
        this.publish({
            status: this.vault === null ? "locked" : "unlocked",
            currentKeyId: this.vault?.currentKeyId ?? null,
            persisted:
                this.vault !== null &&
                VAULT_LOCK_AFTER[this.lockAfter].keptOnDevice,
            lockAfter: this.lockAfter,
            pendingReason,
        });
    }

    /** Reads kept keys, or null. */
    private async readKept(): Promise<KeptVault | null> {
        if (!("indexedDB" in globalThis)) {
            return null;
        }

        const parsed = keptVaultSchema.safeParse(
            await withStore("readonly", (store) => store.get(RECORD_KEY)),
        );

        return parsed.success ? parsed.data : null;
    }

    /** Keeps keys in IndexedDB. */
    private async writeKept(stored: KeptVault): Promise<void> {
        await withStore("readwrite", (store) => store.put(stored, RECORD_KEY));
    }

    /**
     * Moves the last use of the kept record forward, reading and writing in one transaction.
     * A record that is gone stays gone: another tab may have locked the vault since this tab
     * last looked, and writing the keys back would undo that lock on the next reload.
     */
    private async updateKeptLastUsed(lastUsedAt: number): Promise<void> {
        const database = await openDatabase();

        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = database.transaction(
                    STORE_NAME,
                    "readwrite",
                );

                const store = transaction.objectStore(STORE_NAME);
                const read = store.get(RECORD_KEY);

                read.onsuccess = () => {
                    const parsed = keptVaultSchema.safeParse(read.result);

                    if (parsed.success) {
                        store.put({ ...parsed.data, lastUsedAt }, RECORD_KEY);
                    }
                };

                transaction.oncomplete = () => resolve();
                transaction.onerror = () =>
                    reject(transaction.error ?? new Error("IndexedDB"));
                transaction.onabort = () =>
                    reject(transaction.error ?? new Error("IndexedDB"));
            });
        } finally {
            database.close();
        }
    }

    /** Deletes kept keys. */
    private async forgetKept(): Promise<void> {
        if (!("indexedDB" in globalThis)) {
            return;
        }

        await withStore("readwrite", (store) => store.delete(RECORD_KEY));
    }
}
