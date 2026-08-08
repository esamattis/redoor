import * as React from "react";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import {
    useRouter,
    type ErrorComponentProps,
} from "@tanstack/react-router";
import { ApiError } from "../api-client";

/** True for browser network failures that never received an HTTP response. */
function isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const message = error.message.toLowerCase();
    return (
        error.name === "TypeError" ||
        message.includes("failed to fetch") ||
        message.includes("networkerror") ||
        message.includes("load failed") ||
        message.includes("network request failed")
    );
}

/** Maps common HTTP statuses to short titles so gateway failures read clearly. */
function titleForError(error: unknown): string {
    if (error instanceof ApiError) {
        switch (error.status) {
            case 401:
                return "Authentication required";
            case 403:
                return "Permission denied";
            case 404:
                return "Not found";
            case 502:
                return "Server unavailable";
            case 503:
                return "Service unavailable";
            case 504:
                return "Gateway timeout";
            default:
                if (error.status >= 500) {
                    return "Server error";
                }
                if (error.status >= 400) {
                    return "Request failed";
                }
        }
    }
    if (isNetworkError(error)) {
        return "Connection failed";
    }
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes("agent not found")) {
            return "Agent not found";
        }
        if (
            message.includes("no such file or directory") ||
            message.includes("directory not found")
        ) {
            return "Path not found";
        }
        if (message.includes("not a directory")) {
            return "Not a directory";
        }
        if (message.includes("permission denied")) {
            return "Permission denied";
        }
        if (message.includes("not editable")) {
            return "File is not editable";
        }
    }
    return "Something went wrong";
}

/** Human-readable explanation for statuses that often need extra context. */
function hintForError(error: unknown): string | null {
    if (error instanceof ApiError) {
        switch (error.status) {
            case 502:
                return "The server or an upstream proxy returned a bad gateway response. The API may be restarting or unreachable.";
            case 503:
                return "The server is temporarily unable to handle the request. Try again in a moment.";
            case 504:
                return "The gateway timed out waiting for the server. The request may still be running.";
            case 401:
                return "Your session may have expired. Sign in again and retry.";
            default:
                return null;
        }
    }
    if (isNetworkError(error)) {
        return "The browser could not reach the API. Check that the server is running and that your network connection is up.";
    }
    return null;
}

/** Formats any thrown value into a stable message string for the detail panel. */
function messageForError(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error);
    }
}

/** Default route error UI that replaces TanStack Router's unstyled fallback. */
export function RouteError(
    props: Pick<ErrorComponentProps, "error"> &
        Partial<Pick<ErrorComponentProps, "info" | "reset">>,
) {
    const router = useRouter();
    const [detailsOpen, setDetailsOpen] = React.useState(true);
    const title = titleForError(props.error);
    const hint = hintForError(props.error);
    const message = messageForError(props.error);
    const status =
        props.error instanceof ApiError ? props.error.status : null;
    const responseBody =
        props.error instanceof ApiError ? props.error.body : null;
    const errorName =
        props.error instanceof Error ? props.error.name : "Error";
    const stack =
        props.error instanceof Error && props.error.stack
            ? props.error.stack
            : null;
    const componentStack = props.info?.componentStack?.trim() || null;
    const hasTechnicalDetails = Boolean(
        stack || componentStack || responseBody,
    );

    /** Retries the failed match when TanStack provides reset; otherwise reloads loaders. */
    const retry = () => {
        if (props.reset) {
            props.reset();
            return;
        }
        void router.invalidate();
    };

    return (
        <div
            role="alert"
            className="flex min-h-full items-center justify-center p-6"
        >
            <div className="w-full max-w-xl rounded-xl border border-red-900/60 bg-[#141821] shadow-lg shadow-black/40">
                <div className="border-b border-red-900/40 px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-400">
                            <AlertTriangle
                                className="h-5 w-5"
                                aria-hidden="true"
                            />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <h1 className="text-lg font-semibold text-slate-100">
                                    {title}
                                </h1>
                                {status !== null ? (
                                    <span
                                        aria-label={`HTTP status ${status}`}
                                        className="rounded-md border border-red-800/80 bg-red-950/50 px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-red-300"
                                    >
                                        {status}
                                    </span>
                                ) : null}
                            </div>
                            <p className="mt-1 break-words text-sm text-slate-300">
                                {message}
                            </p>
                            {hint ? (
                                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                                    {hint}
                                </p>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div className="space-y-3 px-5 py-4">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-slate-500">Type</dt>
                        <dd className="font-mono text-xs text-slate-300">
                            {errorName}
                        </dd>
                        {status !== null ? (
                            <>
                                <dt className="text-slate-500">HTTP status</dt>
                                <dd className="font-mono text-xs text-slate-300">
                                    {status}
                                </dd>
                            </>
                        ) : null}
                    </dl>

                    {hasTechnicalDetails ? (
                        <div className="rounded-lg border border-slate-800 bg-[#0b0d12]">
                            <button
                                type="button"
                                aria-expanded={detailsOpen}
                                onClick={() => setDetailsOpen((open) => !open)}
                                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-slate-200"
                            >
                                Technical details
                                <ChevronDown
                                    className={`h-4 w-4 shrink-0 transition-transform ${
                                        detailsOpen ? "rotate-180" : ""
                                    }`}
                                    aria-hidden="true"
                                />
                            </button>
                            {detailsOpen ? (
                                <div className="space-y-3 border-t border-slate-800 px-3 py-3">
                                    {responseBody ? (
                                        <div>
                                            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                                Response body
                                            </p>
                                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-400">
                                                {responseBody}
                                            </pre>
                                        </div>
                                    ) : null}
                                    {stack ? (
                                        <div>
                                            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                                Stack
                                            </p>
                                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-400">
                                                {stack}
                                            </pre>
                                        </div>
                                    ) : null}
                                    {componentStack ? (
                                        <div>
                                            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                                Component stack
                                            </p>
                                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-500">
                                                {componentStack}
                                            </pre>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2 pt-1">
                        <button
                            type="button"
                            onClick={retry}
                            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
                        >
                            <RefreshCw
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            Try again
                        </button>
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5"
                        >
                            Reload page
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
