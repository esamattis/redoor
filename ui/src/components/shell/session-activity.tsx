import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Clock } from "lucide-react";

import type { CurrentUserResponse } from "#bindings/CurrentUserResponse";
import { Toast } from "#ui/components/toast";
import { currentUserQueryOptions } from "#ui/queries";
import { useIsPast } from "#ui/utils/use-is-past";

const rootRouteApi = getRouteApi("__root__");

/**
 * Interactions that count as the user being present. Captured on the document, so keys
 * typed into a terminal, which stops their propagation, still count. `scroll` is left out on
 * purpose: scripts scroll too (the log viewer follows new lines), which would keep an
 * unattended page signed in forever, and a user scrolling already fires `wheel`,
 * `touchstart`, `keydown` or `pointerdown`.
 */
const ACTIVITY_EVENTS = [
    "pointerdown",
    "keydown",
    "wheel",
    "touchstart",
] as const;

/** At most one activity report per minute, matching the server's renewal granularity. */
const ACTIVITY_REPORT_INTERVAL_MS = 60_000;

/**
 * How often an open tab rotates the session cookie's secret, hidden tabs included. Keeps the
 * secret moving while nobody uses the page, so a copied cookie cannot be used quietly next
 * to an open tab. Chrome's heaviest throttling of background timers still fires about once
 * a minute, so the interval holds in hidden tabs too.
 */
const SESSION_ROTATION_INTERVAL_MS = 5 * 60_000;

/**
 * Web Lock that lets only one tab of the browser rotate at a time. Two tabs rotating at once
 * would be safe (the second presents the previous secret and the server does not rotate
 * again), but it would be a needless write.
 */
const ROTATION_LOCK_NAME = "redoor-session-rotation";

/** How long before the expiry the sign-out warning appears. */
const WARNING_LEAD_MS = 60_000;

/** Longest single wait before asking the server again, since sessions last up to a year. */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** How often an expiry that already passed is checked again, while a transfer keeps it. */
const EXPIRED_RECHECK_MS = 15_000;

/**
 * When the session ends on this browser's clock, or `null` for callers without a session.
 * Counts from when the answer arrived, so a browser clock that is off does not matter.
 */
function sessionDeadline(
    user: CurrentUserResponse | undefined,
    receivedAt: number,
): number | null {
    const session = user?.session;

    if (!session) {
        return null;
    }

    return receivedAt + session.expires_in_seconds * 1000;
}

/**
 * When to ask the server about the session again: at the warning, so activity in another
 * tab cancels it, and right after the expiry, whose 401 sends the page to the login form.
 */
function nextCheckDelay(deadline: number | null, now: number): number | false {
    if (deadline === null) {
        return false;
    }

    const remaining = deadline - now;

    if (remaining > WARNING_LEAD_MS) {
        return Math.min(remaining - WARNING_LEAD_MS, MAX_WAIT_MS);
    }

    if (remaining > 0) {
        return remaining + 1000;
    }

    return EXPIRED_RECHECK_MS;
}

/**
 * Keeps the browser session alive while the user works, rotates its cookie secret while the
 * tab is open, and warns before the session ends.
 *
 * The server renews a session only when told about activity, never on ordinary requests, so
 * background polling of an unattended page cannot keep it signed in. Reports are sent only
 * while the page is visible and at most once a minute. When the session ends, the next
 * session check answers 401, which leads to the login page with a way back.
 *
 * Every activity report and rotation can hand the browser a new secret, which is followed
 * at once by a request that presents it (see `confirmSession`).
 */
export function SessionActivity() {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    const currentUser = useQuery({
        ...currentUserQueryOptions(api),
        refetchInterval: (query) =>
            nextCheckDelay(
                sessionDeadline(query.state.data, query.state.dataUpdatedAt),
                Date.now(),
            ),
        // A hidden tab must still leave for the login page when its session ends.
        refetchIntervalInBackground: true,
    });

    const deadline = sessionDeadline(
        currentUser.data,
        currentUser.dataUpdatedAt,
    );

    /**
     * Sends a request with the cookie a rotation just set, which tells the server the browser
     * has the new secret while the old one is still in its 30 second grace period. Without
     * it an idle tab, or one used only through a terminal socket, could leave the new secret
     * unconfirmed for minutes, and a copied browser presenting the old secret meanwhile would
     * be handed the new one instead of being detected. `auth/me` never renews the session.
     */
    const confirmSession = () => {
        void queryClient.refetchQueries({
            queryKey: currentUserQueryOptions(api).queryKey,
        });
    };

    const activity = useMutation({
        mutationFn: () => api.recordSessionActivity(),
        onSuccess: (session) => {
            queryClient.setQueryData(
                currentUserQueryOptions(api).queryKey,
                (previous) => (previous ? { ...previous, session } : previous),
            );
            confirmSession();
        },
    });

    const rotation = useMutation({
        mutationFn: () => api.rotateSession(),
        onSuccess: confirmSession,
    });

    const rotateSession = React.useEffectEvent(() => {
        // Access tokens have no cookie to rotate.
        if (!currentUser.data?.session) {
            return;
        }

        // Web Locks only exist in secure contexts; plain HTTP rotates in every tab.
        if (!("locks" in navigator)) {
            rotation.mutate();

            return;
        }

        void navigator.locks.request(
            ROTATION_LOCK_NAME,
            { ifAvailable: true },
            async (lock) => {
                // Another tab is rotating right now, which covers this one too.
                if (!lock) {
                    return;
                }

                // A failure leaves the cookie as it was; a 401 already leads to the login page.
                await rotation.mutateAsync().catch(() => undefined);
            },
        );
    });

    // Only schedules the rotation; the request itself is a mutation.
    React.useEffect(() => {
        const timer = window.setInterval(
            () => rotateSession(),
            SESSION_ROTATION_INTERVAL_MS,
        );

        return () => window.clearInterval(timer);
    }, []);

    const lastReportRef = React.useRef(Number.NEGATIVE_INFINITY);

    const reportActivity = React.useEffectEvent(() => {
        if (document.visibilityState !== "visible") {
            return;
        }

        const now = Date.now();

        if (now - lastReportRef.current < ACTIVITY_REPORT_INTERVAL_MS) {
            return;
        }

        lastReportRef.current = now;
        activity.mutate();
    });

    // Only subscribes to DOM events; the report itself is a mutation.
    React.useEffect(() => {
        const listener = () => reportActivity();

        for (const type of ACTIVITY_EVENTS) {
            document.addEventListener(type, listener, {
                capture: true,
                passive: true,
            });
        }

        return () => {
            for (const type of ACTIVITY_EVENTS) {
                document.removeEventListener(type, listener, { capture: true });
            }
        };
    }, []);

    const isWarningDue = useIsPast(
        deadline === null ? null : deadline - WARNING_LEAD_MS,
    );

    // Dismissing hides the warning for this expiry only; a later one warns again.
    const [dismissedDeadline, setDismissedDeadline] = React.useState<
        number | null
    >(null);

    if (!isWarningDue || deadline === null || dismissedDeadline === deadline) {
        return null;
    }

    return (
        <Toast
            tone="info"
            icon={<Clock className="h-4 w-4" />}
            dismissAriaLabel="Dismiss sign-out warning"
            onDismiss={() => setDismissedDeadline(deadline)}
        >
            You will be signed out in about a minute because of inactivity. Any
            interaction keeps you signed in.
        </Toast>
    );
}
