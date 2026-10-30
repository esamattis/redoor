import type { LsEntry } from "#bindings/LsEntry";
import { ApiError } from "#ui/api-transport";
import type { FileSortColumn, FileSortDirection } from "#ui/browser-search";

export function getImmediateParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");

    if (!normalizedPath.startsWith("/") || normalizedPath === "") return null;
    const lastSlashIndex = normalizedPath.lastIndexOf("/");

    return lastSlashIndex === 0 ? "/" : normalizedPath.slice(0, lastSlashIndex);
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

/** Pairs a listing column with its direction, which together decide the displayed order. */
export type FileSort = {
    column: FileSortColumn;
    direction: FileSortDirection;
};

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

/**
 * A listing order: the chosen column and direction, plus what the Git column sorts by. The
 * Git status is not part of the listing, so `gitRank` ranks an entry by its name (lower
 * first); it is null while the status is loading or after the walk timed out.
 */
export type FileOrder = {
    sort: FileSort;
    gitRank: ((name: string) => number) | null;
};

/**
 * Compares one selected column, keeping hidden entries last when names break ties. Without
 * a Git rank the Git sort falls back to the name order, so rows never move until the status
 * they would be sorted by is known.
 */
export function compareFileEntries(
    left: LsEntry,
    right: LsEntry,
    order: FileOrder,
): number {
    const sort = order.sort;
    const gitRank = order.gitRank;
    let comparison = 0;

    if (sort.column === "git") {
        comparison =
            gitRank === null ? 0 : gitRank(left.name) - gitRank(right.name);
    } else if (sort.column === "size") {
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

/**
 * Detects self-nested destinations so Copy/Move can refuse a directory
 * landing inside itself instead of starting a doomed transfer.
 */
export function isBrowserPathInside(parentPath: string, candidatePath: string) {
    if (parentPath === candidatePath) {
        return true;
    }

    const prefix = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;

    return candidatePath.startsWith(prefix);
}
