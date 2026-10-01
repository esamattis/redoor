import { expect, test } from "vitest";

import { moveKeyedItems, moveKeyedSubsequence } from "#ui/utils/reorder";

const keyOf = (item: { id: string }) => item.id;

test("inserts upward and downward without swapping only the endpoints", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

    // Moving the third item to the first shifts the intervening items.
    expect(
        moveKeyedItems(items, keyOf, { activeId: "c", overId: "a" }).map(
            (item) => item.id,
        ),
    ).toEqual(["c", "a", "b", "d"]);
    // Moving the first item onto the third lands after that target.
    expect(
        moveKeyedItems(items, keyOf, { activeId: "a", overId: "c" }).map(
            (item) => item.id,
        ),
    ).toEqual(["b", "c", "a", "d"]);
});

test("moves the ends of a list through the intervening items", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(
        moveKeyedItems(items, keyOf, { activeId: "a", overId: "c" }).map(
            (item) => item.id,
        ),
    ).toEqual(["b", "c", "a"]);
    expect(
        moveKeyedItems(items, keyOf, { activeId: "c", overId: "a" }).map(
            (item) => item.id,
        ),
    ).toEqual(["c", "a", "b"]);
});

test("returns the same array for empty, single, missing, and identical moves", () => {
    const empty: { id: string }[] = [];
    const single = [{ id: "a" }];
    const items = [{ id: "a" }, { id: "b" }];

    // A no-op must keep identity so preference updates can skip a write.
    expect(moveKeyedItems(empty, keyOf, { activeId: "a", overId: "b" })).toBe(
        empty,
    );
    expect(moveKeyedItems(single, keyOf, { activeId: "a", overId: "a" })).toBe(
        single,
    );
    expect(moveKeyedItems(items, keyOf, { activeId: "a", overId: "a" })).toBe(
        items,
    );
    expect(
        moveKeyedItems(items, keyOf, { activeId: "missing", overId: "a" }),
    ).toBe(items);
    expect(
        moveKeyedItems(items, keyOf, { activeId: "a", overId: "missing" }),
    ).toBe(items);
});

test("reuses item objects and preserves metadata", () => {
    const first = { id: "a", name: "Alpha" };
    const second = { id: "b", name: "Beta" };
    const moved = moveKeyedItems([first, second], keyOf, {
        activeId: "b",
        overId: "a",
    });

    expect(moved[0]).toBe(second);
    expect(moved[1]).toBe(first);
});

test("moves one interleaved scope without disturbing the other", () => {
    const items = [
        { id: "a1", scope: "a" },
        { id: "b1", scope: "b" },
        { id: "a2", scope: "a" },
        { id: "b2", scope: "b" },
        { id: "a3", scope: "a" },
    ];
    const moved = moveKeyedSubsequence(
        items,
        {
            keyOf: (item) => item.id,
            inScope: (item) => item.scope === "a",
        },
        { activeId: "a3", overId: "a1" },
    );

    // Device B's bookmarks stay in their original slots.
    expect(moved.map((item) => item.id)).toEqual([
        "a3",
        "b1",
        "a1",
        "b2",
        "a2",
    ]);
    expect(moved[1]).toBe(items[1]);
    expect(moved[3]).toBe(items[3]);
});

test("does not resurrect a removed source or drop a newly added sibling", () => {
    const current = [{ id: "a" }, { id: "c" }, { id: "d" }];

    // The source disappeared while the gesture was active, so the latest array wins.
    expect(moveKeyedItems(current, keyOf, { activeId: "b", overId: "a" })).toBe(
        current,
    );
    // A sibling appended during the gesture stays after the moved subsequence.
    expect(
        moveKeyedItems(current, keyOf, { activeId: "c", overId: "a" }).map(
            (item) => item.id,
        ),
    ).toEqual(["c", "a", "d"]);
});
