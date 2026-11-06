import type { SystemdPathStatusResponse } from "#bindings/SystemdPathStatusResponse";
import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdSupport } from "#bindings/SystemdSupport";
import { isSystemdUnitPath } from "#ui/utils/systemd-language";

/**
 * What the editor offers after saving a unit file systemd has not picked up: one reload
 * action per manager, because each manager reads its own unit files and reloads separately.
 */
export type SystemdReloadOffer = {
    /** The saved file, so an answer that arrives after switching files is not shown. */
    path: string;
    message: string;
    scopes: SystemdScope[];
};

/**
 * Whether a saved file is worth asking systemd about. Only unit files and drop-ins on an
 * agent that reported systemd can need a daemon-reload, and asking for anything else would
 * cost an agent round trip after every save.
 */
export function shouldCheckSystemdAfterSave(
    path: string,
    support: SystemdSupport | null,
): boolean {
    if (support?.status !== "available") {
        return false;
    }

    const lowerPath = path.toLowerCase();

    return isSystemdUnitPath(
        lowerPath.split("/").pop() ?? lowerPath,
        lowerPath,
    );
}

/** A stable identity for a manager, since scope objects from different answers differ. */
export function systemdScopeKey(scope: SystemdScope): string {
    return scope.type === "system" ? "system" : `user:${scope.name}`;
}

/**
 * Turns the agent's path status into a reload offer, or null when nothing needs one.
 *
 * `up_to_date` needs nothing (current systemd loads new unit files on demand), a manager
 * that does not run has nothing to reload, and `can_reload` is false where the agent may
 * not reload (the system manager of a non-root agent), so offering it would only fail.
 */
export function systemdReloadOffer(
    response: SystemdPathStatusResponse,
): SystemdReloadOffer | null {
    const pending = response.matches.filter(
        (match) =>
            match.can_reload &&
            (match.state === "needs_reload" || match.state === "not_loaded"),
    );

    if (pending.length === 0) {
        return null;
    }

    const scopes = new Map<string, SystemdScope>();

    for (const match of pending) {
        scopes.set(systemdScopeKey(match.scope), match.scope);
    }

    const units = [...new Set(pending.map((match) => match.unit))].join(", ");

    // A changed unit differs from a new one systemd cannot see yet, and the user acts
    // with more confidence when told which of the two happened.
    const message = pending.some((match) => match.state === "needs_reload")
        ? `systemd has not loaded the changes to ${units}`
        : `systemd has not loaded ${units} yet`;

    return { path: response.path, message, scopes: [...scopes.values()] };
}

/** Drops a manager that was reloaded, so only the ones still pending keep their action. */
export function withoutSystemdScope(
    offer: SystemdReloadOffer,
    scope: SystemdScope,
): SystemdReloadOffer {
    const key = systemdScopeKey(scope);

    return {
        ...offer,
        scopes: offer.scopes.filter(
            (candidate) => systemdScopeKey(candidate) !== key,
        ),
    };
}

/**
 * Names the reload action after its manager, because "Reload systemd" alone would hide
 * which manager a user unit belongs to when both could be offered.
 */
export function systemdReloadLabel(scope: SystemdScope): string {
    return scope.type === "system" ? "Reload systemd" : "Reload user systemd";
}

/** Says which manager reloaded, matching the action the user clicked. */
export function systemdReloadedMessage(scope: SystemdScope): string {
    return scope.type === "system"
        ? "systemd reloaded its unit files"
        : `The user systemd of ${scope.name} reloaded its unit files`;
}
