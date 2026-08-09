/** Narrows unknown failures by code without assuming every thrown value is a Node error. */
export function isErrorCode(
    error: unknown,
    code: string,
): error is { code: string } {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}
