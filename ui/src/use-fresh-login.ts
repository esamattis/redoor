import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";

import type { CurrentUserResponse } from "#bindings/CurrentUserResponse";
import { ApiError } from "#ui/api-transport";
import { currentUserQueryOptions } from "#ui/queries";

const rootRouteApi = getRouteApi("__root__");

/**
 * Seconds of freshness a request must still have when it leaves, so a session that is
 * fresh by a hair does not run out on its way to the server and fail after all.
 */
const FRESH_LOGIN_MARGIN_SECONDS = 5;

/**
 * When the fresh sign-in of `user` stops being usable, on this browser's clock. The server
 * counts on its own clock, so this counts from when the answer arrived instead of trusting
 * the two clocks to agree. A session that can never mint tokens is stale from the start.
 */
function freshUntil(user: CurrentUserResponse, fetchedAt: number): number {
    if (user.fresh_login_seconds_left === null) {
        return 0;
    }

    return (
        fetchedAt +
        (user.fresh_login_seconds_left - FRESH_LOGIN_MARGIN_SECONDS) * 1000
    );
}

/**
 * Creating, rotating and approving access tokens needs a sign-in from the last minute, so a
 * copied browser profile cannot mint tokens. Forms that hand out tokens keep their state in
 * the URL and use this to send the user through the sign-in as the very last step, which
 * returns them to the same filled-in form.
 */
export function useFreshLogin() {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const router = useRouter();

    // Refetched whenever a form that needs it opens, so the hint is about this session now.
    const user = useQuery({ ...currentUserQueryOptions(api), staleTime: 0 });

    const staleAt = user.data
        ? freshUntil(user.data, user.dataUpdatedAt)
        : null;

    const [now, setNow] = React.useState(Date.now);

    // Re-renders once the fresh minute runs out, so the hint appears without a keystroke.
    React.useEffect(() => {
        if (staleAt === null) return;

        const delay = staleAt - Date.now();

        if (delay <= 0) return;

        const timer = window.setTimeout(() => setNow(Date.now()), delay);

        return () => window.clearTimeout(timer);
    }, [staleAt]);

    /** Leaves for the login page, which returns to this exact URL with the form state. */
    const signIn = () => {
        void router.navigate({
            to: "/login",
            search: {
                fresh: true,
                redirect: `${window.location.pathname}${window.location.search}`,
            },
        });
    };

    /**
     * Runs `action` if the session is fresh enough and otherwise starts the sign-in, also
     * when the server says the minute ran out meanwhile. Resolves to null when the user is
     * sent to sign in, so the caller knows nothing was created.
     */
    const run = async <T>(action: () => Promise<T>): Promise<T | null> => {
        const current = await queryClient.fetchQuery({
            ...currentUserQueryOptions(api),
            staleTime: 0,
        });

        if (
            current.fresh_login_seconds_left === null ||
            current.fresh_login_seconds_left <= FRESH_LOGIN_MARGIN_SECONDS
        ) {
            signIn();

            return null;
        }

        try {
            return await action();
        } catch (error) {
            // The minute ran out between the check above and the server's own.
            const freshLoginRequired =
                error instanceof ApiError &&
                error.status === 403 &&
                error.code === "fresh_login_required";

            if (!freshLoginRequired) throw error;

            signIn();

            return null;
        }
    };

    return {
        /** The up-front hint that pressing the button will ask for the password first. */
        needsSignIn: staleAt !== null && staleAt <= now,
        run,
    };
}
