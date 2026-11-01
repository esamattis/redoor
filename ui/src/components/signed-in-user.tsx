import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { UserRound } from "lucide-react";

import type { AuthMethod } from "#bindings/AuthMethod";
import type { CurrentUserResponse } from "#bindings/CurrentUserResponse";
import { currentUserQueryOptions } from "#ui/queries";
import { cn } from "#ui/utils/cn";

const rootRouteApi = getRouteApi("__root__");

/** How the UI names each sign-in method. */
export function authMethodLabel(method: AuthMethod): string {
    switch (method) {
        case "password":
            return "Password";
        case "oidc":
            return "Single sign-on";
        case "token":
            return "Access token";
    }
}

/**
 * Who is signed in, or `undefined` while it loads. Only the password method can change its
 * password in the UI, so callers also use this to decide whether to offer the form.
 */
export function useCurrentUser(): CurrentUserResponse | undefined {
    const { api } = rootRouteApi.useRouteContext();

    return useQuery(currentUserQueryOptions(api)).data;
}

/**
 * "Signed in as <name>" with the method below it. Several people may sign in to the same
 * account, so the UI says which of them this browser is. Long names truncate so the line
 * fits a phone-narrow menu.
 */
export function SignedInUser(props: {
    user: CurrentUserResponse;
    className?: string;
}) {
    return (
        <div
            className={cn("flex min-w-0 items-center gap-2", props.className)}
            aria-label={`Signed in as ${props.user.name} with ${authMethodLabel(props.user.method)}`}
        >
            <UserRound
                className="h-4 w-4 shrink-0 text-slate-400"
                aria-hidden="true"
            />
            <div className="min-w-0">
                <p className="truncate text-sm text-slate-100">
                    Signed in as{" "}
                    <span className="font-medium">{props.user.name}</span>
                </p>
                <p className="truncate text-xs text-slate-400">
                    {authMethodLabel(props.user.method)}
                </p>
            </div>
        </div>
    );
}
