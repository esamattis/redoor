/**
 * The browser's vault lock state: which vault keys this tab holds, shared between tabs and
 * kept across reloads until the vault locks.
 *
 * Keys are non-extractable `CryptoKey`s while a tab is open. Tabs share them over a
 * `BroadcastChannel` (`CryptoKey` can be cloned between tabs), so unlocking once unlocks every
 * open tab, and locking in one tab locks all of them.
 *
 * Across reloads the browser keeps the raw current vault key only encrypted with a device
 * secret that the server holds in memory (see `POST /api/v1/vault/devices`). The server
 * hands that secret out only to the login session that created it and only within the idle
 * time the user picked (`VaultLockAfter`), and forgets it after that window, on sign-out, at
 * the end of the session or on a server restart. So the idle lock holds even with no redoor
 * tab open, and a copied browser profile holds ciphertext that nobody can open once the
 * window has passed. The server never sees the vault key.
 *
 * Code that needs the vault calls `requestUnlock`, which resolves at once while unlocked and
 * otherwise asks the vault dialog (rendered once in the app shell) to create or unlock the
 * vault.
 */
import { z } from "zod";
import type { VaultLockAfter } from "#bindings/VaultLockAfter";
import type { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import { ExternalStore } from "#ui/utils/external-store";
import { unwrapForDevice, wipe, wrapForDevice } from "#ui/vault/vault-crypto";
import { callerStack, vaultDebug } from "#ui/vault/vault-debug";
import { openGenerations, type UnlockedVault } from "#ui/vault/vault-keys";

/** The shortest choice, so an unlock without a deliberate pick locks soon. */
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
 * How often a vault use is reported to the server at most. Every encrypted file read touches
 * the vault, and a minute of slack on a lock measured in quarter hours or more is not worth a
 * request per read.
 */
const TOUCH_INTERVAL_MS = 60 * 1000;

const CHANNEL_NAME = "redoor-vault";

const DATABASE_NAME = "redoor-vault";

const STORE_NAME = "keys";

const RECORD_KEY = "vault";

/** What the UI shows about the lock. */
export type VaultLockState = {
    status: "locked" | "unlocked";
    /** The unlocked current generation, so the UI can notice a rotation elsewhere. */
    currentKeyId: string | null;
    /** How long the vault stays unlocked without use. */
    lockAfter: VaultLockAfter;
    /** Why the vault dialog is open, or null when no flow waits for an unlock. */
    pendingReason: string | null;
};

/** The keys as they cross tabs; parsed because messages are outside input. */
const storedVaultSchema = z.object({
    vaultId: z.string(),
    currentKeyId: z.string(),
    keys: z.array(z.tuple([z.string(), z.instanceof(CryptoKey)])),
});

type StoredVault = z.infer<typeof storedVaultSchema>;

/**
 * The IndexedDB record: the raw current vault key wrapped with the server's device secret,
 * and what the wrap is bound to. It holds no key that opens anything by itself. A record of
 * any other shape fails to parse and is deleted.
 */
const deviceRecordSchema = z.object({
    vaultId: z.string(),
    keyId: z.string(),
    deviceId: z.string(),
    lockAfter: lockAfterSchema,
    iv: z.string(),
    wrappedKey: z.string(),
});

type DeviceRecord = z.infer<typeof deviceRecordSchema>;

/** Messages between tabs. */
const channelMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("unlocked"),
        vault: storedVaultSchema,
        // So every live tab can touch and check the server entry.
        deviceId: z.string(),
        lockAfter: lockAfterSchema,
        // The server's remaining idle time, so tabs agree on when the vault locks.
        expiresInSeconds: z.number().nullable(),
    }),
    z.object({ type: z.literal("locked") }),
    z.object({
        type: z.literal("touched"),
        deviceId: z.string(),
        expiresInSeconds: z.number().nullable(),
    }),
]);

type ChannelMessage = z.infer<typeof channelMessageSchema>;

/** How a set of adopted keys locks, and where they came from. */
type AdoptOptions = {
    deviceId: string;
    lockAfter: VaultLockAfter;
    /** The server's remaining idle time; null without an idle lock. */
    expiresInSeconds: number | null;
    /** Only feeds the debug log, to tell this tab's unlock from another tab's or a reload's. */
    source: string;
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

/**
 * Whether the server answered that the device entry is gone (expired, locked, another or an
 * ended session, a server restart). Only then is the kept key useless; a network error says
 * nothing about the entry.
 */
function isDeviceGone(error: Error): boolean {
    return error instanceof ApiError && error.status === 404;
}

/** Opens the IndexedDB database that holds the wrapped key. */
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
    /** The server entry whose secret wraps the kept key, while unlocked. */
    private deviceId: string | null = null;
    private lockAfter: VaultLockAfter = DEFAULT_VAULT_LOCK_AFTER;
    private idleTimer: number | null = null;
    /** When a use was last reported to the server by any tab, to throttle the reports. */
    private lastTouchAt = 0;
    /**
     * Counts locks of this tab, so a page-load restore that was waiting for the server when
     * this or another tab locked does not adopt the keys afterwards.
     */
    private locks = 0;
    private channel: BroadcastChannel | null = null;
    private readonly pending: PendingUnlock[] = [];

    constructor(private readonly api: ApiClient) {
        super({
            status: "locked",
            currentKeyId: null,
            lockAfter: DEFAULT_VAULT_LOCK_AFTER,
            pendingReason: null,
        });
    }

    /**
     * Joins the other tabs and restores the kept key through the server. Every page load asks
     * the server, even while other tabs are unlocked: a tab that survived a server restart,
     * an ended session or an expiry would otherwise hand its keys to a fresh tab whose server
     * entry is gone.
     */
    async start(): Promise<void> {
        if ("BroadcastChannel" in globalThis) {
            this.channel = new BroadcastChannel(CHANNEL_NAME);
            this.channel.onmessage = (event: MessageEvent<unknown>) => {
                const parsed = channelMessageSchema.safeParse(event.data);

                if (parsed.success) {
                    this.receive(parsed.data);
                }
            };
        }

        // A page that was hidden may have missed a lock elsewhere, such as an expiry or a
        // server restart, so it asks the server once it is shown again.
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                void this.check();
            }
        });

        const record = await this.readRecord().catch(() => null);

        vaultDebug("session start", { hasKeptKey: record !== null });

        if (record !== null) {
            await this.restore(record);
        }
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
     * `lockAfter` without use. `rawCurrent` is the raw current vault key, which is wrapped
     * with a new server device secret and kept in IndexedDB; the caller wipes it afterwards.
     * Fails when the server cannot register the secret, because the vault would then not
     * survive a reload and the idle lock could not be enforced.
     */
    async unlock(
        vault: UnlockedVault,
        lockAfter: VaultLockAfter,
        rawCurrent: Uint8Array<ArrayBuffer>,
    ): Promise<void> {
        vaultDebug("unlocking", { lockAfter, waiting: this.pending.length });

        const previous = await this.readRecord().catch(() => null);

        const device = await this.api
            .createVaultDevice({ lock_after: lockAfter })
            .catch((error: Error) => {
                throw new Error(
                    "The server could not keep the vault unlocked for this browser. Try again.",
                    { cause: error },
                );
            });

        const wrap = await wrapForDevice(device.secret, rawCurrent, {
            vaultId: vault.vaultId,
            keyId: vault.currentKeyId,
            deviceId: device.device_id,
        });

        await this.writeRecord({
            vaultId: vault.vaultId,
            keyId: vault.currentKeyId,
            deviceId: device.device_id,
            lockAfter,
            iv: wrap.iv,
            wrappedKey: wrap.ct,
        });

        this.lastTouchAt = Date.now();

        const options = {
            deviceId: device.device_id,
            lockAfter,
            expiresInSeconds: device.expires_in_seconds,
        };

        this.adopt(vault, { ...options, source: "this tab" });
        this.post({ type: "unlocked", vault: toStored(vault), ...options });

        // A kept key that could not be opened before (an unreachable server) has an entry
        // that nothing uses anymore.
        if (previous !== null && previous.deviceId !== device.device_id) {
            void this.api
                .deleteVaultDevice(previous.deviceId)
                .catch(() => undefined);
        }
    }

    /**
     * Switches to the keys of a rotation this tab just made. The server deleted every device
     * entry, because they all wrap the replaced generation, so this browser registers a fresh
     * one with the lock the user picked at unlock and hands the new keys to its other tabs.
     * The rotation itself already succeeded, so a failure here only leaves the vault locked.
     */
    async rotated(
        vault: UnlockedVault,
        rawNext: Uint8Array<ArrayBuffer>,
    ): Promise<void> {
        vaultDebug("rotated, registering the new key");
        const lockAfter = this.lockAfter;
        await this.lock();

        try {
            await this.unlock(vault, lockAfter, rawNext);
        } catch (error) {
            vaultDebug("keeping the rotated key failed, staying locked", {
                error: String(error),
            });
        }
    }

    /**
     * Locks every tab, deletes the kept key and its server entry. The kept copy goes first,
     * so the lock shown to the user is never undone by a reload that races the deletion. The
     * server entry goes best effort: if that fails, the server still expires it on its own.
     */
    async lock(): Promise<void> {
        vaultDebug("locking", { stack: callerStack() });
        const record = await this.readRecord().catch(() => null);
        const deviceIds = new Set([this.deviceId, record?.deviceId]);
        await this.forgetRecord().catch(() => undefined);
        this.drop();
        this.post({ type: "locked" });

        await Promise.all(
            [...deviceIds].flatMap((deviceId) =>
                deviceId === null || deviceId === undefined
                    ? []
                    : [
                          this.api
                              .deleteVaultDevice(deviceId)
                              .catch(() => undefined),
                      ],
            ),
        );
    }

    /**
     * Reports a vault use to the server, which restarts the idle lock of every tab and of the
     * kept key. Throttled, because file reads touch the vault constantly.
     */
    touch(): void {
        const deviceId = this.deviceId;
        const now = Date.now();

        if (
            this.vault === null ||
            deviceId === null ||
            now - this.lastTouchAt < TOUCH_INTERVAL_MS
        ) {
            return;
        }

        this.lastTouchAt = now;

        void this.api.touchVaultDevice(deviceId).then(
            (status) => {
                if (this.deviceId !== deviceId) {
                    return;
                }

                this.restartIdleTimer(status.expires_in_seconds);
                this.post({
                    type: "touched",
                    deviceId,
                    expiresInSeconds: status.expires_in_seconds,
                });
            },
            (error: Error) => this.serverCheckFailed(deviceId, error),
        );
    }

    /**
     * Asks the server whether the kept key still opens, unthrottled, and locks every tab if
     * not. Deleting the server secret does not revoke the `CryptoKey`s an open tab already
     * holds, so the tab drops them itself. Called when the UI event connection reconnects
     * (which is how a server restart shows up) and when a hidden page is shown again.
     */
    async check(): Promise<void> {
        const deviceId = this.deviceId;

        if (this.vault === null || deviceId === null) {
            return;
        }

        try {
            const status = await this.api.getVaultDevice(deviceId);

            if (this.deviceId === deviceId) {
                this.restartIdleTimer(status.expires_in_seconds);
            }
        } catch (error) {
            if (error instanceof Error) {
                this.serverCheckFailed(deviceId, error);
            }
        }
    }

    /**
     * Opens a kept key through the server on page load. A gone entry or a key of another
     * generation (rotated elsewhere) deletes the record; a network error keeps it, so a
     * later load can retry.
     */
    private async restore(record: DeviceRecord): Promise<void> {
        const locksAtStart = this.locks;
        let opened;

        try {
            opened = await this.api.openVaultDevice(record.deviceId);
        } catch (error) {
            if (error instanceof Error && isDeviceGone(error)) {
                vaultDebug("kept key's server entry is gone, forgetting it");
                await this.forgetRecord(record.deviceId).catch(() => undefined);
            }

            return;
        }

        const material = await this.api
            .getVaultUnlockMaterial()
            .catch(() => null);

        if (material === null) {
            return;
        }

        if (
            material.vault_id !== record.vaultId ||
            material.current_key_id !== record.keyId
        ) {
            vaultDebug("kept key is of a rotated generation, forgetting it");
            await this.forgetRecord(record.deviceId).catch(() => undefined);
            void this.api
                .deleteVaultDevice(record.deviceId)
                .catch(() => undefined);

            return;
        }

        let vault: UnlockedVault;

        try {
            const raw = await unwrapForDevice(
                opened.secret,
                { alg: "A256GCM", iv: record.iv, ct: record.wrappedKey },
                {
                    vaultId: record.vaultId,
                    keyId: record.keyId,
                    deviceId: record.deviceId,
                },
            );

            try {
                vault = await openGenerations(material, raw);
            } finally {
                wipe(raw);
            }
        } catch (error) {
            vaultDebug("kept key does not open, forgetting it", {
                error: String(error),
            });
            await this.forgetRecord(record.deviceId).catch(() => undefined);
            void this.api
                .deleteVaultDevice(record.deviceId)
                .catch(() => undefined);

            return;
        }

        // A lock in this or another tab while the server answered wins, or the restore
        // would undo it.
        if (this.locks !== locksAtStart) {
            vaultDebug(
                "locked while the kept key was opening, not adopting it",
            );

            return;
        }

        // The user may have unlocked while the server answered; that unlock wins.
        if (this.vault !== null) {
            return;
        }

        this.adopt(vault, {
            deviceId: record.deviceId,
            lockAfter: record.lockAfter,
            expiresInSeconds: opened.expires_in_seconds,
            source: "kept key",
        });
    }

    /**
     * Locks every tab when the server says the entry is gone. A network error is not a 404:
     * the keys stay until the server answers.
     */
    private serverCheckFailed(deviceId: string, error: Error): void {
        if (!isDeviceGone(error) || this.deviceId !== deviceId) {
            return;
        }

        vaultDebug("server entry is gone, locking");
        void this.lock();
    }

    /**
     * Restarts this tab's idle timer from the server's remaining time, or stops it when the
     * vault has no idle lock. The server's clock decides, so a wrong browser clock does not
     * matter.
     */
    private restartIdleTimer(expiresInSeconds: number | null): void {
        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        if (this.vault === null || expiresInSeconds === null) {
            return;
        }

        this.idleTimer = window.setTimeout(
            () => {
                vaultDebug("idle timeout reached", {
                    lockAfter: this.lockAfter,
                });
                void this.lock();
            },
            Math.max(0, expiresInSeconds * 1000),
        );
    }

    /** Takes keys in, starts their idle lock and wakes waiting flows. */
    private adopt(vault: UnlockedVault, options: AdoptOptions): void {
        vaultDebug("adopting unlocked keys", {
            source: options.source,
            lockAfter: options.lockAfter,
            wasUnlocked: this.vault !== null,
            waking: this.pending.length,
        });

        this.vault = vault;
        this.deviceId = options.deviceId;
        this.lockAfter = options.lockAfter;
        this.restartIdleTimer(options.expiresInSeconds);

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
        this.deviceId = null;
        this.locks++;

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
            this.lastTouchAt = Date.now();
            this.adopt(fromStored(message.vault), {
                deviceId: message.deviceId,
                lockAfter: message.lockAfter,
                expiresInSeconds: message.expiresInSeconds,
                source: "other tab",
            });
        } else if (message.type === "locked") {
            this.drop();
        } else if (message.deviceId === this.deviceId) {
            // Another tab reported a use, which counts for this tab's throttle too.
            this.lastTouchAt = Date.now();
            this.restartIdleTimer(message.expiresInSeconds);
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
            lockAfter: this.lockAfter,
            pendingReason,
        });
    }

    /**
     * Reads the kept key, or null. A record that does not parse (any older shape) is
     * deleted, since nothing can open it.
     */
    private async readRecord(): Promise<DeviceRecord | null> {
        if (!("indexedDB" in globalThis)) {
            return null;
        }

        const stored: unknown = await withStore("readonly", (store) =>
            store.get(RECORD_KEY),
        );

        if (stored === undefined) {
            return null;
        }

        const parsed = deviceRecordSchema.safeParse(stored);

        if (!parsed.success) {
            vaultDebug("kept record has an unknown shape, deleting it");
            await this.forgetRecord();

            return null;
        }

        return parsed.data;
    }

    /** Keeps the wrapped key in IndexedDB. */
    private async writeRecord(record: DeviceRecord): Promise<void> {
        await withStore("readwrite", (store) => store.put(record, RECORD_KEY));
    }

    /**
     * Deletes the kept key. With `deviceId`, only a record of that entry goes, read and
     * deleted in one transaction: another tab may have unlocked and written a new record
     * while this one waited for the server.
     */
    private async forgetRecord(deviceId?: string): Promise<void> {
        if (!("indexedDB" in globalThis)) {
            return;
        }

        if (deviceId === undefined) {
            await withStore("readwrite", (store) => store.delete(RECORD_KEY));

            return;
        }

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
                    const parsed = deviceRecordSchema.safeParse(read.result);

                    if (!parsed.success || parsed.data.deviceId === deviceId) {
                        store.delete(RECORD_KEY);
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
}
