// Serial: the vault belongs to the one test account, so creating, unlocking or rotating it
// changes state every other spec would share.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
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
        // The default 15 minutes keep the key in open tabs only, so a reload locks the vault and the editor asks first.
        await page.getByRole("button", { name: "Unlock vault" }).click();
        await unlockInDialog(page);
        // The unlocked editor shows the decrypted content.
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

        // The reload locked the vault again, so encryption cannot be chosen yet.
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
        // The kept key is from before the rotation, so it is dropped and a fresh unlock asked.
        await expect(
            page.getByRole("button", { name: "Unlock vault" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Unlock vault" }).click();
        await unlockInDialog(page, "Until I lock it");
        await expect(editor).toBeVisible();

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // The fresh unlock was kept too, so the settings page loads unlocked.
        await expect(page.getByLabel("Vault status")).toHaveText(
            "Unlocked, kept on this device",
        );
        await page.getByRole("button", { name: "Lock now" }).click();
        // Locking removes the key from this tab and from the device.
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
        await page.reload();
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
    });

    test("logging out locks a vault kept on this device", async ({ page }) => {
        // A session of its own, because logging out revokes the session shared by the specs.
        await page.context().clearCookies();
        await signIn(page);
        await createVaultFile(page, ctx, "logout.txt.redoorencrypted");
        await createVaultInDialog(page, "Until I lock it");
        await expect(
            page.getByRole("textbox", { name: "File editor" }),
        ).toBeVisible();

        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // Precondition: the key is kept, so only an explicit lock can remove it.
        await expect(page.getByLabel("Vault status")).toHaveText(
            "Unlocked, kept on this device",
        );

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("button", { name: "Log out" })
            .click();
        await expect(page).toHaveURL(`${WEB_BASE_URL}/login`);

        await signIn(page);
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        // Logout deleted the kept key, so the next user of this browser finds the vault locked.
        await expect(page.getByLabel("Vault status")).toHaveText("Locked");
    });

    test("locks the vault after the picked time without use, also across reloads", async ({
        page,
    }) => {
        // A fake clock, so the idle lock can pass without waiting for it.
        await page.clock.install();
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        const create = page.getByRole("dialog", { name: "Create vault" });
        const createLockAfter = create.getByLabel("Stay unlocked for");
        // The shortest lock is the default, so an unlock without a deliberate pick locks soon
        // and never stores the key.
        await expect(createLockAfter).toHaveValue("15_minutes");
        await createLockAfter.selectOption({ label: "1 hour" });
        // Choices that store the key say that the limit is only checked while redoor is open.
        await expect(create).toContainText(
            "The time limit is only checked while redoor is open",
        );
        await create.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
        await create.getByLabel("Repeat passphrase").fill(PASSPHRASE);
        await create.getByRole("button", { name: "Create vault" }).click();
        await expect(create).toBeHidden({ timeout: 30_000 });

        const status = page.getByLabel("Vault status");
        const idleLock = page.getByLabel("Vault idle lock");
        // An hour is kept on the device, and the settings page names the picked lock.
        await expect(status).toHaveText("Unlocked, kept on this device");
        await expect(idleLock).toHaveText("Locks after 1 hour without use");

        await page.reload();
        // The kept key survives a reload together with its lock choice.
        await expect(status).toHaveText("Unlocked, kept on this device");
        await expect(idleLock).toHaveText("Locks after 1 hour without use");

        await page.clock.fastForward("30:00");
        // Half the picked hour is not enough to lock it.
        await expect(status).toHaveText("Unlocked, kept on this device");
        await page.clock.fastForward("31:00");
        // Past the picked hour without use, the vault locks itself.
        await expect(status).toHaveText("Locked");

        await page.getByRole("button", { name: "Unlock", exact: true }).click();
        await unlockInDialog(page, "1 hour");
        await expect(status).toHaveText("Unlocked, kept on this device");

        // Moving the time without running timers stands in for a browser that was closed.
        await page.clock.setSystemTime(
            (await page.evaluate(() => Date.now())) + 61 * 60 * 1000,
        );
        await page.reload();
        // The kept key was unused for longer than its lock, so loading the page forgets it.
        await expect(status).toHaveText("Locked");
    });

    test("a tab that joins an unlocked vault keeps only the remaining idle time", async ({
        page,
        context,
    }) => {
        // One fake clock for both tabs, so they agree on when the vault was last used.
        await context.clock.install();
        await page.goto(`${WEB_BASE_URL}/settings/vault`);
        await page.getByRole("button", { name: "Create vault" }).click();
        await createVaultInDialog(page);

        await context.clock.fastForward("14:00");
        const joined = await context.newPage();
        await joined.goto(`${WEB_BASE_URL}/settings/vault`);
        const status = joined.getByLabel("Vault status");
        // The new tab gets the keys from the open one instead of asking for an unlock.
        await expect(status).toHaveText("Unlocked");

        await page.close();
        await context.clock.fastForward("02:00");
        // Loading the tab was not a use, so the 15 minutes still count from the unlock.
        await expect(status).toHaveText("Locked");
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

        await page.reload();
        // The default 15 minutes keep the key in open tabs only, so the reload locks the vault and the editor waits for an unlock.
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
});
