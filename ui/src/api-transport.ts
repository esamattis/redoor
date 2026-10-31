import { z } from "zod";
import type { ErrorResponse } from "#bindings/ErrorResponse";
import type { ApiErrorCode } from "#bindings/ApiErrorCode";

/** Every error code the server sends; the check below keeps it complete. */
const API_ERROR_CODES = [
    "vault_not_found",
    "vault_exists",
    "vault_proof_invalid",
    "vault_last_slot",
    "vault_invalid",
    "not_a_vault_file",
    "vault_format_unsupported",
    "vault_header_corrupted",
    "foreign_vault",
    "retired_vault_key",
    "unknown_vault_key",
    "vault_header_tampered",
    "vault_payload_corrupted",
    "stale_vault_key",
    "vault_file_changed",
    "invalid_vault_file_key",
    "not_a_vault_path",
    "agent_upgrade_required",
] as const satisfies readonly ApiErrorCode[];

/** Fails to compile when the server gains a code this list does not name. */
const allCodesListed: Exclude<
    ApiErrorCode,
    (typeof API_ERROR_CODES)[number]
> extends never
    ? true
    : false = true;

void allCodesListed;

const errorResponseSchema: z.ZodType<ErrorResponse> = z.object({
    error: z.string(),
    // Unknown codes from a newer server are dropped rather than failing the parse.
    code: z.enum(API_ERROR_CODES).optional().catch(undefined),
});

/** Supplies browser or Node-managed authentication without coupling transport to the router. */
export type RequestContext = {
    getSessionCookie?: () => string | null;
    /** An access token takes precedence over the cookie on the server, as for the CLI. */
    getAccessToken?: () => string | null;
    onUnauthorized?: () => void;
};

/** Preserves HTTP status so authentication failures stay distinct from agent errors. */
export class ApiError extends Error {
    status: number;
    /** Raw response body when the server did not return a structured ErrorResponse. */
    body: string | null;
    /** The machine-readable reason, for failures the UI words itself (such as vault errors). */
    code: ApiErrorCode | null;

    constructor(
        status: number,
        message: string,
        details: { body?: string | null; code?: ApiErrorCode | null } = {},
    ) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.body = details.body ?? null;
        this.code = details.code ?? null;
    }
}

/** Returns the explicit credentials a Node-based client sends; browsers rely on their cookie jar. */
export function authenticationHeaders(context: RequestContext) {
    const headers = new Map<string, string>();
    const sessionCookie = context.getSessionCookie?.();
    const accessToken = context.getAccessToken?.();

    if (sessionCookie) {
        headers.set("Cookie", sessionCookie);
    }

    if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
    }

    return Object.fromEntries(headers);
}

/** Adds browser credentials and the explicit cookie or token needed by Node-based clients. */
export function withAuthentication(
    options: RequestInit | undefined,
    context: RequestContext,
): RequestInit {
    const headers = new Headers(options?.headers);

    for (const [name, value] of Object.entries(
        authenticationHeaders(context),
    )) {
        headers.set(name, value);
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
                throw new ApiError(response.status, error.error, {
                    body: text,
                    code: error.code ?? null,
                });
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
            { body: text },
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
