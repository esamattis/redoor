import { describe, expect, test } from "vitest";
import type { SystemdPathMatch } from "#bindings/SystemdPathMatch";
import {
    shouldCheckSystemdAfterSave,
    systemdReloadLabel,
    systemdReloadOffer,
    withoutSystemdScope,
} from "#ui/utils/systemd-reload-offer";

const available = { status: "available" } as const;

/** A match with the fields the tests do not care about filled in. */
function match(overrides: Partial<SystemdPathMatch>): SystemdPathMatch {
    return {
        scope: { type: "system" },
        unit: "nginx.service",
        drop_in: false,
        state: "needs_reload",
        can_reload: true,
        ...overrides,
    };
}

describe("shouldCheckSystemdAfterSave", () => {
    test("checks unit files and drop-ins on agents with systemd", () => {
        // Unit files are the main case the offer exists for.
        expect(
            shouldCheckSystemdAfterSave(
                "/etc/systemd/system/nginx.service",
                available,
            ),
        ).toBe(true);
        // A drop-in is only recognisable from its directory, so the full path must be used.
        expect(
            shouldCheckSystemdAfterSave(
                "/etc/systemd/system/nginx.service.d/override.conf",
                available,
            ),
        ).toBe(true);
    });

    test("skips other files and agents without systemd", () => {
        // Ordinary files never need a daemon-reload, so they must not cost a request.
        expect(
            shouldCheckSystemdAfterSave("/etc/nginx/nginx.conf", available),
        ).toBe(false);
        // An agent without systemd would only answer with an unsupported error.
        expect(
            shouldCheckSystemdAfterSave("/etc/systemd/system/a.service", {
                status: "unavailable",
                reason: "no systemd",
            }),
        ).toBe(false);
        // Unknown support (never registered) is treated as unsupported.
        expect(
            shouldCheckSystemdAfterSave("/etc/systemd/system/a.service", null),
        ).toBe(false);
    });
});

describe("systemdReloadOffer", () => {
    test("offers nothing when every manager is up to date", () => {
        // A loaded, unchanged unit needs no reload, so no toast should appear.
        expect(
            systemdReloadOffer({
                path: "/etc/systemd/system/nginx.service",
                matches: [match({ state: "up_to_date" })],
            }),
        ).toBeNull();
        // A manager that is not running has nothing to reload.
        expect(
            systemdReloadOffer({
                path: "/x.service",
                matches: [match({ state: "manager_not_running" })],
            }),
        ).toBeNull();
    });

    test("skips managers the agent may not reload", () => {
        // A non-root agent gets 403 for a system reload, so it must not be offered.
        expect(
            systemdReloadOffer({
                path: "/etc/systemd/system/nginx.service",
                matches: [match({ can_reload: false })],
            }),
        ).toBeNull();
    });

    test("names the changed unit and its manager", () => {
        const offer = systemdReloadOffer({
            path: "/home/me/.config/systemd/user/app.service",
            matches: [
                match({
                    scope: { type: "user", name: "me" },
                    unit: "app.service",
                }),
            ],
        });

        // The message names the unit so the user knows what the reload is for.
        expect(offer?.message).toBe(
            "systemd has not loaded the changes to app.service",
        );
        // The reload targets the manager that reported the stale unit.
        expect(offer?.scopes).toEqual([{ type: "user", name: "me" }]);
    });

    test("words a unit systemd cannot see yet differently", () => {
        const offer = systemdReloadOffer({
            path: "/etc/systemd/system/new.service",
            matches: [match({ unit: "new.service", state: "not_loaded" })],
        });

        // A new unit has no earlier changes, so the message says it is not loaded at all.
        expect(offer?.message).toBe("systemd has not loaded new.service yet");
    });

    test("offers each manager once", () => {
        const offer = systemdReloadOffer({
            path: "/etc/systemd/system/nginx.service.d/override.conf",
            matches: [
                match({ drop_in: true }),
                match({ drop_in: true, state: "not_loaded" }),
                match({ scope: { type: "user", name: "me" } }),
            ],
        });

        // Two matches of the same manager would otherwise produce two identical buttons.
        expect(offer?.scopes).toEqual([
            { type: "system" },
            { type: "user", name: "me" },
        ]);
        // The unit is named once even when several matches report it.
        expect(offer?.message).toBe(
            "systemd has not loaded the changes to nginx.service",
        );
    });
});

describe("withoutSystemdScope", () => {
    test("keeps the managers that were not reloaded", () => {
        const offer = {
            path: "/x.service",
            message: "m",
            scopes: [
                { type: "system" } as const,
                { type: "user", name: "me" } as const,
            ],
        };

        // Only the reloaded manager loses its action; the other may still need one.
        expect(withoutSystemdScope(offer, { type: "system" }).scopes).toEqual([
            { type: "user", name: "me" },
        ]);
    });
});

test("labels the action after its manager", () => {
    // Both labels can appear side by side, so they must differ.
    expect(systemdReloadLabel({ type: "system" })).toBe("Reload systemd");
    expect(systemdReloadLabel({ type: "user", name: "me" })).toBe(
        "Reload user systemd",
    );
});
