import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle, LogIn } from "lucide-react";
import { z } from "zod";
import { Password } from "../components/password";

const loginSearchSchema = z.object({
    redirect: z.string().optional(),
});

export const Route = createFileRoute("/login")({
    validateSearch: loginSearchSchema,
    component: LoginPage,
});

/** Accepts only same-origin application paths so credentials cannot enable an open redirect. */
function safeRedirectPath(value: string | undefined): string {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/";
    }
    return value;
}

/** Presents the only public UI route and resumes the exact protected URL after login. */
function LoginPage() {
    const { api } = Route.useRouteContext();
    const search = Route.useSearch();
    const [username, setUsername] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    /** Keeps the password out of URLs and clears it immediately after either outcome. */
    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        setIsSubmitting(true);
        try {
            await api.login(username, password);
            setPassword("");
            window.location.replace(safeRedirectPath(search.redirect));
        } catch (submitError) {
            setPassword("");
            setError(
                submitError instanceof Error
                    ? submitError.message
                    : "Login failed",
            );
            setIsSubmitting(false);
        }
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-[#0b0d12] p-6">
            <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-[#11141b] p-8 shadow-2xl">
                <div className="mb-8 flex items-center justify-center gap-3">
                    <img
                        src="/logo.svg"
                        alt=""
                        aria-hidden="true"
                        className="h-9 w-9"
                    />
                    <span className="text-xl font-semibold text-slate-100">
                        Redoor
                    </span>
                </div>
                <h1 className="mb-6 text-center text-2xl font-bold text-slate-100">
                    Sign in to Redoor
                </h1>
                <form onSubmit={submit} className="space-y-5">
                    <label className="block text-sm font-medium text-slate-300">
                        Username
                        <input
                            autoFocus
                            autoComplete="username"
                            value={username}
                            disabled={isSubmitting}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            className="mt-2 w-full rounded-md border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
                        />
                    </label>
                    <Password
                        label="Password"
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
                    <button
                        type="submit"
                        disabled={isSubmitting || !username || !password}
                        className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isSubmitting ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                            <LogIn className="h-4 w-4" />
                        )}
                        {isSubmitting ? "Signing in…" : "Sign in"}
                    </button>
                </form>
            </div>
        </main>
    );
}
