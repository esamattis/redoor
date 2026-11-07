// Serial: the vault belongs to the one test account, so creating, unlocking or rotating it
// changes state every other spec would share.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
    confirmUpload,
    deviceBrowserUrl,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    uploadDialog,
    WEB_BASE_URL,
    type TestContext,
} from "../helpers";

const PASSPHRASE = "correct horse battery staple";

const MAGIC = Buffer.from("REDOORENCRYPTED\0", "latin1");

/** The Playwright server's data directories, where the account's vault file lives. */
const SERVER_SHARE = path.resolve(".test-playwright-home/.local/share");

/** The Playwright server's log, whose startup lines prove a restart ran. */
const SERVER_LOG = path.resolve("log/playwright-redoor.log");

/** Counts server startups in its log, so a restart can be told apart from a no-op. */
async function countServerStartups(): Promise<number> {
    const log = await fs.readFile(SERVER_LOG, "utf8").catch(() => "");

    return (log.match(/Loaded server config/g) ?? []).length;
}

/** Deletes the account's vault, so every test starts without one. */
async function removeVault() {
    const apps = await fs.readdir(SERVER_SHARE).catch(() => []);

    await Promise.all(
        apps.map((app) =>
            fs.rm(path.join(SERVER_SHARE, app, "vault.json"), {
                force: true,
            }),
        ),
    );
}

/**
 * Creates a vault through the dialog that the first encrypted file opens. `lockAfter` is the
 * label of a "Stay unlocked for" choice; without it the default stays picked.
 */
async function createVaultInDialog(page: Page, lockAfter?: string) {
    const dialog = page.getByRole("dialog", { name: "Create vault" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel("Repeat passphrase").fill(PASSPHRASE);

    if (lockAfter !== undefined) {
        await dialog
            .getByLabel("Stay unlocked for")
            .selectOption({ label: lockAfter });
    }

    await dialog.getByRole("button", { name: "Create vault" }).click();
    // Argon2id takes a moment; the dialog closes once the vault exists and is unlocked.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
}

/** Unlocks with the passphrase in the shared vault dialog, like `createVaultInDialog`. */
async function unlockInDialog(
    page: Page,
    lockAfter?: string,
    passphrase = PASSPHRASE,
) {
    const dialog = page.getByRole("dialog", { name: "Unlock vault" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Passphrase", { exact: true }).fill(passphrase);

    if (lockAfter !== undefined) {
        await dialog
            .getByLabel("Stay unlocked for")
            .selectOption({ label: lockAfter });
    }

    await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
}

/** Signs in with the test account's password, giving this page a session of its own. */
async function signIn(page: Page) {
    await page.goto(`${WEB_BASE_URL}/login`);
    await page.getByLabel("Username").fill("test-user");
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${WEB_BASE_URL}/`);
}

/** The part of the IndexedDB record the tests read: which server entry wraps the key. */
const keptRecordSchema = z.object({ deviceId: z.string() });

/**
 * The server entry id of the vault key kept in this browser, read from IndexedDB, or null
 * when no key is kept.
 */
async function keptDeviceId(page: Page): Promise<string | null> {
    const record = await page.evaluate(
        () =>
            new Promise<unknown>((resolve, reject) => {
                const open = indexedDB.open("redoor-vault", 1);

                open.onupgradeneeded = () => {
                    open.result.createObjectStore("keys");
                };

                open.onerror = () => reject(open.error);

                open.onsuccess = () => {
                    const database = open.result;

                    const read = database
                        .transaction("keys", "readonly")
                        .objectStore("keys")
                        .get("vault");

                    read.onsuccess = () => {
                        database.close();
                        resolve(read.result);
                    };

                    read.onerror = () => {
                        database.close();
                        reject(read.error);
                    };
                };
            }),
    );

    return record === undefined
        ? null
        : keptRecordSchema.parse(record).deviceId;
}

/** The URL of a vault device entry on the server. */
function deviceEntryUrl(deviceId: string): string {
    return `${WEB_BASE_URL}/api/v1/vault/devices/${encodeURIComponent(deviceId)}`;
}

/**
 * Deletes this browser's server entry through the API, which stands in for an expiry or a
 * remote lock: the kept key stays in IndexedDB, but nothing can open it anymore.
 */
async function deleteServerEntry(page: Page): Promise<string> {
    const deviceId = await keptDeviceId(page);

    if (deviceId === null) {
        throw new Error("expected a vault key kept in this browser");
    }

    const response = await page.request.delete(deviceEntryUrl(deviceId));
    // The entry existed and belonged to this session.
    expect(response.status()).toBe(204);

    return deviceId;
}

/**
 * Hides the page and shows it again, as switching browser tabs does. Headless pages never
 * change their visibility, so the events are dispatched with a temporarily hidden state.
 */
async function hideAndShowPage(page: Page) {
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        // Removing the override brings back the real, visible state.
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

/** Creates an encrypted file from the directory's New menu. */
async function createVaultFile(page: Page, ctx: TestContext, fileName: string) {
    await page.goto(deviceBrowserUrl(ctx.agentName, ctx.testDirPath));
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("button", { name: "New file", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create file" });
    await dialog.getByRole("textbox", { name: "File name" }).fill(fileName);
    await dialog
        .getByRole("button", { name: "Create file", exact: true })
        .click();
}

/** Adds a virtual authenticator with PRF, so passkeys can derive vault keys in the test. */
async function addVirtualAuthenticator(page: Page) {
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            hasPrf: true,
        },
    });
}

/** Locks from the settings page and unlocks again with the passkey. */
async function relockWithPasskey(page: Page) {
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Unlock vault" });
    await dialog.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
}

test.describe.serial("Vault", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("vault");
    });

    test.beforeEach(async () => {
        await removeVault();
    });

    test.afterAll(async () => {
        await removeVault();
        await teardownTestDir(ctx.testDirPath);
    });

    test("creates, saves, reopens, uploads and downloads encrypted files", async ({
        page,
    }) => {
        const fileName = "secret.env.redoorencrypted";
        const filePath = path.join(ctx.testDirPath, fileName);
        await createVaultFile(page, ctx, fileName);
        // The first encrypted file asks for a vault, since none exists yet.
        await createVaultInDialog(page);
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByRole("textbox", { name: "File editor" });
        await editor.click();
        await editor.fill("API_KEY=very-secret");
        await page.keyboard.press("ControlOrMeta+a");
        await editor.dispatchEvent("contextmenu", { clientX: 40, clientY: 40 });

        const editorMenu = page.getByRole("dialog", {
            name: "Editor context menu",
        });

        // The selection enables copying, so the search below is off for the vault alone.
        await expect(
            editorMenu.getByRole("button", { name: "Copy", exact: true }),
        ).toBeEnabled();
        // Agent-side search would send the decrypted selection to the device.
        await expect(
            editorMenu.getByRole("button", {
                name: "Search in file's directory",
            }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(editorMenu).toHaveCount(0);
        await page.getByRole("button", { name: "Save file" }).click();
        // The save went through the encrypted write endpoint.
        await expect(page.getByText("Saved", { exact: true })).toBeVisible();
        const onDisk = await fs.readFile(filePath);
        // The device holds an encrypted file, never the plaintext.
        expect(onDisk.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
        expect(onDisk.includes(Buffer.from("very-secret"))).toBe(false);

        await page.reload();
        // Even the default 15 minutes survive a reload, since the server hands the secret
        // back, so the editor shows the decrypted content without asking.
        await expect(editor).toHaveText("API_KEY=very-secret");

        await page.getByRole("button", { name: "Editor actions" }).click();
        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download decrypted" }).click();
        const download = await downloadPromise;
        // The decrypted copy drops the vault suffix.
        expect(download.suggestedFilename()).toBe("secret.env");
        const savedPath = await download.path();
        // The download carries the plaintext.
        expect(await fs.readFile(savedPath, "utf8")).toBe(
            "API_KEY=very-secret",
        );

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Lock now" }).click();
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
        await page.goto(deviceBrowserUrl(ctx.agentName, ctx.testDirPath));
        await page.getByLabel("Choose files to upload").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("uploaded plaintext"),
        });

        const upload = uploadDialog(page);

        const encrypt = upload.getByRole("checkbox", {
            name: "Encrypt notes.txt",
        });

        // The vault was locked, so encryption cannot be chosen yet.
        await expect(encrypt).toBeDisabled();
        await upload.getByRole("button", { name: "Unlock vault" }).click();
        await unlockInDialog(page);
        // Unlocking from the upload dialog makes encryption available in it.
        await expect(encrypt).toBeEnabled();
        await encrypt.click();
        // The encrypted file gets the vault suffix, so the user sees the name it is saved under.
        await expect(upload).toContainText(
            "Saved as notes.txt.redoorencrypted",
        );
        await confirmUpload(page, 1);

        const uploaded = path.join(
            ctx.testDirPath,
            "notes.txt.redoorencrypted",
        );

        // The upload is written encrypted under the suffixed name.
        await expect
            .poll(async () =>
                (await fs.readFile(uploaded).catch(() => Buffer.alloc(0)))
                    .subarray(0, MAGIC.length)
                    .equals(MAGIC),
            )
            .toBe(true);
        expect(
            (await fs.readFile(uploaded)).includes(Buffer.from("uploaded")),
        ).toBe(false);
    });

    test("keeps the vault unlocked on this device until it is locked or rotated", async ({
        page,
        browser,
    }) => {
        const fileName = "kept.txt.redoorencrypted";
        await createVaultFile(page, ctx, fileName);
        await createVaultInDialog(page, "Until I lock it");
        const editor = page.getByRole("textbox", { name: "File editor" });
        await expect(editor).toBeVisible();

        await page.reload();
        // A kept key survives the reload, so the editor opens without asking.
        await expect(editor).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Unlock vault" }),
        ).toBeHidden();

        // Another browser rotates the vault, which the kept key does not know about.
        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await otherPage.goto(`${WEB_BASE_URL}/settings/vault`);
        await otherPage
            .getByRole("button", { name: "Rotate vault key", exact: true })
            .click();

        const rotate = otherPage.getByRole("dialog", {
            name: "Rotate vault key",
        });

        await rotate.getByLabel("Current passphrase").fill(PASSPHRASE);
        await rotate
            .getByRole("button", { name: "Rotate", exact: true })
            .click();
        await expect(rotate).toBeHidden({ timeout: 30_000 });
        await other.close();

        await page.reload();
        // The rotation deleted every browser's server entry, so the kept key no longer opens
        // and a fresh unlock is asked.
        await expect(
            page.getByRole("button", { name: "Unlock vault" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Unlock vault" }).click();
        await unlockInDialog(page, "Until I lock it");
        await expect(editor).toBeVisible();

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // The fresh unlock was kept too, so the settings page loads unlocked.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");
        const deviceId = await keptDeviceId(page);
        // Precondition: the unlock registered a server entry for the kept key.
        expect(deviceId).not.toBeNull();
        await page.getByRole("button", { name: "Lock now" }).click();
        // Locking removes the key from this tab and from this browser.
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
        await expect.poll(() => keptDeviceId(page)).toBeNull();

        if (deviceId !== null) {
            // "Lock now" deleted the server entry too, so a copy of the record opens nothing.
            await expect
                .poll(async () =>
                    (await page.request.get(deviceEntryUrl(deviceId))).status(),
                )
                .toBe(404);
        }

        await page.reload();
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
    });

    test("signing out and in again leaves the vault locked", async ({
        page,
    }) => {
        // A session of its own, because logging out revokes the session shared by the specs.
        await page.context().clearCookies();
        await signIn(page);
        await createVaultFile(page, ctx, "logout.txt.redoorencrypted");
        await createVaultInDialog(page, "Until I lock it");
        await expect(
            page.getByRole("textbox", { name: "File editor" }),
        ).toBeVisible();

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // Precondition: the vault is unlocked and has no idle lock that could end it.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("button", { name: "Log out" })
            .click();
        await expect(page).toHaveURL(`${WEB_BASE_URL}/login`);

        await signIn(page);
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // Logout deleted the kept key and its server entry, so signing in again, as the next
        // user of this browser would, finds the vault locked.
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
    });

    test("locks the vault after the picked time without use", async ({
        page,
    }) => {
        // A fake clock, so the idle lock can pass without waiting for it.
        await page.clock.install();
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        const create = page.getByRole("dialog", { name: "Create vault" });
        const createLockAfter = create.getByLabel("Stay unlocked for");
        // The shortest lock is the default, so an unlock without a deliberate pick locks soon.
        await expect(createLockAfter).toHaveValue("15_minutes");
        await createLockAfter.selectOption({ label: "1 hour" });
        // Every choice keeps the key in this browser, opened only through this sign-in.
        await expect(create).toContainText(
            "Locks after 1 hour without use, when you sign out or your session ends, or when the server restarts.",
        );
        await create.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
        await create.getByLabel("Repeat passphrase").fill(PASSPHRASE);
        await create.getByRole("button", { name: "Create vault" }).click();
        await expect(create).toBeHidden({ timeout: 30_000 });

        const status = page.getByLabel("Vault status");
        const idleLock = page.getByLabel("Vault idle lock");
        // The settings page names the picked lock.
        await expect(status).toHaveText("Unlocked");
        await expect(idleLock).toHaveText("Locks after 1 hour without use");

        await page.clock.fastForward("30:00");
        // Half the picked hour is not enough to lock it.
        await expect(status).toHaveText("Unlocked");
        await page.clock.fastForward("31:00");
        // Past the picked hour without use, the vault locks itself.
        await expect(status).toHaveText("Locked");
        // The lock deleted the kept key too.
        await expect.poll(() => keptDeviceId(page)).toBeNull();
    });

    test("every lock choice survives a reload", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page);
        const status = page.getByLabel("Vault status");
        const idleLock = page.getByLabel("Vault idle lock");

        const choices = [
            {
                label: "15 minutes",
                idle: "Locks after 15 minutes without use",
            },
            { label: "1 hour", idle: "Locks after 1 hour without use" },
            { label: "24 hours", idle: "Locks after 24 hours without use" },
            { label: "1 week", idle: "Locks after 1 week without use" },
            {
                label: "Until I lock it",
                idle: "Stays unlocked until you lock it or sign out",
            },
        ];

        for (const [index, choice] of choices.entries()) {
            if (index > 0) {
                await page.getByRole("button", { name: "Lock now" }).click();
                await expect(status).toHaveText("Locked");
                await page
                    .getByRole("button", { name: "Unlock", exact: true })
                    .click();
                await unlockInDialog(page, choice.label);
            }

            await expect(status).toHaveText("Unlocked");
            await page.reload();
            // The server hands the secret back, so the kept key opens again after the reload,
            // together with its lock choice.
            await expect(status).toHaveText("Unlocked");
            await expect(idleLock).toHaveText(choice.idle);
        }
    });

    test("a reload whose server entry is gone stays locked and forgets the key", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page, "Until I lock it");
        const status = page.getByLabel("Vault status");
        await expect(status).toHaveText("Unlocked");

        await deleteServerEntry(page);
        await page.reload();
        // Without its server secret the kept key opens nothing, so the vault stays locked.
        await expect(status).toHaveText("Locked");
        // The useless record is deleted rather than retried on every load.
        await expect.poll(() => keptDeviceId(page)).toBeNull();
    });

    test("an open tab locks when its server entry is gone and the page is shown again", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page, "Until I lock it");
        const status = page.getByLabel("Vault status");
        await expect(status).toHaveText("Unlocked");

        await deleteServerEntry(page);
        // Deleting the secret cannot revoke the keys the tab holds, so it still shows them.
        await expect(status).toHaveText("Unlocked");
        await hideAndShowPage(page);
        // Shown again, the tab asks the server, learns the entry is gone and locks, even
        // for a choice without an idle lock.
        await expect(status).toHaveText("Locked");
    });

    test("a tab opened after the server entry is gone stays locked next to an unlocked one", async ({
        page,
        context,
    }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page, "Until I lock it");
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");

        await deleteServerEntry(page);
        const joined = await context.newPage();
        await joined.goto(`${WEB_BASE_URL}/settings/vault`);
        // The new tab asks the server, not the open tab, so it does not take keys whose
        // server entry is gone.
        await expect(joined.getByLabel("Vault status")).toHaveText("Locked");
        await joined.close();
    });

    test("a lock in another tab wins over a page load that is opening the kept key", async ({
        page,
        context,
    }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page, "Until I lock it");
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");

        const joined = await context.newPage();
        let releaseMaterial = () => {};

        const materialHeld = new Promise<void>((held) => {
            void joined.route("**/api/v1/vault/unlock-material", (route) => {
                held();
                releaseMaterial = () => void route.continue();
            });
        });

        const notAdopted = joined.waitForEvent("console", (message) =>
            message
                .text()
                .includes(
                    "locked while the kept key was opening, not adopting it",
                ),
        );

        await joined.goto(`${WEB_BASE_URL}/settings/vault`);
        // The new tab already got the secret and now waits for the unlock material.
        await materialHeld;
        await page.getByRole("button", { name: "Lock now" }).click();
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
        releaseMaterial();
        // The new tab heard the lock while opening the kept key, so it drops the restore
        // instead of undoing the lock with keys it had already been sent.
        await notAdopted;
        await expect(joined.getByLabel("Vault status")).toHaveText("Locked");
        await joined.unrouteAll({ behavior: "wait" });
        await joined.close();
    });

    test("deletes an encrypted file from the editor while the vault is locked", async ({
        page,
    }) => {
        const fileName = "locked-delete.txt.redoorencrypted";
        const filePath = path.join(ctx.testDirPath, fileName);
        await createVaultFile(page, ctx, fileName);
        await createVaultInDialog(page);
        const editor = page.getByRole("textbox", { name: "File editor" });
        await editor.click();
        await editor.fill("to be deleted");
        await page.getByRole("button", { name: "Save file" }).click();
        await expect(page.getByText("Saved", { exact: true })).toBeVisible();

        await deleteServerEntry(page);
        await page.reload();
        // Without its server entry the kept key does not open, so the editor waits for an unlock.
        await expect(
            page.getByRole("button", { name: "Unlock vault" }),
        ).toBeVisible();
        // The status names the lock instead of claiming the file is loading.
        await expect(
            page.getByText("Vault locked", { exact: true }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Editor actions" }).click();

        const deleteButton = page.getByRole("button", {
            name: "Delete file",
            exact: true,
        });

        // Deleting only removes ciphertext, so it needs no key and stays available while locked.
        await expect(deleteButton).toBeEnabled();
        // Reload needs the decrypted content, so it stays disabled while locked.
        await expect(
            page.getByRole("button", { name: "Reload", exact: true }),
        ).toBeDisabled();
        await deleteButton.click();

        const dialog = page.getByRole("dialog", { name: "Delete this file?" });
        // The usual delete confirmation still guards the locked file.
        await expect(dialog).toBeVisible();
        await dialog
            .getByRole("checkbox", { name: "Delete permanently" })
            .click();
        await dialog
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        // The encrypted file is gone from the device.
        await expect
            .poll(async () =>
                fs.stat(filePath).then(
                    () => "exists",
                    (error: NodeJS.ErrnoException) => error.code,
                ),
            )
            .toBe("ENOENT");
    });

    test("unlocks with a registered passkey", async ({ page }) => {
        await addVirtualAuthenticator(page);

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page);
        await page.getByRole("button", { name: "Add passkey" }).click();
        const add = page.getByRole("dialog", { name: "Add passkey" });
        await add.getByLabel("Passkey name").fill("Virtual key");
        await add.getByLabel("Vault passphrase").fill(PASSPHRASE);
        await add.getByRole("button", { name: "Register passkey" }).click();
        await expect(add).toBeHidden({ timeout: 30_000 });
        // The passkey is listed as an unlock method.
        await expect(
            page.getByLabel("Unlock method Virtual key"),
        ).toBeVisible();

        await page.getByRole("button", { name: "Lock now" }).click();
        await page.getByRole("button", { name: "Unlock", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Unlock vault" });
        await dialog
            .getByRole("button", { name: "Unlock with passkey" })
            .click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        // The PRF output unwrapped the vault key, so the vault is unlocked.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");
    });

    test("cancels a passkey unlock whose prompt never settles", async ({
        page,
    }) => {
        await addVirtualAuthenticator(page);
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        const create = page.getByRole("dialog", { name: "Create vault" });
        await create
            .getByRole("checkbox", { name: "Unlock with a passkey" })
            .click();
        await create.getByLabel("Passkey name").fill("Virtual key");
        await create
            .getByRole("checkbox", { name: "Unlock with a passphrase" })
            .click();
        await create.getByRole("button", { name: "Create vault" }).click();
        await expect(create).toBeHidden({ timeout: 30_000 });

        // Stands in for a password manager whose passkey prompt cannot show: the request
        // only ends when the page aborts it, and records that it did.
        await page.evaluate(() => {
            navigator.credentials.get = (options) =>
                new Promise<Credential | null>((_resolve, reject) => {
                    const signal = options?.signal;

                    signal?.addEventListener("abort", () => {
                        document.body.dataset.passkeyAborted = "true";
                        reject(signal.reason);
                    });
                });
        });

        await page.getByRole("button", { name: "Lock now" }).click();
        await page.getByRole("button", { name: "Unlock", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Unlock vault" });

        const passkey = dialog.getByRole("button", {
            name: "Unlock with passkey",
        });

        await passkey.click();
        // The passkey request is pending, so this is the state that used to lock Cancel.
        await expect(passkey).toBeDisabled();
        const cancel = dialog.getByRole("button", { name: "Cancel" });
        // Cancel stays usable while only the passkey prompt is pending.
        await expect(cancel.last()).toBeEnabled();

        await cancel.last().click();
        await expect(dialog).toBeHidden();
        // Cancelling aborted the hanging passkey request instead of leaving it behind.
        await expect(page.locator("body")).toHaveAttribute(
            "data-passkey-aborted",
            "true",
        );
        // The vault was not unlocked by the abandoned prompt.
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
    });

    test("hides a dialog while the vault unlock it asks for is open", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page);
        await page.getByRole("button", { name: "Lock now" }).click();

        await page.getByRole("button", { name: "Rename vault" }).click();
        const rename = page.getByRole("dialog", { name: "Rename vault" });
        await rename.getByLabel("Name").fill("Renamed vault");
        await rename.getByRole("button", { name: "Rename" }).click();

        const unlock = page.getByRole("dialog", { name: "Unlock vault" });
        await expect(unlock).toBeVisible();
        // Only the topmost dialog stays open, so password managers that draw their passkey
        // prompt into the open dialog do not put it in the covered one.
        await expect(rename).toBeHidden();

        await unlock.getByRole("button", { name: "Cancel" }).first().click();
        await expect(unlock).toBeHidden();
        // The covered dialog comes back as the user left it.
        await expect(rename.getByLabel("Name")).toHaveValue("Renamed vault");

        await rename.getByRole("button", { name: "Rename" }).click();
        await unlockInDialog(page);
        await expect(rename).toBeHidden();
        // The rename went through after the unlock, so the reopened dialog still works.
        await expect(page.getByText("Renamed vault")).toBeVisible();
    });

    test("creates a passwordless vault, adds a generated passphrase and removes it again", async ({
        page,
    }) => {
        await addVirtualAuthenticator(page);
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        const create = page.getByRole("dialog", { name: "Create vault" });
        await create
            .getByRole("checkbox", { name: "Unlock with a passkey" })
            .click();
        await create.getByLabel("Passkey name").fill("Virtual key");
        await create
            .getByRole("checkbox", { name: "Unlock with a passphrase" })
            .click();
        // Without a passphrase the user is told that losing the passkeys loses the files.
        await expect(
            create.getByRole("note", { name: "Passwordless vault warning" }),
        ).toContainText("cannot help");
        await create.getByRole("button", { name: "Create vault" }).click();
        await expect(create).toBeHidden({ timeout: 30_000 });
        // The passkey is the only unlock method.
        await expect(
            page.getByLabel("Unlock method Virtual key"),
        ).toBeVisible();
        await expect(page.getByLabel(/^Unlock method /)).toHaveCount(1);

        await relockWithPasskey(page);
        // The passkey alone unwrapped the vault key.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");

        await page
            .getByRole("button", { name: "Add passphrase", exact: true })
            .click();
        const add = page.getByRole("dialog", { name: "Add passphrase" });
        await add.getByRole("button", { name: "Generate" }).click();

        const generated =
            (await add
                .getByLabel("Generated passphrase contents")
                .textContent()) ?? "";

        // The generated passphrase is shown in readable groups so it can be stored.
        expect(generated).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
        // Generating fills the repeat field too, so the user does not retype it.
        await expect(add.getByLabel("Repeat new passphrase")).toHaveValue(
            generated,
        );
        await add.getByRole("button", { name: "Unlock with passkey" }).click();
        await expect(add.getByText("Unlocked with Virtual key")).toBeVisible();
        await add
            .getByRole("button", { name: "Add passphrase", exact: true })
            .click();
        await expect(add).toBeHidden({ timeout: 30_000 });
        // The passphrase is listed next to the passkey.
        await expect(page.getByLabel("Unlock method Passphrase")).toBeVisible();

        await page.getByRole("button", { name: "Lock now" }).click();
        await page.getByRole("button", { name: "Unlock", exact: true }).click();
        await unlockInDialog(page, undefined, generated);
        // The generated passphrase wraps the same vault key.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");

        await page
            .getByRole("button", { name: "Remove passphrase", exact: true })
            .click();
        const remove = page.getByRole("dialog", { name: "Remove Passphrase" });
        // Removing the passphrase rotates the key unless the user opts out.
        await expect(
            remove.getByRole("checkbox", { name: "Rotate vault key" }),
        ).toBeChecked();
        await expect(
            remove.getByRole("note", { name: "Passwordless vault warning" }),
        ).toBeVisible();
        await remove.getByRole("button", { name: "Confirm" }).click();
        await expect(remove.getByText("Confirmed")).toBeVisible();
        await remove
            .getByRole("button", { name: "Rotate", exact: true })
            .click();
        await expect(remove).toBeHidden({ timeout: 30_000 });
        // Only the passkey is left after the rotation.
        await expect(page.getByLabel("Unlock method Passphrase")).toBeHidden();
        await expect(
            page.getByLabel("Unlock method Virtual key"),
        ).toBeVisible();

        await relockWithPasskey(page);
        // The confirmed passkey wraps the rotated key, so it still unlocks.
        await expect(page.getByLabel("Vault status")).toHaveText("Unlocked");
    });

    // Last, because restarting the shared server makes the agents reconnect.
    test("an open tab locks when the server restarts", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page, "Until I lock it");
        const status = page.getByLabel("Vault status");
        await expect(status).toHaveText("Unlocked");

        const startups = await countServerStartups();

        const restart = await page.request.post(
            `${WEB_BASE_URL}/api/v1/server/restart`,
        );

        // The server accepted the restart.
        expect(restart.ok()).toBe(true);

        await expect
            .poll(countServerStartups, { timeout: 30_000 })
            .toBeGreaterThan(startups);
        // Device secrets live in server memory only. The tab notices the restart when its
        // event connection reconnects, finds its entry gone and locks.
        await expect(status).toHaveText("Locked", { timeout: 30_000 });
        // The kept key was deleted too, since it can never open again.
        await expect.poll(() => keptDeviceId(page)).toBeNull();

        // The agents reconnect before later specs need them.
        await expect(
            page
                .getByRole("navigation", { name: "Devices" })
                .getByRole("link", { name: /agent1_src/ }),
        ).toBeVisible({ timeout: 30_000 });
    });
});
