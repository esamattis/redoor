import type { SystemdPathMatch } from "#bindings/SystemdPathMatch";
import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import { getBaseName } from "#ui/utils/path";

/**
 * Where a unit's status is shown: the Systemd view of the file that defines it. `unit` is set
 * when the file defines more than the unit itself, which is a template file shared by every
 * instance (`getty@.service` for `getty@tty1.service`), so the view knows which one to show.
 */
export type SystemdUnitFileTarget = { path: string; unit?: string };

/** Splits `name@instance.type` into its prefix and type, or null for names without `@`. */
function splitTemplateName(
    name: string,
): { prefix: string; instance: string; type: string } | null {
    const match = /^([^@]+)@([^@]*)\.([a-z]+)$/.exec(name);

    if (!match) {
        return null;
    }

    const [, prefix = "", instance = "", type = ""] = match;

    return { prefix, instance, type };
}

/** Whether a unit name is a template such as `getty@.service`, which has no status itself. */
export function isTemplateUnit(name: string): boolean {
    return splitTemplateName(name)?.instance === "";
}

/** Whether `name` is an instance of `template`, such as `getty@tty1.service` of `getty@.service`. */
export function isInstanceOf(name: string, template: string): boolean {
    const unit = splitTemplateName(name);
    const parts = splitTemplateName(template);

    return (
        unit !== null &&
        parts !== null &&
        unit.instance !== "" &&
        parts.instance === "" &&
        unit.prefix === parts.prefix &&
        unit.type === parts.type
    );
}

/**
 * The file view a unit links to, or null for units without a file of their own (devices,
 * scopes, `-.slice`, transient units), which the list shows without a link. An instance's
 * file is its template, so the link names the instance for the view to show.
 */
export function systemdUnitFileTarget(
    unit: Pick<SystemdUnitSummary, "name" | "fragment_path">,
): SystemdUnitFileTarget | null {
    if (unit.fragment_path === null || !unit.fragment_path.startsWith("/")) {
        return null;
    }

    if (isInstanceOf(unit.name, getBaseName(unit.fragment_path))) {
        return { path: unit.fragment_path, unit: unit.name };
    }

    return { path: unit.fragment_path };
}

/** The instances of a template in a unit list, for the template file's Systemd view. */
export function templateInstances(
    units: SystemdUnitSummary[],
    template: string,
): SystemdUnitSummary[] {
    return units.filter((unit) => isInstanceOf(unit.name, template));
}

/**
 * Picks the manager the Systemd view shows: the one named in the URL when it still loads the
 * file, otherwise the first, so a stale or hand-edited URL still shows something useful.
 */
export function selectSystemdMatch(
    matches: SystemdPathMatch[],
    scopeKey: string | undefined,
    keyOf: (match: SystemdPathMatch) => string,
): SystemdPathMatch | null {
    return (
        matches.find((match) => keyOf(match) === scopeKey) ?? matches[0] ?? null
    );
}

/**
 * The unit the Systemd view shows for a match: the file's own unit, or for a template file
 * the requested instance when it is one of that template's, since a template has no status.
 */
export function systemdViewUnit(
    match: SystemdPathMatch,
    requested: string | undefined,
): string {
    if (requested !== undefined && isInstanceOf(requested, match.unit)) {
        return requested;
    }

    return match.unit;
}
