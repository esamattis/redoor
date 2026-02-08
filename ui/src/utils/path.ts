export function getParentPath(path: string): string | null {
    const parts = path.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0) return null;
    parts.pop();
    return parts.join("/") || null;
}

export function formatSize(bytes: bigint): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes);
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
