import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { z } from "zod";
import { Button } from "#ui/components/button";
import { Password } from "#ui/components/password";
import { TextField } from "#ui/components/text-field";
import { getErrorMessage } from "#ui/utils/error";

const loginSearchSchema = z.object({
    redirect: z.string().optional(),
    oidc_error: z.string().optional(),
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

/** Presents the only public UI route and resumes the exact protected URL after login. */
function LoginPage() {
    const { api } = Route.useRouteContext();
    const search = Route.useSearch();
    const methods = Route.useLoaderData();
    const [username, setUsername] = React.useState("");
    const [password, setPassword] = React.useState("");

    const oidcError = oidcErrorMessage(search.oidc_error);

    // The hint lives in the URL fragment, which the router does not parse and which never
    // changes on this page, so reading it once on mount is enough.
    const [firstRunMessage] = React.useState(messageFromLocationHash);

    const loginMutation = useMutation({
        mutationFn: (credentials: { username: string; password: string }) =>
            api.login(credentials.username, credentials.password),
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
        loginMutation.mutate({ username, password });
    };

    const error = loginMutation.isError
        ? getErrorMessage(loginMutation.error, "Login failed")
        : null;

    const isSubmitting = loginMutation.isPending;

    return (
        <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
            <div className="flex w-full max-w-sm flex-col gap-4">
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
