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

/** Builds a browser route whose filesystem components remain visible as URL segments. */
export function getBrowserUrl(agentId: string, path: string): string {
    return `/agents/${encodeURIComponent(agentId)}/browser/${encodeFilesystemPath(path)}`;
}
