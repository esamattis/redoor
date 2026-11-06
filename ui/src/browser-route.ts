import type { SystemdScope } from "#bindings/SystemdScope";

/** The device sub-pages a device link can open, besides the file browser. */
type DevicePage =
    | "/agents/$deviceName"
    | "/agents/$deviceName/edit"
    | "/agents/$deviceName/logs"
    | "/agents/$deviceName/systemd"
    | "/agents/$deviceName/trash";

/**
 * Builds the history state a link stores to say which device it was made for.
 *
 * The device route keeps the id it resolved while its URL name stays the same, so an open
 * page never switches devices when its old name is given to another one. That would also
 * swallow a deliberate choice of the device that now has the name, so links built from a
 * device carry its id, and the device route resolves that id instead of keeping its own.
 */
function deviceSelection(device: { id?: string }) {
    return device.id === undefined ? undefined : { deviceId: device.id };
}

/**
 * Describes where a filesystem path lives in the router, so links and navigations carry the
 * typed `to` and `params` instead of a URL built by hand. The router encodes each path
 * segment itself, which matters because device names may contain spaces, `?`, `#`, `%` and
 * Unicode, and keeps the slashes readable. Spread the result into a `Link` or `navigate`
 * call and add `search` when the destination needs a view. Where a real string is required,
 * such as a copied link or a native `href`, pass it to `router.buildLocation`.
 *
 * It takes the device rather than a bare string because URLs carry the device's current
 * name, never its id: callers holding only an id must look the device up first, which also
 * makes links follow a rename. When the device's id is known the link also records it (see
 * `deviceSelection`); links that only know a name stay on the device the page was opened for.
 */
export function browserRoute(
    device: { id?: string; name: string },
    path: string,
) {
    if (!path.startsWith("/")) {
        throw new Error("Filesystem path must be absolute");
    }

    return {
        to: "/agents/$deviceName/browser/$",
        params: { deviceName: device.name, _splat: path.slice(1) },
        state: deviceSelection(device),
    } as const;
}

/**
 * Describes a link to one of a device's pages, carrying the device's id like `browserRoute`,
 * so choosing a device in the sidebar, the device list or the top bar always opens that
 * device, even when its name used to belong to the device that is open now.
 */
export function deviceRoute(
    device: { id: string; name: string },
    to: DevicePage,
) {
    return {
        to,
        params: { deviceName: device.name },
        state: deviceSelection(device),
    } as const;
}

/**
 * Describes a link to the unit list of one systemd manager, carrying the device's id like
 * `deviceRoute`. The system manager and a user's manager are separate routes, because a
 * user's units live below that user's own page with its linger state.
 */
export function systemdScopeRoute(
    device: { id: string; name: string },
    scope: SystemdScope,
) {
    if (scope.type === "system") {
        return {
            to: "/agents/$deviceName/systemd/system",
            params: { deviceName: device.name },
            state: deviceSelection(device),
        } as const;
    }

    return {
        to: "/agents/$deviceName/systemd/user/$user",
        params: { deviceName: device.name, user: scope.name },
        state: deviceSelection(device),
    } as const;
}

/** Describes a link to a root agent's list of user managers, like `systemdScopeRoute`. */
export function systemdUsersRoute(device: { id: string; name: string }) {
    return {
        to: "/agents/$deviceName/systemd/user",
        params: { deviceName: device.name },
        state: deviceSelection(device),
    } as const;
}
