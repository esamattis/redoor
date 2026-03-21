export function getParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === "") return null;

    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    if (lastSlashIndex === -1) return null;

    return normalizedPath.slice(0, lastSlashIndex) || null;
}

export function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    if (unitIndex === 0) {
        return `${value} ${units[unitIndex]}`;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}
