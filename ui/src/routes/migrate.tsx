import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ArrowRight, LoaderCircle, LogOut, ShieldAlert } from "lucide-react";
import { z } from "zod";
import type { MigrationSummary } from "#bindings/MigrationSummary";
import { Button } from "#ui/components/button";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage } from "#ui/utils/error";

const migrateSearchSchema = z.object({
    redirect: z.string().optional(),
});

/** Accepts only same-origin application paths so redirects stay inside the app. */
function safeRedirectPath(value: string | undefined): string {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/";
    }

    return value;
}

/** Formats the server's auth method identifier for display on the migration screen. */
function formatAuthMethod(authMethod: string): string {
    switch (authMethod) {
        case "oidc":
            return "Single Sign-On (OIDC)";
        case "password":
            return "Password";
        default:
            return authMethod;
    }
}

/**
 * TEMPORARY MIGRATION: Full-page confirmation screen shown on first sign-in after upgrading
 * from the legacy global single-account layout to per-user workspaces. Can be removed once
 * all deployed servers have upgraded to layout version 2.
 */
export const Route = createFileRoute("/migrate")({
    validateSearch: migrateSearchSchema,
    loader: async ({ context }) => {
        const [migration, currentUser] = await Promise.all([
            context.api.getMigrationStatus(),
            context.api.getCurrentUser(),
        ]);

        if (!migration.pending || migration.summary === null) {
            throw redirect({ to: "/" });
        }

        return {
            summary: migration.summary,
            currentUser,
        };
    },
    component: MigratePage,
});

/** Renders the inventory of legacy global data that will move into the signed-in workspace. */
function MigrationSummaryCard(props: {
    username: string;
    summary: MigrationSummary;
}) {
    return (
        <div className="mt-5 space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-sm">
            <p className="font-medium text-slate-200">
                Data to migrate into{" "}
                <span className="font-semibold text-slate-100">
                    {props.username}
                </span>
                :
            </p>
            <ul className="space-y-2 text-slate-300">
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-slate-400">Managed devices</span>
                    <span className="font-medium text-slate-100">
                        {props.summary.managed_device_count}
                    </span>
                </li>
                {props.summary.managed_device_names.length > 0 ? (
                    <li className="break-words pl-3 text-xs text-slate-400">
                        {props.summary.managed_device_names.join(", ")}
                    </li>
                ) : null}
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-slate-400">Encrypted vault</span>
                    <span className="font-medium text-slate-100">
                        {props.summary.has_vault ? "Present" : "None"}
                    </span>
                </li>
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-slate-400">Managed SSH keys</span>
                    <span className="font-medium text-slate-100">
                        {props.summary.ssh_key_count}
                    </span>
                </li>
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-slate-400">Access tokens</span>
                    <span className="font-medium text-slate-100">
                        {props.summary.access_token_count}
                    </span>
                </li>
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-slate-400">
                        Agent registration token
                    </span>
                    <span className="font-medium text-slate-100">
                        {props.summary.agent_token !== null
                            ? "Preserved"
                            : "New token generated"}
                    </span>
                </li>
            </ul>
        </div>
    );
}

/**
 * Presents the legacy resources that will move into the signed-in user's workspace and lets
 * the operator either confirm or sign out to switch to a different account first.
 */
function MigratePage() {
    const { api, queryClient } = Route.useRouteContext();
    const { summary, currentUser } = Route.useLoaderData();
    const search = Route.useSearch();
    const router = useRouter();

    const confirmMutation = useMutation({
        mutationFn: () => api.confirmMigration(),
        onSuccess: () => {
            queryClient.clear();
            window.location.replace(safeRedirectPath(search.redirect));
        },
    });

    const logoutMutation = useMutation({
        mutationFn: () => api.logout(),
        onSuccess: () => {
            queryClient.clear();
            window.location.replace(
                router.buildLocation({
                    to: "/login",
                    search: { redirect: search.redirect },
                }).href,
            );
        },
    });

    const isBusy = confirmMutation.isPending || logoutMutation.isPending;
    const error = confirmMutation.isError
        ? getErrorMessage(confirmMutation.error, "Migration failed")
        : logoutMutation.isError
          ? getErrorMessage(logoutMutation.error, "Sign out failed")
          : null;

    return (
        <main className="flex min-h-screen items-center justify-center bg-canvas p-4 sm:p-6">
            <div className="flex w-full max-w-lg flex-col gap-4">
                <div className="w-full rounded-xl border border-slate-800 bg-surface p-6 shadow-2xl sm:p-8">
                    <div className="mb-6 flex items-center justify-center gap-3">
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

                    <h1 className="text-center text-2xl font-bold text-slate-100">
                        Migrate existing workspace
                    </h1>
                    <p className="mt-2 text-center text-sm text-slate-400">
                        Redoor now isolates devices, vaults, SSH keys, and
                        access tokens per user. Choose which account should
                        receive this server&apos;s existing data.
                    </p>

                    <div className="mt-6 rounded-lg border border-slate-700/80 bg-slate-900/60 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                                Signed in as
                            </span>
                            <span className="text-xs text-slate-400">
                                {formatAuthMethod(currentUser.method)}
                            </span>
                        </div>
                        <p className="mt-1 break-all text-base font-semibold text-slate-100">
                            {currentUser.name}
                        </p>
                    </div>

                    <MigrationSummaryCard
                        username={currentUser.name}
                        summary={summary}
                    />

                    <div className="mt-5 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                        <ShieldAlert
                            className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                            aria-hidden="true"
                        />
                        <p>
                            Existing standalone agents will reconnect to{" "}
                            <span className="font-semibold text-amber-100">
                                {currentUser.name}
                            </span>{" "}
                            automatically. Other accounts will start with their
                            own empty workspace.
                        </p>
                    </div>

                    {error !== null ? (
                        <p
                            role="alert"
                            className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                        >
                            {error}
                        </p>
                    ) : null}

                    <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
                        <Tooltip content="Move the existing server data into this account's workspace">
                            <Button
                                type="button"
                                variant="primary"
                                disabled={isBusy}
                                onClick={() => confirmMutation.mutate()}
                                className="w-full justify-center sm:flex-1"
                            >
                                {confirmMutation.isPending ? (
                                    <LoaderCircle
                                        className="h-4 w-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <ArrowRight
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                )}
                                <span>Migrate to {currentUser.name}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip content="Sign out so you can sign in with a different account before migrating">
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => logoutMutation.mutate()}
                                className="w-full justify-center sm:w-auto"
                            >
                                <LogOut
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                <span>Switch account</span>
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </main>
    );
}
