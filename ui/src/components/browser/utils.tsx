import type { LsEntry } from "#bindings/LsEntry";
import { ApiError, type Agent } from "#ui/api-client";

export function getImmediateParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");
    if (!normalizedPath.startsWith("/") || normalizedPath === "") return null;
    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    return lastSlashIndex === 0 ? "/" : normalizedPath.slice(0, lastSlashIndex);
}

export function getBrowserPathHref(agent: Agent, path: string) {
    return agent.getBrowserUrl(path);
}

export type PathLoadError = {
    type: "missing" | "unreadable";
    message: string;
};

/** Converts expected filesystem lookup failures into navigable in-page states. */
export function getPathLoadError(cause: unknown): PathLoadError | null {
    if (!(cause instanceof ApiError)) {
        return null;
    }
    if (cause.status === 404) {
        return { type: "missing", message: cause.message };
    }
    if (cause.status === 403) {
        return { type: "unreadable", message: cause.message };
    }
    return null;
}

/**
 * Sort entries case-insensitively with dot-prefixed entries last.
 */
export function sortFileEntries<T extends { name: string }>(entries: T[]): T[] {
    return [...entries].sort((a, b) => {
        const aIsDot = a.name.startsWith(".");
        const bIsDot = b.name.startsWith(".");
        if (aIsDot !== bIsDot) {
            return aIsDot ? 1 : -1;
        }
        return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
        });
    });
}

export type FileSortColumn =
    "type" | "name" | "size" | "modified" | "owner" | "group";
export type FileSortDirection = "ascending" | "descending";

/** Formats the complete minute-level age used by modification-time tooltips. */
export function formatModifiedAge(modifiedAt: number, now: number): string {
    const totalMinutes = Math.max(
        0,
        Math.floor((now - modifiedAt * 1000) / 60_000),
    );
    if (totalMinutes === 0) return "less than a minute ago";

    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    const parts = [
        days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : null,
        hours > 0 ? `${hours} ${hours === 1 ? "hour" : "hours"}` : null,
        minutes > 0
            ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
            : null,
    ].filter((part): part is string => part !== null);

    return `${parts.join(" ")} ago`;
}

/** Compares one selected column, keeping hidden entries last when names break ties. */
export function compareFileEntries(
    left: LsEntry,
    right: LsEntry,
    sort: { column: FileSortColumn; direction: FileSortDirection },
): number {
    let comparison = 0;
    if (sort.column === "size") {
        comparison = left.size - right.size;
    } else if (sort.column === "modified") {
        comparison = left.modified_at - right.modified_at;
    } else if (sort.column !== "name") {
        const leftValue = left[sort.column] ?? "";
        const rightValue = right[sort.column] ?? "";
        comparison = leftValue.localeCompare(rightValue, undefined, {
            sensitivity: "base",
        });
    }
    if (comparison !== 0) {
        return sort.direction === "ascending" ? comparison : -comparison;
    }

    const leftIsHidden = left.name.startsWith(".");
    const rightIsHidden = right.name.startsWith(".");
    if (leftIsHidden !== rightIsHidden) {
        return leftIsHidden ? 1 : -1;
    }

    const nameComparison = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
    });
    return sort.direction === "ascending" ? nameComparison : -nameComparison;
}

export function joinBrowserPath(directoryPath: string, fileName: string) {
    if (directoryPath.endsWith("/")) {
        return `${directoryPath}${fileName}`;
    }

    return `${directoryPath}/${fileName}`;
}

export function getErrorMessage(cause: unknown, fallbackMessage: string) {
    if (cause instanceof Error) {
        return cause.message;
    }

    return fallbackMessage;
}
