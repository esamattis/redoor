import type { SystemdUnitAction } from "#bindings/SystemdUnitAction";
import type { SystemdUnitDetailsResponse } from "#bindings/SystemdUnitDetailsResponse";

/** Whether an action makes sense now, and if not, the reason its control shows. */
export type UnitActionAvailability =
    { available: true } | { available: false; reason: string };

/** The unit fields the rules read, so tests do not need a whole details response. */
type UnitActionState = Pick<
    SystemdUnitDetailsResponse,
    "load_state" | "active_state" | "unit_file_state"
>;

/** States in which the unit already runs or is on its way up, so starting it does nothing. */
const RUNNING_STATES = new Set([
    "active",
    "activating",
    "reloading",
    "refreshing",
]);

/** States in which nothing runs any more, so stopping it does nothing. */
const STOPPED_STATES = new Set(["inactive", "failed", "deactivating"]);

/**
 * Unit file states `systemctl enable` acts on; the others have nothing to enable. Linked
 * units still lack their install symlinks, and runtime enablement is lost at reboot, so
 * enabling those persists them.
 */
const ENABLEABLE_FILE_STATES = new Set([
    "disabled",
    "indirect",
    "linked",
    "linked-runtime",
    "enabled-runtime",
]);

/** Unit file states `systemctl disable` acts on. */
const DISABLEABLE_FILE_STATES = new Set([
    "enabled",
    "enabled-runtime",
    "linked",
    "linked-runtime",
]);

/** Explains why a unit cannot be enabled, since "static" alone means little to most readers. */
function notEnableableReason(fileState: string | null): string {
    switch (fileState) {
        case "enabled":
        case "enabled-runtime":
            return "Already enabled";
        case "static":
            return "Static units have no [Install] section, so they start only when another unit needs them";
        case "masked":
        case "masked-runtime":
            return "The unit is masked";
        case "generated":
            return "A generator creates this unit, so it cannot be enabled";
        case "transient":
            return "Transient units exist only while they run and cannot be enabled";
        case "alias":
            return "This name is an alias; enable the unit it points to";
        case null:
            return "The unit has no unit file to enable";
        default:
            return `The unit file is ${fileState}`;
    }
}

/**
 * Decides which unit actions make sense in the unit's current state, so the page does not
 * offer starting a running unit or disabling a disabled one. Restart stays available in
 * every loaded state because it also starts a stopped unit.
 */
export function unitActionAvailability(
    action: SystemdUnitAction,
    unit: UnitActionState,
): UnitActionAvailability {
    if (unit.load_state === "not-found") {
        return { available: false, reason: "systemd does not know this unit" };
    }

    const activeState = unit.active_state ?? "inactive";
    const fileState = unit.unit_file_state;
    const masked = fileState === "masked" || fileState === "masked-runtime";

    switch (action) {
        case "start":
            if (masked) {
                return { available: false, reason: "The unit is masked" };
            }

            return RUNNING_STATES.has(activeState)
                ? { available: false, reason: "Already running" }
                : { available: true };
        case "stop":
            return STOPPED_STATES.has(activeState)
                ? { available: false, reason: "Not running" }
                : { available: true };
        case "restart":
            return masked
                ? { available: false, reason: "The unit is masked" }
                : { available: true };
        case "reload":
            return activeState === "active"
                ? { available: true }
                : {
                      available: false,
                      reason: "Only a running unit can reload",
                  };
        case "enable":
            return fileState !== null && ENABLEABLE_FILE_STATES.has(fileState)
                ? { available: true }
                : { available: false, reason: notEnableableReason(fileState) };
        case "disable":
            return fileState !== null && DISABLEABLE_FILE_STATES.has(fileState)
                ? { available: true }
                : { available: false, reason: "Not enabled" };
    }
}
