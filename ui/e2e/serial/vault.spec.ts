// Serial: the vault belongs to the one test account, so creating, unlocking or rotating it
// changes state every other spec would share.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
    deviceBrowserUrl,
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
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
            fs.rm(
                path.join(
                    SERVER_SHARE,
                    app,
                    "users",
                    "test-user",
                    "vault.json",
                ),
                {
                    force: true,
                },
            ),
        ),
    );
}

/** Creates a vault through the dialog that the first encrypted file opens. */
async function createVaultInDialog(page: Page, keep = false) {
    const dialog = page.getByRole("dialog", { name: "Create vault" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel("Repeat passphrase").fill(PASSPHRASE);

    if (keep) {
        await dialog
            .getByRole("checkbox", { name: "Keep unlocked on this device" })
            .click();
    }

    await dialog.getByRole("button", { name: "Create vault" }).click();
    // Argon2id takes a moment; the dialog closes once the vault exists and is unlocked.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
}

/** Unlocks with the passphrase in the shared vault dialog. */
async function unlockInDialog(
    page: Page,
    keep = false,
    passphrase = PASSPHRASE,
) {
    const dialog = page.getByRole("dialog", { name: "Unlock vault" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Passphrase", { exact: true }).fill(passphrase);

    if (keep) {
        await dialog
            .getByRole("checkbox", { name: "Keep unlocked on this device" })
            .click();
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
        // Agent-side search would send the decrypted selection to the device.
        await expect(
            page.getByRole("button", { name: "Search selected text" }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Save file" }).click();
        // The save went through the encrypted write endpoint.
        await expect(page.getByText("Saved", { exact: true })).toBeVisible();
        const onDisk = await fs.readFile(filePath);
        // The device holds an encrypted file, never the plaintext.
        expect(onDisk.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
        expect(onDisk.includes(Buffer.from("very-secret"))).toBe(false);

        await page.reload();
        // Without "keep unlocked" a reload locks the vault, so the editor asks first.
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
        await page
            .getByLabel("Choose files to encrypt and upload")
            .setInputFiles({
                name: "notes.txt",
                mimeType: "text/plain",
                buffer: Buffer.from("uploaded plaintext"),
            });
        // The reload locked the vault again, so the encrypted upload asks for it first.
        await unlockInDialog(page);

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
        await createVaultInDialog(page, true);
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
        await unlockInDialog(page, true);
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
        await createVaultInDialog(page, true);
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
        // Without "keep unlocked" the reload locks the vault, so the editor waits for an unlock.
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
        await unlockInDialog(page, false, generated);
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
