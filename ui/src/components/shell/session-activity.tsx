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
 * Keeps the browser session alive while the user works and warns before it ends.
 *
 * The server renews a session only when told about activity, never on ordinary requests, so
 * background polling of an unattended page cannot keep it signed in. Reports are sent only
 * while the page is visible and at most once a minute. When the session ends, the next
 * session check answers 401, which leads to the login page with a way back.
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

    const activity = useMutation({
        mutationFn: () => api.recordSessionActivity(),
        onSuccess: (session) => {
            queryClient.setQueryData(
                currentUserQueryOptions(api).queryKey,
                (previous) => (previous ? { ...previous, session } : previous),
            );
        },
    });

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
