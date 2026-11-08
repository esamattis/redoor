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
    "ssh_key_locked",
    "vault_required",
    "vault_key_in_use",
    "vault_device_not_found",
    "systemd_unsupported",
    "systemd_user_manager_not_running",
    "session_reused",
    "fresh_login_required",
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

/**
 * Why the browser session ended: `reused` when the server signed it out because its cookie
 * was used by two browsers, so the login page can tell the user; `ended` for everything
 * else (expiry, logout, a password change).
 */
export type SessionEndReason = "ended" | "reused";

/** Supplies browser or Node-managed authentication without coupling transport to the router. */
export type RequestContext = {
    getSessionCookie?: () => string | null;
    /** An access token takes precedence over the cookie on the server, as for the CLI. */
    getAccessToken?: () => string | null;
    onUnauthorized?: (reason: SessionEndReason) => void;
    /**
     * Receives every `Set-Cookie` a response carries. Only Node-based clients see it (browsers
     * hide the header and keep the cookie themselves), and they need it because the server
     * rotates the session cookie's secret.
     */
    onSetCookie?: (setCookie: string) => void;
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

/** Parses a structured error body, or `null` for anything else. */
function parseErrorResponse(text: string): ErrorResponse | null {
    try {
        return errorResponseSchema.parse(JSON.parse(text));
    } catch {
        return null;
    }
}

/** Converts failed responses into typed errors and reports expired browser sessions once. */
export async function requireSuccessfulResponse(
    response: Response,
    context: RequestContext,
): Promise<void> {
    const setCookie = response.headers.get("set-cookie");

    if (setCookie) {
        context.onSetCookie?.(setCookie);
    }

    if (response.ok) {
        return;
    }

    const text = await response.text();
    const parsed = text ? parseErrorResponse(text) : null;

    if (response.status === 401) {
        context.onUnauthorized?.(
            parsed?.code === "session_reused" ? "reused" : "ended",
        );
    }

    if (text) {
        if (parsed && parsed.error.length > 0) {
            throw new ApiError(response.status, parsed.error, {
                body: text,
                code: parsed.code ?? null,
            });
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

/**
 * Sends a request and yields the NDJSON lines of its streamed answer, one batch per chunk the
 * network delivers, so callers can show results while the server still produces them.
 *
 * Lines may be split across chunks; only complete lines are yielded, and chunks that complete
 * none yield nothing. A body that ends in the middle of a line fails, because it was cut off.
 * A consumer that stops early cancels the body, which tells the server to stop too.
 */
export async function* streamNdjson<T>(
    url: string,
    options: RequestInit,
    context: RequestContext = {},
): AsyncGenerator<T[]> {
    const response = await fetch(url, withAuthentication(options, context));
    await requireSuccessfulResponse(response, context);

    if (response.body === null) {
        throw new Error("The streamed response has no body");
    }

    const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();

    let partial = "";

    try {
        for (;;) {
            const chunk = await reader.read();

            if (chunk.done) {
                break;
            }

            const lines = (partial + chunk.value).split("\n");
            partial = lines.pop() ?? "";

            // The caller names the line type the route sends, as `apiRequest` does for JSON.
            const batch: T[] = lines
                .filter((line) => line !== "")
                .map((line): T => JSON.parse(line));

            if (batch.length > 0) {
                yield batch;
            }
        }
    } finally {
        // Ends the request when the consumer stopped before the body did; a no-op otherwise.
        await reader.cancel().catch(() => undefined);
    }

    if (partial !== "") {
        throw new Error("The stream ended in the middle of a line");
    }
}
