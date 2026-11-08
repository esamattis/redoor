import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, LoaderCircle, LogIn, ShieldAlert } from "lucide-react";
import { z } from "zod";
import type { SessionLength } from "#bindings/SessionLength";
import { Button } from "#ui/components/button";
import { Password } from "#ui/components/password";
import { Select } from "#ui/components/select";
import { TextField } from "#ui/components/text-field";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage } from "#ui/utils/error";

/** The session lengths the login page offers, shortest first, with their labels. */
const SESSION_LENGTHS = [
    { value: "hour", label: "1 hour" },
    { value: "day", label: "24 hours" },
    { value: "week", label: "1 week" },
    { value: "month", label: "1 month" },
    { value: "year", label: "1 year" },
] as const satisfies readonly { value: SessionLength; label: string }[];

/** Matches the server's default, so a link without the parameter gets the shortest session. */
const DEFAULT_SESSION_LENGTH: SessionLength = "hour";

const sessionLengthSchema: z.ZodType<SessionLength> = z.enum([
    "hour",
    "day",
    "week",
    "month",
    "year",
]);

const loginSearchSchema = z.object({
    redirect: z.string().optional(),
    oidc_error: z.string().optional(),
    // In the URL rather than component state, so the choice survives the server's redirect
    // back here after a failed OIDC sign-in. A bad value falls back to the default.
    session: sessionLengthSchema.optional().catch(undefined),
    // Why the previous session ended, when the user should know. A fixed value rather than
    // text, so a crafted link cannot put arbitrary wording on the sign-in page.
    reason: z.enum(["reused"]).optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
    validateSearch: loginSearchSchema,
    // The page has to know before rendering whether to lead with the identity provider.
    loader: ({ context }) => context.api.getLoginMethods(),
    component: LoginPage,
});

/**
 * Maps the server's failure codes to fixed text, so a crafted link cannot put arbitrary
 * wording on the sign-in page.
 */
function oidcErrorMessage(code: string | undefined): string | null {
    switch (code) {
        case undefined:
            return null;
        case "denied":
            return "Your account is not allowed to sign in to Redoor.";
        case "expired":
            return "The sign-in expired or was started in another browser. Try again.";
        case "unavailable":
            return "The identity provider could not be reached. Try again later.";
        default:
            return "Sign-in failed. Try again.";
    }
}

/** Accepts only same-origin application paths so credentials cannot enable an open redirect. */
function safeRedirectPath(value: string | undefined): string {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/";
    }

    return value;
}

/** Reads a first-run credential hint from the URL fragment without sending it to the server. */
function messageFromLocationHash(): string | null {
    const raw = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;

    if (!raw) {
        return null;
    }

    const params = new URLSearchParams(raw);
    const message = params.get("message")?.trim();

    return message ? message : null;
}

/**
 * Explains a sign-out caused by the session cookie being used from two browsers, which is
 * what a copied browser profile looks like, and points to what the user can check.
 */
function SessionReusedNotice() {
    return (
        <div
            role="alert"
            className="flex gap-3 rounded-xl border border-amber-400/50 bg-amber-500/15 px-5 py-4 text-sm text-amber-50 shadow-2xl shadow-amber-950/40"
        >
            <ShieldAlert
                className="mt-0.5 h-5 w-5 shrink-0 text-amber-200"
                aria-hidden="true"
            />
            <p>
                You were signed out because this session was used from another
                browser at the same time. If that wasn't you, change your
                password and check the{" "}
                {/* A full page load, so the signed-out app sends the user through this
                    page with the sessions page as the way back. */}
                <Link
                    to="/settings/sessions"
                    reloadDocument
                    className="font-medium text-amber-200 underline underline-offset-2 hover:text-amber-100"
                >
                    signed-in sessions
                </Link>
                .
            </p>
        </div>
    );
}

/** Presents the only public UI route and resumes the exact protected URL after login. */
function LoginPage() {
    const { api } = Route.useRouteContext();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const methods = Route.useLoaderData();
    const sessionLength = search.session ?? DEFAULT_SESSION_LENGTH;
    const [username, setUsername] = React.useState("");
    const [password, setPassword] = React.useState("");

    const oidcError = oidcErrorMessage(search.oidc_error);

    // The hint lives in the URL fragment, which the router does not parse and which never
    // changes on this page, so reading it once on mount is enough.
    const [firstRunMessage] = React.useState(messageFromLocationHash);

    const loginMutation = useMutation({
        mutationFn: (credentials: {
            username: string;
            password: string;
            sessionLength: SessionLength;
        }) =>
            api.login(
                credentials.username,
                credentials.password,
                credentials.sessionLength,
            ),
        onSuccess: () => {
            window.location.replace(safeRedirectPath(search.redirect));
        },
        onSettled: () => {
            setPassword("");
        },
    });

    /** Keeps the password out of URLs and clears it immediately after either outcome. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        loginMutation.mutate({ username, password, sessionLength });
    };

    const error = loginMutation.isError
        ? getErrorMessage(loginMutation.error, "Login failed")
        : null;

    const isSubmitting = loginMutation.isPending;

    /** Keeps the choice in the URL; replacing the entry keeps "back" from stepping through it. */
    const changeSessionLength = (
        event: React.ChangeEvent<HTMLSelectElement>,
    ) => {
        const parsed = sessionLengthSchema.safeParse(event.target.value);

        if (!parsed.success) {
            return;
        }

        void navigate({
            search: (previous) => ({ ...previous, session: parsed.data }),
            replace: true,
        });
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
            <div className="flex w-full max-w-sm flex-col gap-4">
                {search.reason === "reused" ? <SessionReusedNotice /> : null}
                {firstRunMessage ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="rounded-xl border border-amber-400/50 bg-amber-500/15 px-5 py-4 text-center shadow-2xl shadow-amber-950/40"
                    >
                        <p className="text-sm font-semibold uppercase tracking-wide text-amber-200">
                            Getting started
                        </p>
                        <p className="mt-2 text-base font-medium text-amber-50">
                            {firstRunMessage}
                        </p>
                    </div>
                ) : null}
                <div className="w-full rounded-xl border border-slate-800 bg-surface p-8 shadow-2xl">
                    <div className="mb-8 flex items-center justify-center gap-3">
                        <span
                            className="relative h-9 w-9 shrink-0"
                            aria-hidden="true"
                        >
                            <img
                                src="/logo-dark.svg"
                                alt=""
                                className="theme-logo-dark absolute inset-0 h-9 w-9"
                            />
                            <img
                                src="/logo-light.svg"
                                alt=""
                                className="theme-logo-light absolute inset-0 h-9 w-9"
                            />
                        </span>
                        <span className="text-xl font-semibold text-slate-100">
                            Redoor
                        </span>
                    </div>
                    <h1 className="mb-6 text-center text-2xl font-bold text-slate-100">
                        Sign in to Redoor
                    </h1>
                    {/* Above both sign-in methods, because the choice applies to either. */}
                    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                        <label
                            htmlFor="session-length"
                            className="text-sm font-medium text-slate-300"
                        >
                            Stay signed in for
                        </label>
                        <Tooltip content="You are signed out after this long without activity. Any interaction with the page starts the time again.">
                            <Select
                                id="session-length"
                                value={sessionLength}
                                disabled={isSubmitting}
                                onChange={changeSessionLength}
                                containerClassName="min-w-36"
                            >
                                {SESSION_LENGTHS.map((length) => (
                                    <option
                                        key={length.value}
                                        value={length.value}
                                    >
                                        {length.label}
                                    </option>
                                ))}
                            </Select>
                        </Tooltip>
                    </div>
                    {methods.oidc ? (
                        <div className="space-y-4">
                            {oidcError ? (
                                <p
                                    role="alert"
                                    className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                                >
                                    {oidcError}
                                </p>
                            ) : null}
                            <Button
                                as="a"
                                size="lg"
                                href={api.getOidcLoginUrl(
                                    safeRedirectPath(search.redirect),
                                    sessionLength,
                                )}
                                className="w-full rounded-md"
                            >
                                <KeyRound className="h-4 w-4" />
                                Sign in with {methods.oidc.provider_name}
                            </Button>
                        </div>
                    ) : null}
                    <form
                        onSubmit={submit}
                        className={
                            methods.oidc
                                ? "mt-6 space-y-5 border-t border-slate-800 pt-6"
                                : "space-y-5"
                        }
                    >
                        <TextField
                            label="Username"
                            value={username}
                            placeholder="Username"
                            description="Your Redoor account username."
                            required
                            // Focusing the field would pop the phone keyboard over
                            // the provider button that leads the page.
                            autoFocus={methods.oidc === null}
                            autoComplete="username"
                            disabled={isSubmitting}
                            onChange={setUsername}
                        />
                        <Password
                            label="Password"
                            placeholder="Password"
                            autoComplete="current-password"
                            value={password}
                            disabled={isSubmitting}
                            onChange={setPassword}
                        />
                        {error ? (
                            <p
                                role="alert"
                                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                            >
                                {error}
                            </p>
                        ) : null}
                        <Button
                            type="submit"
                            size="lg"
                            disabled={isSubmitting || !username || !password}
                            isLoading={isSubmitting}
                            className="w-full rounded-md disabled:opacity-60"
                        >
                            {isSubmitting ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                                <LogIn className="h-4 w-4" />
                            )}
                            {isSubmitting ? "Signing in…" : "Sign in"}
                        </Button>
                    </form>
                </div>
            </div>
        </main>
    );
}
