import { z } from "zod";
import type { ErrorResponse } from "#bindings/ErrorResponse";

const errorResponseSchema: z.ZodType<ErrorResponse> = z.object({
    error: z.string(),
});

/** Supplies browser or Node-managed authentication without coupling transport to the router. */
export type RequestContext = {
    getSessionCookie?: () => string | null;
    onUnauthorized?: () => void;
};

/** Preserves HTTP status so authentication failures stay distinct from agent errors. */
export class ApiError extends Error {
    status: number;
    /** Raw response body when the server did not return a structured ErrorResponse. */
    body: string | null;

    constructor(status: number, message: string, body: string | null = null) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.body = body;
    }
}

/** Adds browser credentials and the explicit cookie needed by Node-based integration clients. */
export function withAuthentication(
    options: RequestInit | undefined,
    context: RequestContext,
): RequestInit {
    const headers = new Headers(options?.headers);
    const sessionCookie = context.getSessionCookie?.();
    if (sessionCookie) {
        headers.set("Cookie", sessionCookie);
    }
    return { ...options, credentials: "same-origin", headers };
}

/** Converts failed responses into typed errors and reports expired browser sessions once. */
export async function requireSuccessfulResponse(
    response: Response,
    context: RequestContext,
): Promise<void> {
    if (response.ok) {
        return;
    }
    if (response.status === 401) {
        context.onUnauthorized?.();
    }
    const text = await response.text();
    if (text) {
        try {
            const error = errorResponseSchema.parse(JSON.parse(text));
            if (error.error.length > 0) {
                throw new ApiError(response.status, error.error, text);
            }
        } catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
        }
        const trimmed = text.trim();
        const summary =
            trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
        throw new ApiError(
            response.status,
            summary ||
                `Request failed: ${response.status} ${response.statusText}`,
            text,
        );
    }
    throw new ApiError(
        response.status,
        `Request failed: ${response.status} ${response.statusText}`,
    );
}

/** Decodes one successful JSON response after applying shared auth and error semantics. */
export async function apiRequest<T>(
    url: string,
    options?: RequestInit,
    context: RequestContext = {},
): Promise<T> {
    const response = await fetch(url, withAuthentication(options, context));
    await requireSuccessfulResponse(response, context);
    return response.json();
}
