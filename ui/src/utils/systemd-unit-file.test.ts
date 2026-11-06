import { describe, expect, test } from "vitest";

import type { SystemdPathMatch } from "#bindings/SystemdPathMatch";
import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import {
    isInstanceOf,
    isTemplateUnit,
    selectSystemdMatch,
    systemdUnitFileTarget,
    systemdViewUnit,
    templateInstances,
} from "#ui/utils/systemd-unit-file";

/** A unit list entry with only the fields the helpers read varying. */
function summary(
    name: string,
    fragmentPath: string | null,
): SystemdUnitSummary {
    return {
        name,
        unit_type: name.split(".").pop() ?? "",
        description: null,
        load_state: "loaded",
        active_state: "active",
        sub_state: "running",
        unit_file_state: null,
        fragment_path: fragmentPath,
        timer: null,
    };
}

/** A path-status match of one manager. */
function match(
    unit: string,
    scope: SystemdPathMatch["scope"] = { type: "system" },
): SystemdPathMatch {
    return {
        scope,
        unit,
        drop_in: false,
        state: "up_to_date",
        can_reload: false,
    };
}

/** Keys a match by its manager, the way the view names managers in the URL. */
function keyOf(entry: SystemdPathMatch): string {
    return entry.scope.type === "system"
        ? "system"
        : `user/${entry.scope.name}`;
}

describe("systemdUnitFileTarget", () => {
    test("links a unit to the file that defines it", () => {
        // The unit list links straight to the Systemd view of the unit's own file.
        expect(
            systemdUnitFileTarget(
                summary(
                    "loki.service",
                    "/home/me/.config/systemd/user/loki.service",
                ),
            ),
        ).toEqual({ path: "/home/me/.config/systemd/user/loki.service" });
    });

    test("names the instance when its file is the template", () => {
        // An instance shares its template's file, so the link must say which unit to show.
        expect(
            systemdUnitFileTarget(
                summary(
                    "getty@tty1.service",
                    "/usr/lib/systemd/system/getty@.service",
                ),
            ),
        ).toEqual({
            path: "/usr/lib/systemd/system/getty@.service",
            unit: "getty@tty1.service",
        });
    });

    test("does not link units without a file", () => {
        // Devices, scopes and built-in units have no page, so their names stay plain text.
        expect(systemdUnitFileTarget(summary("-.slice", null))).toBeNull();
        // A relative value is no path the browser could open.
        expect(
            systemdUnitFileTarget(summary("a.service", "a.service")),
        ).toBeNull();
    });
});

describe("template names", () => {
    test("tells templates, instances and plain units apart", () => {
        // Only a name with an empty instance is a template without status.
        expect(isTemplateUnit("getty@.service")).toBe(true);
        expect(isTemplateUnit("getty@tty1.service")).toBe(false);
        expect(isTemplateUnit("getty.service")).toBe(false);
        // An instance belongs to the template with its prefix and type only.
        expect(isInstanceOf("getty@tty1.service", "getty@.service")).toBe(true);
        expect(isInstanceOf("getty@tty1.socket", "getty@.service")).toBe(false);
        expect(isInstanceOf("other@tty1.service", "getty@.service")).toBe(
            false,
        );
        // A template is not an instance of itself.
        expect(isInstanceOf("getty@.service", "getty@.service")).toBe(false);
    });

    test("lists a template's instances from the unit list", () => {
        const units = [
            summary("getty@.service", "/lib/getty@.service"),
            summary("getty@tty1.service", "/lib/getty@.service"),
            summary("getty@tty2.service", "/lib/getty@.service"),
            summary("serial-getty@ttyS0.service", "/lib/serial-getty@.service"),
        ];

        // The template file's view offers exactly its own instances.
        expect(
            templateInstances(units, "getty@.service").map((unit) => unit.name),
        ).toEqual(["getty@tty1.service", "getty@tty2.service"]);
    });
});

describe("Systemd view selection", () => {
    const system = match("a.service");
    const user = match("a.service", { type: "user", name: "me" });

    test("picks the manager named in the URL, else the first", () => {
        // A file several managers load shows the chosen one.
        expect(selectSystemdMatch([system, user], "user/me", keyOf)).toBe(user);
        // Without a choice, or with a stale one, the first manager is shown.
        expect(selectSystemdMatch([system, user], undefined, keyOf)).toBe(
            system,
        );
        expect(selectSystemdMatch([system, user], "user/gone", keyOf)).toBe(
            system,
        );
        // A file no manager loads has nothing to show.
        expect(selectSystemdMatch([], "system", keyOf)).toBeNull();
    });

    test("shows a requested instance only of the file's template", () => {
        const template = match("getty@.service");

        // The template file's view shows the instance the link named.
        expect(systemdViewUnit(template, "getty@tty1.service")).toBe(
            "getty@tty1.service",
        );
        // A name of another unit cannot replace the file's own unit.
        expect(systemdViewUnit(template, "sshd.service")).toBe(
            "getty@.service",
        );
        expect(systemdViewUnit(system, "getty@tty1.service")).toBe("a.service");
        // Without a request the file's own unit is shown.
        expect(systemdViewUnit(system, undefined)).toBe("a.service");
    });
});
