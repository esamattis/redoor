import { z } from "zod";

const errorCodeSchema = z.object({ code: z.string() });

/** Narrows unknown failures by code without assuming every thrown value is a Node error. */
export function isErrorCode(
    cause: unknown,
    code: string,
): cause is { code: string } {
    const result = errorCodeSchema.safeParse(cause);
    return result.success && result.data.code === code;
}
