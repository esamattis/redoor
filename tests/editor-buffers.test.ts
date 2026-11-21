import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ApiClient } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import {
    ProcessManager,
    TEST_APP_NAME,
    TEST_PASSWORD,
    TEST_SERVER_HOME,
    TEST_USERNAME,
    VITEST_SERVER_PORT,
    waitForPort,
} from "./test-utils";

const processManager = new ProcessManager();

const baseUrl = `http://127.0.0.1:${VITEST_SERVER_PORT}`;

/** Where the server keeps this account's buffers, in their own directory. */
function buffersDirectory() {
    return join(
        TEST_SERVER_HOME,
        ".local/share",
        TEST_APP_NAME,
        "users",
        TEST_USERNAME,
        "editor-buffers",
    );
}

/** Lists the stored buffer files, ignoring temporary files of atomic writes. */
function bufferFiles() {
    return readdirSync(buffersDirectory()).filter((name) =>
        name.endsWith(".json"),
    );
}

/** Logs in as the test account, since buffers belong to a browser session. */
async function loggedInClient() {
    const api = new ApiClient(baseUrl);
    await api.login(TEST_USERNAME, TEST_PASSWORD);

    return api;
}

/** Lists files as open in the user state, which is what keeps their buffers. */
async function setOpenFiles(api: ApiClient, keys: string[]) {
    await api.updateUserState({
        state: {
            openFiles: keys.map((key) => {
                const separator = key.indexOf(":");

                return {
                    agentId: key.slice(0, separator),
                    path: key.slice(separator + 1),
                    name: key,
                    agentName: "test device",
                };
            }),
        },
    });
}

/** Captures the API error of a request that is expected to fail. */
async function expectApiError(request: Promise<unknown>) {
    const error = await request.then(
        () => null,
        (cause: unknown) => cause,
    );

    if (!(error instanceof ApiError)) {
        throw new Error(`Expected an ApiError, got ${String(error)}`);
    }

    return error;
}

beforeAll(async () => {
    process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
    processManager.spawnServer({});
    await waitForPort(VITEST_SERVER_PORT);
});

afterAll(() => processManager.killAll());

describe("editor buffers", () => {
    it("requires a browser session", async () => {
        const response = await fetch(
            `${baseUrl}/api/v1/user/editor-buffers/YQ`,
        );

        // Buffers hold unsaved file contents, so anonymous callers must be refused.
        expect(response.status).toBe(401);
    });

    it("stores, reads and deletes a buffer with a new version on every write", async () => {
        const api = await loggedInClient();
        const key = `agent-1:/home/user/project/src/main ${Date.now()}.rs`;
        await setOpenFiles(api, [key]);

        // A never-edited file has no buffer, which is not an error.
        expect(await api.getEditorBuffer(key)).toEqual({ key, buffer: null });

        const first = await api.putEditorBuffer(key, {
            data: { doc: "fn main() {}" },
        });

        // A write returns the version the server assigned to it.
        expect(first.key).toBe(key);
        expect(first.version).toBeGreaterThan(0);

        const second = await api.putEditorBuffer(key, {
            data: { doc: "fn main() { }" },
        });

        // Every write gets a new, larger version, even within the same millisecond.
        expect(second.version).toBeGreaterThan(first.version);

        // A read returns the latest data with the version of the write that stored it.
        expect((await api.getEditorBuffer(key)).buffer).toEqual({
            version: second.version,
            data: { doc: "fn main() { }" },
        });

        // File names are hashes, so a path in the key can never become a path on disk.
        expect(
            bufferFiles().every((name) => /^[0-9a-f]{64}\.json$/.test(name)),
        ).toBe(true);
        // Buffers carry unsaved file contents, so other local users must not read them.
        expect(statSync(buffersDirectory()).mode & 0o777).toBe(0o700);

        // Closing a file deletes its buffer.
        expect(await api.deleteEditorBuffer(key)).toEqual({
            key,
            deleted: true,
        });
        // The buffer is gone afterwards.
        expect((await api.getEditorBuffer(key)).buffer).toBeNull();
        // Deleting again reports that nothing was stored instead of failing.
        expect(await api.deleteEditorBuffer(key)).toEqual({
            key,
            deleted: false,
        });

        const rewritten = await api.putEditorBuffer(key, {
            data: { doc: "again" },
        });

        // A buffer written again after a delete never repeats a version a browser saw.
        expect(rewritten.version).toBeGreaterThan(second.version);
        await api.deleteEditorBuffer(key);
    });

    it("lets the last write win", async () => {
        const api = await loggedInClient();
        const key = `agent-1:/tmp/last-writer-${Date.now()}.txt`;
        await setOpenFiles(api, [key]);

        await api.putEditorBuffer(key, { data: { doc: "from computer A" } });

        const fromB = await api.putEditorBuffer(key, {
            data: { doc: "from computer B" },
        });

        // There are no revision checks: the latest write is what a read returns.
        expect((await api.getEditorBuffer(key)).buffer).toEqual({
            version: fromB.version,
            data: { doc: "from computer B" },
        });

        await api.deleteEditorBuffer(key);
    });

    it("deletes the buffers of files the user state no longer lists as open", async () => {
        const api = await loggedInClient();
        const kept = `agent-1:/tmp/kept-${Date.now()}.txt`;
        const closed = `agent-2:/tmp/closed-${Date.now()}.txt`;
        await setOpenFiles(api, [kept, closed]);

        for (const key of [kept, closed]) {
            await api.putEditorBuffer(key, { data: { doc: key } });
        }

        // Closing one file in any browser replaces the open files list without it.
        await setOpenFiles(api, [kept]);
        // The closed file's buffer is deleted by the server, even if no browser deleted it.
        expect((await api.getEditorBuffer(closed)).buffer).toBeNull();
        // Buffers of files that stay open are untouched.
        expect((await api.getEditorBuffer(kept)).buffer).toMatchObject({
            data: { doc: kept },
        });

        await setOpenFiles(api, []);
        // Clearing the list removes every remaining buffer file.
        expect(bufferFiles()).toEqual([]);
    });

    it("rejects keys that are not base64url or are not printable", async () => {
        const api = await loggedInClient();

        const invalid = await fetch(
            `${baseUrl}/api/v1/user/editor-buffers/not%20base64`,
            { headers: api.getAuthHeaders() },
        );

        // Keys must be encoded, so raw path text never reaches the server's file names.
        expect(invalid.status).toBe(400);

        const control = await expectApiError(api.getEditorBuffer("a\nb"));
        // Control characters are rejected so keys stay printable identifiers.
        expect(control.status).toBe(400);
    });

    it("accepts payloads above the default body limit but caps them", async () => {
        const api = await loggedInClient();
        const key = `agent-1:/tmp/large-${Date.now()}.txt`;
        await setOpenFiles(api, [key]);

        const written = await api.putEditorBuffer(key, {
            data: { doc: "x".repeat(3 * 1024 * 1024) },
        });

        // A 3 MiB buffer must fit, since editable files alone may be 2 MiB.
        expect(written.version).toBeGreaterThan(0);

        const tooLarge = await expectApiError(
            api.putEditorBuffer(key, {
                data: { doc: "x".repeat(9 * 1024 * 1024) },
            }),
        );

        // Payloads past the 8 MiB cap are refused before they reach the disk.
        expect(tooLarge.status).toBe(413);
        await api.deleteEditorBuffer(key);
        // No temporary file of an atomic write is left behind.
        expect(
            readdirSync(buffersDirectory()).some((name) =>
                name.endsWith(".tmp"),
            ),
        ).toBe(false);
    });
});
