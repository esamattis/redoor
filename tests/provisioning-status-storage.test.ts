import { describe, expect, test } from "vitest";

import { parseProvisioningStatusStore } from "#ui/provisioning-status";

describe("provisioning status local storage", () => {
    test("keeps name-keyed messages that match the schema", () => {
        const stored = parseProvisioningStatusStore(
            JSON.stringify({
                "edge-pi": [
                    { message: "Sniffing the SSH target", at: 100 },
                    { message: "Spawning the remote binary", at: 140 },
                ],
            }),
        );

        // Valid history must survive so the agent home can show the last start.
        expect(stored["edge-pi"]).toEqual([
            { message: "Sniffing the SSH target", at: 100 },
            { message: "Spawning the remote binary", at: 140 },
        ]);
    });

    test("discards malformed storage instead of throwing", () => {
        // Hand-edited or leftover JSON must not crash the connected home page.
        expect(parseProvisioningStatusStore("nope")).toEqual({});
        expect(
            parseProvisioningStatusStore(
                JSON.stringify({ "edge-pi": "bad" }),
            ),
        ).toEqual({});
        expect(
            parseProvisioningStatusStore(
                JSON.stringify({
                    "edge-pi": [{ message: 1, at: "now" }],
                }),
            ),
        ).toEqual({});
    });
});
