import { describe, expect, test } from "vitest";

import { unitActionAvailability } from "#ui/utils/systemd-unit-action-availability";

/** Builds the state fields the rules read, defaulting to a stopped, disabled unit. */
function unit(state: {
    load_state?: string | null;
    active_state?: string | null;
    unit_file_state?: string | null;
}) {
    return {
        load_state: state.load_state ?? "loaded",
        active_state: state.active_state ?? "inactive",
        unit_file_state:
            state.unit_file_state === undefined
                ? "disabled"
                : state.unit_file_state,
    };
}

describe("unitActionAvailability", () => {
    test("a running unit can be stopped but not started", () => {
        const running = unit({ active_state: "active" });

        // Starting a running unit is a no-op, so its button must not look actionable.
        expect(unitActionAvailability("start", running)).toEqual({
            available: false,
            reason: "Already running",
        });
        // Stop and reload are the actions that do something for a running unit.
        expect(unitActionAvailability("stop", running).available).toBe(true);
        expect(unitActionAvailability("reload", running).available).toBe(true);
    });

    test("a stopped or failed unit can be started but not stopped or reloaded", () => {
        for (const activeState of ["inactive", "failed"]) {
            const stopped = unit({ active_state: activeState });

            // Starting is the way back from both states.
            expect(unitActionAvailability("start", stopped).available).toBe(
                true,
            );
            // Nothing runs, so stopping has nothing to stop.
            expect(unitActionAvailability("stop", stopped)).toEqual({
                available: false,
                reason: "Not running",
            });
            // systemd refuses to reload a unit that does not run.
            expect(unitActionAvailability("reload", stopped).available).toBe(
                false,
            );
        }
    });

    test("restart stays available whether or not the unit runs", () => {
        // Restart also starts a stopped unit, so it is useful in both states.
        expect(
            unitActionAvailability("restart", unit({ active_state: "active" }))
                .available,
        ).toBe(true);
        expect(
            unitActionAvailability(
                "restart",
                unit({ active_state: "inactive" }),
            ).available,
        ).toBe(true);
    });

    test("enable and disable follow the unit file state", () => {
        const enabled = unit({ unit_file_state: "enabled" });
        const disabled = unit({ unit_file_state: "disabled" });

        // Only the opposite of the current state is offered.
        expect(unitActionAvailability("enable", enabled)).toEqual({
            available: false,
            reason: "Already enabled",
        });
        expect(unitActionAvailability("disable", enabled).available).toBe(true);
        expect(unitActionAvailability("enable", disabled).available).toBe(true);
        expect(unitActionAvailability("disable", disabled)).toEqual({
            available: false,
            reason: "Not enabled",
        });
    });

    test("linked and runtime-enabled units can still be enabled", () => {
        // Enabling a linked unit adds its install symlinks, and enabling a runtime-enabled
        // unit makes it survive a reboot, so both must stay offered.
        for (const fileState of [
            "linked",
            "linked-runtime",
            "enabled-runtime",
        ]) {
            expect(
                unitActionAvailability(
                    "enable",
                    unit({ unit_file_state: fileState }),
                ).available,
            ).toBe(true);
        }
    });

    test("static units and units without a unit file cannot be enabled", () => {
        // Static units have no [Install] section, so systemctl enable has nothing to do.
        expect(
            unitActionAvailability(
                "enable",
                unit({ unit_file_state: "static" }),
            ).available,
        ).toBe(false);
        // A loaded unit without a unit file (for example a mount) has nothing to enable.
        expect(
            unitActionAvailability("enable", unit({ unit_file_state: null }))
                .available,
        ).toBe(false);
    });

    test("a masked unit cannot be started or restarted", () => {
        const masked = unit({ unit_file_state: "masked" });

        // systemd refuses to start masked units, so offering it would only fail.
        expect(unitActionAvailability("start", masked).available).toBe(false);
        expect(unitActionAvailability("restart", masked).available).toBe(false);
    });

    test("an unknown unit offers no action", () => {
        const missing = unit({
            load_state: "not-found",
            unit_file_state: null,
        });

        // Every action on a unit systemd does not know fails, so none is offered.
        for (const action of [
            "start",
            "stop",
            "restart",
            "reload",
            "enable",
            "disable",
        ] as const) {
            expect(unitActionAvailability(action, missing).available).toBe(
                false,
            );
        }
    });
});
