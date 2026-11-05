import { expect, onTestFinished, test, vi } from "vitest";

import type { ContentGrepEvent } from "#bindings/ContentGrepEvent";
import type { ContentGrepMatch } from "#bindings/ContentGrepMatch";
import type { FileSearchEvent } from "#bindings/FileSearchEvent";
import { streamNdjson } from "#ui/api-transport";
import { reduceContentGrepEvents, reduceFileSearchEvents } from "#ui/queries";

/** A path match whose name is its path. */
function pathMatch(path: string, score: number): FileSearchEvent {
    return {
        type: "match",
        entry: { name: path, path, type: "file", score },
    };
}

/** A content match on line one of `path`. */
function contentMatch(path: string): ContentGrepMatch {
    return {
        path,
        line_number: 1,
        line: "needle",
        line_truncated: false,
        before_context: [],
        after_context: [],
    };
}

test("path search events re-rank streamed matches and keep the best 100", () => {
    let response = reduceFileSearchEvents(
        { results: [], timed_out: false, duration_ms: 0 },
        Array.from({ length: 100 }, (_, index) =>
            pathMatch(`/f${String(index).padStart(3, "0")}`, 10),
        ),
    );

    response = reduceFileSearchEvents(response, [
        pathMatch("/better", 11),
        pathMatch("/worse", 9),
        { type: "done", timed_out: true, duration_ms: 42 },
    ]);

    // A better match arriving later moves to the top, as on the device.
    expect(response.results[0]?.path).toBe("/better");
    // The list keeps the device's limit, dropping the weakest equal-score path.
    expect(response.results).toHaveLength(100);
    expect(response.results.at(-1)?.path).toBe("/f098");
    // A weaker match never enters a full list.
    expect(response.results.some((entry) => entry.path === "/worse")).toBe(
        false,
    );
    // `done` fills the summary.
    expect(response).toMatchObject({ timed_out: true, duration_ms: 42 });
});

test("content search events append matches in the order found", () => {
    const events: ContentGrepEvent[] = [
        { type: "match", entry: contentMatch("/b") },
        { type: "match", entry: contentMatch("/a") },
        {
            type: "done",
            timed_out: false,
            cancelled: false,
            truncated: true,
            omitted_long_lines: 3,
            duration_ms: 5,
        },
    ];

    const response = reduceContentGrepEvents(
        {
            results: [contentMatch("/c")],
            timed_out: false,
            cancelled: false,
            truncated: false,
            omitted_long_lines: 0,
            duration_ms: 0,
        },
        events,
    );

    // Content matches keep the order the device found them in.
    expect(response.results.map((entry) => entry.path)).toEqual([
        "/c",
        "/b",
        "/a",
    ]);
    // `done` replaces the summary.
    expect(response).toMatchObject({ truncated: true, omitted_long_lines: 3 });
});

test("NDJSON lines split across chunks are yielded once complete", async () => {
    const encoder = new TextEncoder();
    const chunks = ['{"n":1}\n{"n"', ":2}", '\n{"n":3}\n'];

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
        },
    });

    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => {
        vi.unstubAllGlobals();
    });

    const batches: { n: number }[][] = [];

    for await (const batch of streamNdjson<{ n: number }>("http://x/s", {})) {
        batches.push(batch);
    }

    // Each batch holds only whole lines, and a chunk that completes none yields nothing.
    expect(batches).toEqual([[{ n: 1 }], [{ n: 2 }, { n: 3 }]]);
});
