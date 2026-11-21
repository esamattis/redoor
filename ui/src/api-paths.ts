import type { CreationOwnershipOptions } from "#bindings/CreationOwnershipOptions";
import type { ChownPathRequest } from "#bindings/ChownPathRequest";

/** Encodes each filesystem component while preserving `/` as a URL path separator. */
export function encodeFilesystemPath(path: string): string {
    if (!path.startsWith("/")) {
        throw new Error("Filesystem path must be absolute");
    }

    return path.slice(1).split("/").map(encodeURIComponent).join("/");
}

/** Appends a filesystem path without leaving a trailing slash for the implicit root. */
export function appendFilesystemPath(route: string, path: string): string {
    const encodedPath = encodeFilesystemPath(path);

    return encodedPath ? `${route}/${encodedPath}` : route;
}

/** Serializes only requested ownership overrides so omitted fields retain agent-side defaults. */
export function appendOwnershipOptions(
    url: URL,
    ownership?: Partial<CreationOwnershipOptions>,
): URL {
    appendOwnerAndGroup(url, ownership ?? {});

    if (
        ownership?.inherit_owner !== null &&
        ownership?.inherit_owner !== undefined
    ) {
        url.searchParams.set("inherit_owner", String(ownership.inherit_owner));
    }

    if (
        ownership?.inherit_group !== null &&
        ownership?.inherit_group !== undefined
    ) {
        url.searchParams.set("inherit_group", String(ownership.inherit_group));
    }

    return url;
}

/** Appends owner/group selectors shared by creation and existing-entry ownership APIs. */
export function appendOwnerAndGroup(
    url: URL,
    ownership: Partial<ChownPathRequest>,
): URL {
    if (ownership.owner !== null && ownership.owner !== undefined) {
        url.searchParams.set("owner", ownership.owner);
    }

    if (ownership.group !== null && ownership.group !== undefined) {
        url.searchParams.set("group", ownership.group);
    }

    return url;
}
