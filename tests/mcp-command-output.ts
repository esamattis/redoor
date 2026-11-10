import { expect, it } from "vitest";

import { type JsonObject, createMcpTestClient } from "./mcp-client";

/** The live MCP fixture the command output tests run against. */
type McpCommandOutputFixture = {
    endpoint: string;
    /** Creates a fresh operator token, since paging spends the per-token request budget. */
    createToken: () => Promise<string>;
    device: string;
    cwd: string;
};

/**
 * Registers the command output tests on the main MCP fixture. They must run before tests
 * that exhaust the suite's global retention quota, so the caller decides where they go.
 */
export function registerMcpCommandOutputTests(
    options: McpCommandOutputFixture,
): void {
    it("returns decoded command output inline and pages it per stream", async () => {
        // Own credentials, because paging spends the per-token request budget.
        const client = createMcpTestClient({
            endpoint: options.endpoint,
            token: await options.createToken(),
        });

        type CommandOutput = JsonObject & {
            operation_id: string;
            stdout?: string;
            stderr?: string;
            binary: boolean;
            more: boolean;
            next_offsets: { stdout?: number; stderr?: number };
            omitted_bytes: { stdout?: number; stderr?: number };
        };

        /** Runs one foreground command and returns its full MCP result. */
        const run = (script: string) =>
            client.callTool<CommandOutput>("run_command", {
                device_id: options.device,
                argv: ["sh", "-c", script],
                cwd: options.cwd,
            });

        /** Returns the structured content of a result, failing loudly when it is missing. */
        const content = (response: Awaited<ReturnType<typeof run>>) => {
            const structured = response.result.structuredContent;

            if (structured === undefined)
                throw new Error("Structured content missing");

            return structured;
        };

        const inline = await run(
            "printf 'out line\\n'; printf 'err line\\n' >&2; exit 3",
        );

        // One foreground call returns the status and both pipes as decoded text.
        expect(content(inline)).toMatchObject({
            state: "completed",
            termination: { type: "exit", code: 3 },
            stdout: "out line\n",
            stderr: "err line\n",
            binary: false,
            truncated: false,
            more: false,
        });
        // Clients that only show the text block still give the model the whole result.
        expect(inline.result.content).toEqual([
            {
                type: "text",
                text: `exit code 3 (operation ${content(inline).operation_id})
--- stdout ---
out line
--- stderr ---
err line
`,
            },
        ]);

        const long = await run("seq 1 2000");
        const longOutput = content(long);

        const fullLength =
            Array.from({ length: 2000 }, (_, index) => `${index + 1}\n`).join(
                "",
            ).length;

        // Half of the 256-byte stdout share keeps the start of the output.
        expect(longOutput.stdout?.startsWith("1\n2\n3\n")).toBe(true);
        // The rest keeps the end, where errors usually are.
        expect(longOutput.stdout?.endsWith("1999\n2000\n")).toBe(true);
        // The gap between head and tail is marked with the exact omitted byte count.
        expect(longOutput.stdout).toContain(
            `[... ${fullLength - 256} bytes omitted ...]`,
        );
        expect(longOutput).toMatchObject({
            truncated: true,
            omitted_bytes: { stdout: fullLength - 256, stderr: 0 },
        });
        // The text block shows the same marker to the model.
        expect(JSON.stringify(long.result.content)).toContain("bytes omitted");

        const paged = await run("printf abcdefghij; printf KLMNOPQRST >&2");
        const operationId = content(paged).operation_id;

        const stdoutPage = await client.callTool<CommandOutput>(
            "read_command_output",
            { operation_id: operationId, stream: "stdout", limit: 4 },
        );

        // A single-stream page carries only that pipe and its next offset.
        expect(stdoutPage.result.structuredContent).toMatchObject({
            stdout: "abcd",
            next_offsets: { stdout: 4 },
            more: true,
        });
        // The other pipe is left out entirely rather than shown empty.
        expect(stdoutPage.result.structuredContent?.stderr).toBeUndefined();

        const bothPage = await client.callTool<CommandOutput>(
            "read_command_output",
            {
                operation_id: operationId,
                stdout_offset: 8,
                stderr_offset: 6,
                limit: 16,
            },
        );

        // Each pipe continues from its own offset in one call.
        expect(bothPage.result.structuredContent).toMatchObject({
            stdout: "ij",
            stderr: "QRST",
            next_offsets: { stdout: 10, stderr: 10 },
            more: false,
        });

        const text = "aé€😀".repeat(6);
        const utf8 = await run(`printf '%s' '${text}'`);
        let offset = 0;
        let rebuilt = "";

        for (;;) {
            const page = await client.callTool<CommandOutput>(
                "read_command_output",
                {
                    operation_id: content(utf8).operation_id,
                    stream: "stdout",
                    stdout_offset: offset,
                    limit: 5,
                },
            );

            const pageContent = page.result.structuredContent;

            if (pageContent === undefined) throw new Error("Page missing");

            // A five-byte page would split most characters; the cut must back off instead.
            expect(pageContent.stdout).not.toContain("\uFFFD");
            // Clean cuts never set the binary flag.
            expect(pageContent.binary).toBe(false);
            rebuilt += pageContent.stdout ?? "";
            offset = pageContent.next_offsets.stdout ?? offset;

            if (!pageContent.more) break;
        }

        // The pages together are exactly the command's output.
        expect(rebuilt).toBe(text);

        const binary = await run("printf '\\377ok'");

        // Invalid UTF-8 is replaced and flagged instead of being base64 encoded.
        expect(content(binary)).toMatchObject({
            stdout: "\uFFFDok",
            binary: true,
        });
    }, 30_000);
}
