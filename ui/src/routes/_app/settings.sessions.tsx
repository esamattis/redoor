import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    CalendarClock,
    CalendarPlus,
    LogOut,
    MonitorSmartphone,
    Network,
    Route as RouteIcon,
    UserRound,
} from "lucide-react";

import type { BrowserSession } from "#bindings/BrowserSession";
import { browserSessionsQueryOptions, queryKeys } from "#ui/queries";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { FactItem } from "#ui/components/fact-item";
import { RelativeTime } from "#ui/components/relative-time";
import { Toast } from "#ui/components/toast";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import { describeUserAgent } from "#ui/utils/user-agent";

export const Route = createFileRoute("/_app/settings/sessions")({
    loader: async ({ context }) => {
        await context.queryClient.ensureQueryData(
            browserSessionsQueryOptions(context.api),
        );
    },
    component: BrowserSessionsPage,
});

/** Which sign-out the confirmation dialog is asking about. */
type PendingSignOut =
    { kind: "one"; session: BrowserSession } | { kind: "others" };

/**
 * Lists every signed-in browser with where it signed in from, so a user can spot a browser
 * they forgot or do not recognise and sign it out without being at that browser.
 */
function BrowserSessionsPage() {
    const { api } = Route.useRouteContext();
    const queryClient = useQueryClient();
    const sessionsQuery = useQuery(browserSessionsQueryOptions(api));
    const [pending, setPending] = React.useState<PendingSignOut | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);

    const refresh = async () =>
        queryClient.invalidateQueries({
            queryKey: queryKeys.browserSessions(),
        });

    const signOut = useMutation({
        mutationFn: (request: PendingSignOut) =>
            request.kind === "one"
                ? api.signOutBrowserSession(request.session.id)
                : api.signOutOtherBrowserSessions(),
        onSuccess: async (result, request) => {
            setPending(null);
            setNotice(
                request.kind === "one"
                    ? "Session signed out."
                    : `Signed out ${result.signed_out} other ${
                          result.signed_out === 1 ? "session" : "sessions"
                      }.`,
            );
            await refresh();
        },
    });

    const sessions = sessionsQuery.data?.sessions ?? [];
    const otherCount = sessions.filter((session) => !session.current).length;

    /** Opens a confirmation, dropping the error of an earlier attempt. */
    const confirm = (request: PendingSignOut) => {
        signOut.reset();
        setPending(request);
    };

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <div className="mx-auto max-w-5xl">
                <SessionsHeader
                    sessionCount={sessions.length}
                    otherCount={otherCount}
                    onSignOutOthers={() => confirm({ kind: "others" })}
                />
                {sessionsQuery.isError ? (
                    <p
                        role="alert"
                        className="mt-6 rounded border border-red-800 bg-red-950/20 p-4 text-red-300"
                    >
                        Could not load sessions.{" "}
                        <Button
                            tooltip="Reload the session list"
                            type="button"
                            variant="subtle"
                            onClick={() => void sessionsQuery.refetch()}
                        >
                            Try again
                        </Button>
                    </p>
                ) : sessionsQuery.isLoading ? (
                    <p className="mt-8 text-slate-400">Loading sessions…</p>
                ) : (
                    <ul aria-label="Sessions" className="mt-6 grid gap-4">
                        {sessions.map((session) => (
                            <li key={session.id}>
                                <SessionCard
                                    session={session}
                                    onSignOut={() =>
                                        confirm({ kind: "one", session })
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <ConfirmationDialog
                isOpen={pending !== null}
                title={
                    pending?.kind === "others"
                        ? "Sign out all other sessions?"
                        : "Sign out session?"
                }
                description={
                    pending?.kind === "one"
                        ? `${describeUserAgent(pending.session.user_agent)} signed in from ${pending.session.ip} must sign in again to use Redoor.`
                        : "Every browser except this one must sign in again to use Redoor."
                }
                confirmLabel={
                    pending?.kind === "others" ? "Sign out others" : "Sign out"
                }
                busyLabel="Signing out…"
                isBusy={signOut.isPending}
                errorMessage={
                    signOut.isError
                        ? getErrorMessage(
                              signOut.error,
                              "Could not sign out the session",
                          )
                        : null
                }
                onClose={() => setPending(null)}
                onConfirm={() => {
                    if (pending) signOut.mutate(pending);
                }}
            />
            {notice ? (
                <Toast
                    key={notice}
                    tone="success"
                    onDismiss={() => setNotice(null)}
                >
                    {notice}
                </Toast>
            ) : null}
        </div>
    );
}

/** Pairs the page purpose with the sign-out-everywhere-else action. */
function SessionsHeader(props: {
    sessionCount: number;
    otherCount: number;
    onSignOutOthers: () => void;
}) {
    return (
        <header className="overflow-hidden rounded-xl border border-slate-800 bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 @xl:px-8">
                <div className="flex min-w-0 items-start gap-4">
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 text-blue-300">
                        <MonitorSmartphone
                            className="h-6 w-6"
                            aria-hidden="true"
                        />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-slate-100">
                            Sessions
                        </h1>
                        <p className="mt-1 max-w-2xl text-sm text-slate-400">
                            Browsers signed in to this server, with the address
                            they signed in from. Sign out any you do not
                            recognise.
                        </p>
                    </div>
                </div>
                <Button
                    tooltip={
                        props.otherCount === 0
                            ? "No other browser is signed in"
                            : "Sign out every browser except this one"
                    }
                    type="button"
                    variant="danger"
                    disabled={props.otherCount === 0}
                    onClick={props.onSignOutOthers}
                >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sign out all other sessions
                </Button>
            </div>
            {props.sessionCount > 0 ? (
                <p className="border-t border-slate-800 px-6 py-2.5 text-xs text-slate-500 @xl:px-8">
                    {props.sessionCount}{" "}
                    {props.sessionCount === 1 ? "session" : "sessions"} ·{" "}
                    {props.otherCount} other
                </p>
            ) : null}
        </header>
    );
}

/** One signed-in browser and what the server saw when it signed in. */
function SessionCard(props: {
    session: BrowserSession;
    onSignOut: () => void;
}) {
    const title = describeUserAgent(props.session.user_agent);

    return (
        <article
            aria-label={
                props.session.current ? `${title} (this browser)` : title
            }
            className={cn(
                "overflow-hidden rounded-xl border bg-surface",
                props.session.current
                    ? "border-blue-500/40"
                    : "border-slate-800",
            )}
        >
            <div className="flex flex-wrap items-start gap-4 p-5">
                <div className="shrink-0 rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 text-blue-300">
                    <MonitorSmartphone className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-100">
                            {title}
                        </h2>
                        {props.session.current ? (
                            <span className="inline-flex items-center rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-300">
                                This browser
                            </span>
                        ) : null}
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-slate-400">
                        {props.session.user_agent ?? "No user agent sent"}
                    </p>
                </div>
                {props.session.current ? null : (
                    <Button
                        tooltip="End this session so the browser must sign in again"
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={props.onSignOut}
                    >
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                        Sign out
                    </Button>
                )}
            </div>
            <dl className="grid grid-cols-1 gap-px border-t border-slate-800 bg-slate-800 @xl:grid-cols-2 @4xl:grid-cols-3">
                <FactItem
                    label="IP address"
                    icon={<Network className="h-3.5 w-3.5" />}
                >
                    {props.session.ip}
                </FactItem>
                <FactItem
                    label="Forwarded for"
                    icon={<RouteIcon className="h-3.5 w-3.5" />}
                >
                    {props.session.forwarded_for ?? (
                        <span className="text-slate-400">Not forwarded</span>
                    )}
                </FactItem>
                <FactItem
                    label="User"
                    icon={<UserRound className="h-3.5 w-3.5" />}
                >
                    {props.session.name}{" "}
                    <span className="text-slate-400">
                        ({props.session.method === "oidc" ? "OIDC" : "password"}
                        )
                    </span>
                </FactItem>
                <FactItem
                    label="Signed in"
                    icon={<CalendarPlus className="h-3.5 w-3.5" />}
                >
                    <RelativeTime value={props.session.created_at} />
                </FactItem>
                <FactItem
                    label="Expires when idle"
                    icon={<CalendarClock className="h-3.5 w-3.5" />}
                >
                    <RelativeTime value={props.session.expires_at} />
                </FactItem>
            </dl>
        </article>
    );
}
