export function getParentPath(path: string): string | null {
    if (!path.startsWith("/")) return null;
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === "") return null;

    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    if (lastSlashIndex === -1) return null;
    if (lastSlashIndex === 0) return "/";

    return normalizedPath.slice(0, lastSlashIndex);
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

export function formatSpeed(bytesPerSecond: number | null): string {
    if (
        bytesPerSecond === null ||
        !Number.isFinite(bytesPerSecond) ||
        bytesPerSecond < 0
    ) {
        return "—";
    }

    return `${formatSize(bytesPerSecond)}/s`;
}
