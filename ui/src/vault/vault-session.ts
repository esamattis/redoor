/**
 * The browser's vault lock state: which vault keys this tab holds, shared between tabs and
 * optionally kept across reloads.
 *
 * Keys are non-extractable `CryptoKey`s. Tabs share them over a `BroadcastChannel`
 * (`CryptoKey` can be cloned between tabs), so unlocking once unlocks every tab, and locking
 * or rotating in one tab locks all of them. "Keep unlocked on this device" stores the keys
 * in IndexedDB, still non-extractable, so script cannot export them; anyone who can use or
 * copy this browser profile can still open the vault until it is locked.
 *
 * Code that needs the vault calls `requestUnlock`, which resolves at once while unlocked and
 * otherwise asks the vault dialog (rendered once in the app shell) to create or unlock the
 * vault.
 */
import { z } from "zod";
import { ExternalStore } from "#ui/utils/external-store";
import type { UnlockedVault } from "#ui/vault/vault-keys";

/** How long an unlocked vault stays unlocked without use, unless kept on this device. */
export const AUTO_LOCK_MS = 15 * 60 * 1000;

const CHANNEL_NAME = "redoor-vault";

const DATABASE_NAME = "redoor-vault";

const STORE_NAME = "keys";

const RECORD_KEY = "vault";

/** What the UI shows about the lock. */
export type VaultLockState = {
    status: "locked" | "unlocked";
    /** The unlocked current generation, so the UI can notice a rotation elsewhere. */
    currentKeyId: string | null;
    /** Kept in IndexedDB, with no idle lock. */
    persisted: boolean;
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

/** Messages between tabs. */
const channelMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("unlocked"),
        vault: storedVaultSchema,
        persisted: z.boolean(),
    }),
    z.object({ type: z.literal("locked") }),
    z.object({ type: z.literal("ask") }),
    z.object({ type: z.literal("touched") }),
]);

type ChannelMessage = z.infer<typeof channelMessageSchema>;

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
    private persisted = false;
    private idleTimer: number | null = null;
    private channel: BroadcastChannel | null = null;
    private readonly pending: PendingUnlock[] = [];

    constructor() {
        super({
            status: "locked",
            currentKeyId: null,
            persisted: false,
            pendingReason: null,
        });
    }

    /**
     * Joins the other tabs and restores kept keys. `currentKeyId` is the server's current
     * generation: kept keys of another generation were rotated elsewhere, so they are
     * deleted and the user unlocks again.
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

        if (stored === null || this.vault !== null) {
            return;
        }

        // An unreachable server (or an expired session) cannot prove a rotation, so the kept
        // keys stay; writes with an outdated generation are refused by the server anyway.
        const expected = await currentKeyId().catch(() => undefined);

        if (expected !== undefined && expected !== stored.currentKeyId) {
            await this.forgetKept();

            return;
        }

        this.adopt(fromStored(stored), true);
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

        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            this.publishState(reason);
        });
    }

    /** Ends every waiting flow because the user closed the dialog. */
    cancelPending(): void {
        for (const waiting of this.pending.splice(0)) {
            waiting.reject(new VaultUnlockCancelled());
        }

        this.publishState(null);
    }

    /**
     * Installs freshly unlocked keys in this tab and every other one. With `persist` they
     * are also kept in IndexedDB and never lock on idle.
     */
    async unlock(vault: UnlockedVault, persist: boolean): Promise<void> {
        if (persist) {
            await this.writeKept(toStored(vault));
        } else {
            await this.forgetKept().catch(() => undefined);
        }

        this.adopt(vault, persist);
        this.post({
            type: "unlocked",
            vault: toStored(vault),
            persisted: persist,
        });
    }

    /**
     * Switches this tab to the keys of a rotation it just made. Every other tab locks and
     * kept keys are deleted, because they hold the replaced generation and must unlock
     * again before writing.
     */
    async rotated(vault: UnlockedVault): Promise<void> {
        await this.lock();
        this.adopt(vault, false);
    }

    /**
     * Locks every tab and deletes kept keys. The kept copy goes first, so the lock shown
     * to the user is never undone by a reload that races the deletion.
     */
    async lock(): Promise<void> {
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
    }

    /** Restarts this tab's idle timer. */
    private restartIdleTimer(): void {
        if (this.vault === null || this.persisted) {
            return;
        }

        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
        }

        this.idleTimer = window.setTimeout(
            () => void this.lock(),
            AUTO_LOCK_MS,
        );
    }

    /** Takes keys in and wakes waiting flows. */
    private adopt(vault: UnlockedVault, persisted: boolean): void {
        this.vault = vault;
        this.persisted = persisted;

        if (persisted && this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        this.restartIdleTimer();

        for (const waiting of this.pending.splice(0)) {
            waiting.resolve(vault);
        }

        this.publishState(null);
    }

    /** Forgets keys in this tab only. */
    private drop(): void {
        this.vault = null;
        this.persisted = false;

        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        this.publishState(this.snapshotReason());
    }

    /** Handles a message from another tab. */
    private receive(message: ChannelMessage): void {
        if (message.type === "unlocked") {
            this.adopt(fromStored(message.vault), message.persisted);
        } else if (message.type === "locked") {
            this.drop();
        } else if (message.type === "touched") {
            this.restartIdleTimer();
        } else if (this.vault !== null) {
            // A new tab asks; answer so it starts unlocked like the others.
            this.post({
                type: "unlocked",
                vault: toStored(this.vault),
                persisted: this.persisted,
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
            persisted: this.persisted,
            pendingReason,
        });
    }

    /** Reads kept keys, or null. */
    private async readKept(): Promise<StoredVault | null> {
        if (!("indexedDB" in globalThis)) {
            return null;
        }

        const parsed = storedVaultSchema.safeParse(
            await withStore("readonly", (store) => store.get(RECORD_KEY)),
        );

        return parsed.success ? parsed.data : null;
    }

    /** Keeps keys in IndexedDB. */
    private async writeKept(stored: StoredVault): Promise<void> {
        await withStore("readwrite", (store) => store.put(stored, RECORD_KEY));
    }

    /** Deletes kept keys. */
    private async forgetKept(): Promise<void> {
        if (!("indexedDB" in globalThis)) {
            return;
        }

        await withStore("readwrite", (store) => store.delete(RECORD_KEY));
    }
}
