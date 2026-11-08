import { expect, test } from "./fixtures";
import { ApiClient } from "#ui/api-client";

import {
    API_BASE_URL,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Pending transfers in the file list", () => {
    let ctx: TestContext;
    // A failed assertion must not leave the held-open upload running on the server.
    let uploadAbort: AbortController | null = null;

    test.beforeAll(async () => {
        ctx = await setupTestDir("pending-transfers");
    });

    test.afterEach(() => {
        uploadAbort?.abort();
        uploadAbort = null;
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("shows an incoming upload as a growing pending file and lists its staging entry", async ({
        page,
    }) => {
        const chunk = new Uint8Array(256 * 1024).fill(97);
        const totalBytes = chunk.length * 16;

        const client = new ApiClient(API_BASE_URL);
        await client.login("test-user", "test-password");
        const agents = await client.listAgents();
        const agent = agents.find((entry) => entry.id === ctx.agentId);

        if (!agent) {
            throw new Error("Test agent is not registered");
        }

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        // The listing must be loaded before the upload starts, so only the delayed relist can reveal staging.
        await expect(page.getByLabel("File entry file1.txt")).toBeVisible();

        const cookies = await page.context().cookies();

        const cookieHeader = cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");

        // The body stays open between writes, so the test decides when the upload progresses.
        const uploadBody = new TransformStream<Uint8Array, Uint8Array>();
        const writer = uploadBody.writable.getWriter();
        void writer.write(chunk);

        const abortController = new AbortController();
        uploadAbort = abortController;

        // Node needs half duplex to stream a request body; DOM typings do not know the option.
        const uploadOptions = {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(totalBytes),
                Cookie: cookieHeader,
            },
            body: uploadBody.readable,
            duplex: "half",
            signal: abortController.signal,
        };

        const uploadPromise = fetch(
            agent.getRawUrl(`${ctx.testDirPath}/incoming.bin`),
            uploadOptions,
        );

        const pendingRow = page.getByLabel("Pending file entry incoming.bin");
        // The transfer is shown under its final name before anything is published there.
        await expect(pendingRow).toBeVisible();
        await expect(pendingRow).toContainText("pending");

        const sizeCell = pendingRow.getByLabel("Size for incoming.bin");
        // The total comes from the transfer, so the row tells how big the file will be.
        await expect(sizeCell).toContainText("/ 4.0 MB");
        const initialSize = await sizeCell.textContent();

        void writer.write(chunk);
        void writer.write(chunk);
        // The size must grow while the upload runs, like the transfers view does.
        await expect
            .poll(() => sizeCell.textContent(), { timeout: 15_000 })
            .not.toBe(initialSize);

        // No reload was triggered, so only the relist after the transfer started can show the staging entry.
        await expect(
            page.getByLabel(/^File entry \.incoming\.bin\.redoor-/),
        ).toBeVisible();

        for (
            let sent = chunk.length * 3;
            sent < totalBytes;
            sent += chunk.length
        ) {
            void writer.write(chunk);
        }

        await writer.close();
        const response = await uploadPromise;
        // The upload must succeed so the published entry replaces the pending row.
        expect(response.ok).toBe(true);

        // Completion removes the placeholder and the real file takes its place.
        await expect(pendingRow).toHaveCount(0);
        await expect(page.getByLabel("File entry incoming.bin")).toBeVisible();
    });
});
