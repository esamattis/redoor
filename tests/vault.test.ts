import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { ApiClient, Agent } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import type { ApiErrorCode } from "#bindings/ApiErrorCode";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import {
    buildDestroy,
    buildNewVault,
    buildRotation,
    currentProof,
    fileKeyForHeader,
    newPassphraseKek,
    newWriteKeys,
    openGenerations,
    openPassphraseSlot,
    rewrapKeys,
    type UnlockedVault,
} from "#ui/vault/vault-keys";
import {
    deriveAuthProof,
    fromBase64Url,
    importVaultKey,
    toBase64Url,
} from "#ui/vault/vault-crypto";
import {
    ALL_PERMISSIONS,
    ProcessManager,
    TEST_APP_NAME,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    TempFileManager,
    createAccessToken,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "vault-test-agent";

const PASSPHRASE = "correct horse battery staple";

const MAGIC = Buffer.from("REDOORVAULT\0", "latin1");

/** The account's vault file, which every test starts without. */
const VAULT_PATH = join(
    TEST_SERVER_HOME,
    ".local/share",
    TEST_APP_NAME,
    "users",
    TEST_USERNAME,
    "vault.json",
);

/** The server's default log, where a leaked key would show up. */
const SERVER_LOG = join(
    TEST_SERVER_HOME,
    ".local/share",
    TEST_APP_NAME,
    "server.log",
);

/** The agent's log, written by the test harness. */
const AGENT_LOG = join(import.meta.dirname, "..", "log", `${AGENT_NAME}.log`);

/** Asserts that a call fails with the given vault error code and returns the error. */
async function expectCode(
    promise: Promise<unknown>,
    code: ApiErrorCode,
): Promise<ApiError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ApiError);

        if (error instanceof ApiError) {
            expect(error.code).toBe(code);

            return error;
        }
    }

    throw new Error(`expected the call to fail with ${code}`);
}

/** Splits a vault file into its preamble and payload. */
function splitVaultFile(bytes: Buffer) {
    const headerLength = bytes.readUInt16BE(13);
    const preambleLength = 15 + headerLength + 32;

    return {
        preamble: bytes.subarray(0, preambleLength),
        payload: bytes.subarray(preambleLength),
    };
}

describe("Vault", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let agent: Agent;
    let serverPid: number;

    beforeAll(async () => {
        fs.rmSync(VAULT_PATH, { force: true });

        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        apiClient = setup.apiClient;
        agent = setup.testAgent;
        serverPid = setup.serverPid;
    }, 30000);

    beforeEach(() => {
        // The vault is per account and the account is shared by every test.
        fs.rmSync(VAULT_PATH, { force: true });
        tempFiles.emptyDirs();
    });

    afterAll(async () => {
        await processManager.killAll();
        fs.rmSync(VAULT_PATH, { force: true });
        tempFiles.cleanup();
    });

    /** Creates a vault with one passphrase slot, as the browser would. */
    async function createVault(label = "test vault"): Promise<UnlockedVault> {
        const { request, vault } = await buildNewVault({
            label,
            passphrase: await newPassphraseKek(PASSPHRASE),
        });

        await apiClient.createVault(request);

        return vault;
    }

    /** Unlocks the installed vault with the passphrase, keeping the raw key for rewraps. */
    async function unlock(): Promise<{
        material: VaultUnlockMaterialResponse;
        vault: UnlockedVault;
        raw: Uint8Array<ArrayBuffer>;
    }> {
        const material = await apiClient.getVaultUnlockMaterial();
        const opened = await openPassphraseSlot(material, PASSPHRASE);

        return {
            material,
            vault: await openGenerations(material, opened.rawVaultKey),
            raw: opened.rawVaultKey,
        };
    }

    /** Rotates the vault, keeping only the passphrase slot. */
    async function rotate(): Promise<UnlockedVault> {
        const { material, vault, raw } = await unlock();
        const opened = await openPassphraseSlot(material, PASSPHRASE);

        const { request } = await buildRotation({
            material,
            vault,
            rawPrevious: raw,
            slots: [{ id: opened.slot.id, kek: opened.kek }],
        });

        await apiClient.rotateVault(request);

        return (await unlock()).vault;
    }

    /** Uploads plaintext encrypted to a new vault file and returns its path and file key. */
    async function encryptedFile(
        vault: UnlockedVault,
        content: string | Uint8Array<ArrayBuffer>,
        name = "secret.env.redoorvault",
    ): Promise<{ path: string; fileKey: string }> {
        const path = join(tempFiles.tempDirectory(), name);
        const keys = await newWriteKeys(vault);

        await agent.vaultUpload(path, { content: new Blob([content]), keys });

        return { path, fileKey: keys.fileKey };
    }

    /** Reads and decrypts a file through the editor endpoint. */
    async function readPlaintext(
        vault: UnlockedVault,
        path: string,
    ): Promise<{ content: Buffer; revision: string }> {
        const header = await agent.vaultHeader(path);
        const fileKey = await fileKeyForHeader(vault, header.header);
        const { response, revision } = await agent.vaultRead(path, fileKey);

        return {
            content: Buffer.from(await response.arrayBuffer()),
            revision,
        };
    }

    it("creates a vault once and serves unlock material separately from the status", async () => {
        // Before creation the status says there is no vault.
        expect((await apiClient.getVault()).vault).toBeNull();
        const vault = await createVault();
        const status = await apiClient.getVault();
        // The status names the current generation the browser derived.
        expect(status.vault?.current_key_id).toBe(vault.currentKeyId);
        // Ordinary status loads must not carry wrapped keys.
        expect(JSON.stringify(status)).not.toContain('"wrap"');
        const { vault: unlocked } = await unlock();
        // The passphrase unwraps the same key the browser created.
        expect(await currentProof(unlocked)).toBe(await currentProof(vault));
        const stat = fs.statSync(VAULT_PATH);
        // Wrapped keys stay private to the server's OS user.
        expect(stat.mode & 0o777).toBe(0o600);

        const { request } = await buildNewVault({
            label: "second",
            passphrase: await newPassphraseKek(PASSPHRASE),
        });

        // A second vault would orphan every file of the first.
        await expectCode(apiClient.createVault(request), "vault_exists");
    });

    it("requires a proof for slot changes and keeps the last passphrase slot", async () => {
        const vault = await createVault();
        const material = await apiClient.getVaultUnlockMaterial();
        const slotId = material.slots[0]?.id ?? "";
        const forged = toBase64Url(new Uint8Array(32));
        // A session without the vault key cannot rename or remove slots.
        await expectCode(
            apiClient.renameVaultSlot(slotId, {
                auth_proof: forged,
                label: "x",
            }),
            "vault_proof_invalid",
        );
        // The passphrase is the fallback on every hostname, so it cannot be removed.
        await expectCode(
            apiClient.removeVaultSlot(slotId, {
                auth_proof: await currentProof(vault),
            }),
            "vault_passphrase_required",
        );

        const renamed = await apiClient.renameVaultSlot(slotId, {
            auth_proof: await currentProof(vault),
            label: "Main passphrase",
        });

        // With the proof the change goes through.
        expect(renamed.vault?.slots[0]?.label).toBe("Main passphrase");
        // The first unlock of the day is recorded, the next one is not.
        expect((await apiClient.markVaultSlotUsed(slotId)).updated).toBe(true);
        expect((await apiClient.markVaultSlotUsed(slotId)).updated).toBe(false);
    });

    it("refuses to restore a backup over a vault without that vault's proof", async () => {
        const first = await createVault("first");
        const backup = await apiClient.exportVaultBackup();
        const firstProof = await currentProof(first);
        fs.rmSync(VAULT_PATH);
        const second = await createVault("second");
        // A stolen session must not be able to swap in a vault it controls.
        await expectCode(
            apiClient.restoreVaultBackup({
                backup,
                backup_auth_proof: firstProof,
                current_auth_proof: null,
            }),
            "vault_proof_invalid",
        );

        const restored = await apiClient.restoreVaultBackup({
            backup,
            backup_auth_proof: firstProof,
            current_auth_proof: await currentProof(second),
        });

        // With proofs for both vaults the backup is installed.
        expect(restored.vault?.label).toBe("first");
    });

    it("stores only ciphertext on the device and round trips through the editor endpoints", async () => {
        const vault = await createVault();
        const plaintext = "API_KEY=very-secret-value\n";
        const { path, fileKey } = await encryptedFile(vault, plaintext);
        const onDisk = fs.readFileSync(path);
        // The device holds a vault file, recognizable by its magic.
        expect(onDisk.subarray(0, 12).equals(MAGIC)).toBe(true);
        // No plaintext reaches the device.
        expect(onDisk.includes(Buffer.from("very-secret-value"))).toBe(false);
        const header = await agent.vaultHeader(path);
        // The header names this vault and the current generation.
        expect(header.header.vault_id).toBe(vault.vaultId);
        expect(header.key_status).toEqual({ status: "current" });
        expect(header.plaintext_size).toBe(Buffer.byteLength(plaintext));
        const read = await readPlaintext(vault, path);
        // Decryption returns exactly what was uploaded.
        expect(read.content.toString()).toBe(plaintext);
        // The read reports the revision a save must name.
        expect(read.revision).toBe(header.revision);

        const keys = await newWriteKeys(vault);

        const saved = await agent.vaultSave(path, {
            content: new Blob(["API_KEY=rotated\n"]),
            keys: keys,
            expectedRevision: read.revision,
        });

        // A save replaces the file, so its revision changes.
        expect(saved.revision).not.toBe(read.revision);
        expect((await readPlaintext(vault, path)).content.toString()).toBe(
            "API_KEY=rotated\n",
        );
        const agentLog = fs.readFileSync(AGENT_LOG, "utf8");

        // The agent never receives a key in any form.
        for (const key of [fileKey, keys.fileKey]) {
            expect(agentLog).not.toContain(key);
            expect(agentLog).not.toContain(
                Buffer.from(fromBase64Url(key)).toString("hex"),
            );
        }
    });

    it("refuses a save over a version that changed on the device", async () => {
        const vault = await createVault();
        const { path } = await encryptedFile(vault, "one");
        const read = await readPlaintext(vault, path);
        const changed = await newWriteKeys(vault);
        await agent.vaultSave(path, {
            content: new Blob(["two"]),
            keys: changed,
            expectedRevision: read.revision,
        });
        // The first editor still holds the old revision, so its save must conflict.
        await expectCode(
            agent.vaultSave(path, {
                content: new Blob(["stale"]),
                keys: await newWriteKeys(vault),
                expectedRevision: read.revision,
            }),
            "vault_file_changed",
        );
        // The newer version survives the refused save.
        expect((await readPlaintext(vault, path)).content.toString()).toBe(
            "two",
        );
    });

    it("leaves the previous file intact when a save fails midway", async () => {
        const vault = await createVault();
        const { path } = await encryptedFile(vault, "original");
        const before = fs.readFileSync(path);
        const read = await readPlaintext(vault, path);
        const keys = await newWriteKeys(vault);

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(1000));
                controller.error(new Error("client went away"));
            },
        });

        const requestOptions = {
            method: "PUT",
            headers: {
                ...agent.getAuthHeaders(),
                "Content-Length": "200000",
                "Redoor-Vault-Key": keys.fileKey,
                "Redoor-Vault-Key-Id": keys.keyId,
                "Redoor-Vault-Wrap-Iv": keys.wrap.iv,
                "Redoor-Vault-Wrap-Ct": keys.wrap.ct,
                "Redoor-Vault-Revision": read.revision,
            },
            body,
            duplex: "half",
        };

        const failed = await fetch(
            `${apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(agent.id)}/vault/edit${path}`,
            requestOptions,
        ).catch(() => null);

        // Whether or not a response arrives, it must not report success.
        expect(failed?.ok ?? false).toBe(false);
        // The staging was discarded and the old file was never touched.
        expect(fs.readFileSync(path).equals(before)).toBe(true);
    });

    it("streams a decrypted download larger than the stream window", async () => {
        const vault = await createVault();
        const content = Buffer.alloc(3 * 1024 * 1024 + 123);

        for (let index = 0; index < content.length; index++) {
            content[index] = (index * 7 + (index >> 12)) & 0xff;
        }

        const { path } = await encryptedFile(
            vault,
            content,
            "big.bin.redoorvault",
        );

        const header = await agent.vaultHeader(path);
        const fileKey = await fileKeyForHeader(vault, header.header);
        const form = new URLSearchParams({ path, file_key: fileKey });

        const crossSite = await fetch(agent.getVaultDownloadUrl(), {
            method: "POST",
            headers: {
                ...agent.getAuthHeaders(),
                Origin: "https://attacker.example",
            },
            body: form,
        });

        // A form post from another site must not decrypt with the user's cookies.
        expect(crossSite.status).toBe(403);

        const response = await fetch(agent.getVaultDownloadUrl(), {
            method: "POST",
            headers: {
                ...agent.getAuthHeaders(),
                Origin: apiClient.baseUrl,
                "Sec-Fetch-Site": "same-origin",
            },
            body: form,
        });

        // The saved file drops the vault suffix.
        expect(response.headers.get("content-disposition")).toContain(
            'filename="big.bin"',
        );
        // Content-Length is the computed plaintext size.
        expect(Number(response.headers.get("content-length"))).toBe(
            content.length,
        );
        // Every byte decrypts back across chunk boundaries.
        expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(
            true,
        );
    });

    it("reports each format error with its own code", async () => {
        const vault = await createVault();
        const directory = tempFiles.tempDirectory();
        const plain = join(directory, "plain.redoorvault");
        fs.writeFileSync(plain, "just text");
        // A file without the magic is not a vault file.
        await expectCode(agent.vaultHeader(plain), "not_a_vault_file");
        const { path } = await encryptedFile(vault, "payload");
        const good = fs.readFileSync(path);
        const newer = join(directory, "newer.redoorvault");
        const newerBytes = Buffer.from(good);
        newerBytes[12] = 2;
        fs.writeFileSync(newer, newerBytes);
        // A newer format version is named as such.
        await expectCode(agent.vaultHeader(newer), "vault_format_unsupported");
        const corrupt = join(directory, "corrupt.redoorvault");
        const corruptBytes = Buffer.from(good);
        corruptBytes[15] = "]".charCodeAt(0);
        fs.writeFileSync(corrupt, corruptBytes);
        // A header that is not JSON is corrupted.
        await expectCode(agent.vaultHeader(corrupt), "vault_header_corrupted");
        const truncated = join(directory, "truncated.redoorvault");
        // "payload" encrypts to 23 payload bytes; 13 are less than one tag.
        fs.writeFileSync(truncated, good.subarray(0, good.length - 10));
        // A payload length no encryption produces is truncation.
        await expectCode(
            agent.vaultHeader(truncated),
            "vault_payload_corrupted",
        );
        const tampered = join(directory, "tampered.redoorvault");
        const tamperedBytes = Buffer.from(good);
        tamperedBytes.writeUInt8(
            tamperedBytes.readUInt8(tamperedBytes.length - 1) ^ 1,
            tamperedBytes.length - 1,
        );
        fs.writeFileSync(tampered, tamperedBytes);

        const tamperedKey = await fileKeyForHeader(
            vault,
            (await agent.vaultHeader(tampered)).header,
        );

        const outcome = await agent
            .vaultRead(tampered, tamperedKey)
            .then(({ response }) => response.arrayBuffer())
            .then(
                () => "complete",
                () => "aborted",
            );

        // A chunk failing after the response started aborts it, so a damaged file never
        // looks like a complete one.
        expect(outcome).toBe("aborted");
        const otherKey = (await newWriteKeys(vault)).fileKey;
        // The wrong file key fails the header MAC before any plaintext.
        await expectCode(
            agent.vaultRead(path, otherKey),
            "vault_header_tampered",
        );
        // A malformed key is refused before the device is contacted.
        await expectCode(
            agent.vaultRead(path, "short"),
            "invalid_vault_file_key",
        );
        const notVault = join(directory, "notes.txt");
        fs.writeFileSync(notVault, "x");
        // The vault endpoints only accept vault paths.
        await expectCode(agent.vaultHeader(notVault), "not_a_vault_path");
    });

    it("names files of another vault and of unknown generations", async () => {
        const first = await createVault("first vault");
        const { path } = await encryptedFile(first, "first");
        const firstBackup = await apiClient.exportVaultBackup();
        const firstProof = await currentProof(first);
        fs.rmSync(VAULT_PATH);
        const second = await createVault("second vault");
        const header = await agent.vaultHeader(path);
        // Header reads work for foreign files and classify them.
        expect(header.key_status).toEqual({ status: "foreign_vault" });

        const foreign = await expectCode(
            agent.vaultRead(path, await fileKeyForHeader(first, header.header)),
            "foreign_vault",
        );

        // The message names the other vault so the user knows which one to unlock.
        expect(foreign.message).toContain("first vault");

        await apiClient.restoreVaultBackup({
            backup: firstBackup,
            backup_auth_proof: firstProof,
            current_auth_proof: await currentProof(second),
        });

        const rotated = await rotate();

        const { path: newerPath } = await encryptedFile(
            rotated,
            "newer",
            "newer.redoorvault",
        );

        const newerKey = await fileKeyForHeader(
            rotated,
            (await agent.vaultHeader(newerPath)).header,
        );

        await apiClient.restoreVaultBackup({
            backup: firstBackup,
            backup_auth_proof: firstProof,
            current_auth_proof: await currentProof(rotated),
        });

        // An older backup does not know the newer generation.
        await expectCode(
            agent.vaultRead(newerPath, newerKey),
            "unknown_vault_key",
        );
    });

    it("rejects writes with a generation that was rotated away", async () => {
        const vault = await createVault();
        const { path } = await encryptedFile(vault, "before rotation");
        const read = await readPlaintext(vault, path);
        await rotate();
        // A tab that missed the rotation must unlock again before writing.
        await expectCode(
            agent.vaultSave(path, {
                content: new Blob(["after"]),
                keys: await newWriteKeys(vault),
                expectedRevision: read.revision,
            }),
            "stale_vault_key",
        );
    });

    it("opens older generations and moves files forward by rewrap and re-encryption", async () => {
        const original = await createVault();

        const rewrapped = await encryptedFile(
            original,
            "rewrap me",
            "a.redoorvault",
        );

        const reencrypted = await encryptedFile(
            original,
            "reencrypt me",
            "b.redoorvault",
        );

        const vault = await rotate();
        const before = await agent.vaultHeader(rewrapped.path);
        // A file on the previous generation is reported as older.
        expect(before.key_status).toEqual({ status: "older" });
        // The chain unwraps the previous generation, so the file still opens.
        expect(
            (await readPlaintext(vault, rewrapped.path)).content.toString(),
        ).toBe("rewrap me");

        const payloadBefore = splitVaultFile(
            fs.readFileSync(rewrapped.path),
        ).payload;

        const keys = await rewrapKeys(vault, before.header);

        const request = {
            file_key: keys.fileKey,
            key_id: keys.keyId,
            wrap: keys.wrap,
            expected_revision: before.revision,
        };

        await agent.vaultRewrap(rewrapped.path, request);
        // A second rewrap with the old revision is a conflict, never an overwrite.
        await expectCode(
            agent.vaultRewrap(rewrapped.path, request),
            "vault_file_changed",
        );
        const after = await agent.vaultHeader(rewrapped.path);
        // The header moved to the current generation.
        expect(after.key_status).toEqual({ status: "current" });
        // A rewrap copies the payload bytes without decrypting.
        expect(
            splitVaultFile(fs.readFileSync(rewrapped.path)).payload.equals(
                payloadBefore,
            ),
        ).toBe(true);
        expect(
            (await readPlaintext(vault, rewrapped.path)).content.toString(),
        ).toBe("rewrap me");

        const oldHeader = await agent.vaultHeader(reencrypted.path);

        const oldPayload = splitVaultFile(
            fs.readFileSync(reencrypted.path),
        ).payload;

        const fresh = await newWriteKeys(vault);

        await agent.vaultReencrypt(reencrypted.path, {
            file_key: await fileKeyForHeader(vault, oldHeader.header),
            new_file_key: fresh.fileKey,
            key_id: fresh.keyId,
            wrap: fresh.wrap,
            expected_revision: oldHeader.revision,
        });

        // Re-encryption writes a new payload under a new file key.
        expect(
            splitVaultFile(fs.readFileSync(reencrypted.path)).payload.equals(
                oldPayload,
            ),
        ).toBe(false);
        expect(
            (await readPlaintext(vault, reencrypted.path)).content.toString(),
        ).toBe("reencrypt me");
    });

    it("keeps older generations openable when a middle one is destroyed", async () => {
        const first = await createVault();

        const oldest = await encryptedFile(
            first,
            "oldest",
            "oldest.redoorvault",
        );

        const middleVault = await rotate();

        const middle = await encryptedFile(
            middleVault,
            "middle",
            "middle.redoorvault",
        );

        await rotate();
        const { material, vault } = await unlock();
        const forged = toBase64Url(new Uint8Array(32));

        const destroy = await buildDestroy({
            material,
            vault,
            keyId: middleVault.currentKeyId,
        });

        // Destroying a generation needs the proof like every vault change.
        await expectCode(
            apiClient.destroyVaultKey(middleVault.currentKeyId, {
                ...destroy,
                auth_proof: forged,
            }),
            "vault_proof_invalid",
        );
        await apiClient.destroyVaultKey(middleVault.currentKeyId, destroy);
        const reopened = (await unlock()).vault;
        // The oldest generation is reachable through the relinked chain.
        expect(
            (await readPlaintext(reopened, oldest.path)).content.toString(),
        ).toBe("oldest");
        const header = await agent.vaultHeader(middle.path);
        // Files on the destroyed generation report when it was destroyed.
        expect(header.key_status.status).toBe("retired");
        await expectCode(
            agent.vaultRead(middle.path, middle.fileKey),
            "retired_vault_key",
        );
    });

    it("denies every vault route to access tokens", async () => {
        const vault = await createVault();
        const { path, fileKey } = await encryptedFile(vault, "token test");

        const { token } = await createAccessToken(apiClient, {
            permissions: ALL_PERMISSIONS,
        });

        const tokenClient = new ApiClient(apiClient.baseUrl);
        tokenClient.setAccessToken(token);

        const tokenAgent = (await tokenClient.listAgents()).find(
            (entry) => entry.id === agent.id,
        );

        if (!tokenAgent) {
            throw new Error("the token sees the agent");
        }

        const proof = { auth_proof: await currentProof(vault) };
        const keys = await newWriteKeys(vault);

        const attempts: [string, () => Promise<object>][] = [
            ["status", () => tokenClient.getVault()],
            ["unlock material", () => tokenClient.getVaultUnlockMaterial()],
            ["backup", () => tokenClient.exportVaultBackup()],
            ["rename", () => tokenClient.updateVault({ ...proof, label: "x" })],
            ["header", () => tokenAgent.vaultHeader(path)],
            ["read", () => tokenAgent.vaultRead(path, fileKey)],
            [
                "save",
                () =>
                    tokenAgent.vaultSave(path, {
                        content: new Blob(["x"]),
                        keys: keys,
                        expectedRevision: "r",
                    }),
            ],
            [
                "upload",
                () =>
                    tokenAgent.vaultUpload(`${path}.2.redoorvault`, {
                        content: new Blob(["x"]),
                        keys: keys,
                    }),
            ],
        ];

        for (const [name, attempt] of attempts) {
            const status = await attempt().then(
                () => 200,
                (error: Error) =>
                    error instanceof ApiError ? error.status : 0,
            );

            // Tokens and MCP clients may copy ciphertext but never decrypt or change the vault.
            expect([401, 403, 404], name).toContain(status);
        }
    });

    it("never writes a file key or proof to the server log", async () => {
        const vault = await createVault();
        const { path, fileKey } = await encryptedFile(vault, "log test");
        await readPlaintext(vault, path);
        const proof = await currentProof(vault);

        const logs = [
            processManager.getStdout(serverPid),
            fs.existsSync(SERVER_LOG)
                ? fs.readFileSync(SERVER_LOG, "utf8")
                : "",
        ].join("\n");

        // Keys and proofs travel in headers and bodies, which are never logged.
        for (const secret of [fileKey, proof]) {
            expect(logs).not.toContain(secret);
        }

        // The proof derivation is deterministic, so a non-extractable copy gives the same proof.
        const raw = (await unlock()).raw;
        expect(await deriveAuthProof(await importVaultKey(raw))).toBe(proof);
    });
});
