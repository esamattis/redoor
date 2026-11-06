import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Info, Users } from "lucide-react";

import type { SystemdUserSummary } from "#bindings/SystemdUserSummary";
import type { Agent } from "#ui/api-client";
import { systemdScopeRoute } from "#ui/browser-route";
import { systemdOverviewQueryOptions } from "#ui/systemd-queries";
import { cn } from "#ui/utils/cn";

/** A yes/no state that reads at a glance in both the table and the cards. */
function StateText(props: { on: boolean; onText: string; offText: string }) {
    return (
        <span
            className={cn(
                "text-sm",
                props.on ? "text-emerald-300" : "text-slate-500",
            )}
        >
            {props.on ? props.onText : props.offText}
        </span>
    );
}

/** One account as a table row in wide columns and a card in phone-narrow ones. */
function UserRow(props: { agent: Agent; user: SystemdUserSummary }) {
    return (
        <li
            aria-label={`User ${props.user.name}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-3 last:border-b-0 @xl:grid-cols-[minmax(0,1fr)_6rem_8rem_10rem] @xl:items-center @xl:gap-4 @xl:py-2"
        >
            <Link
                {...systemdScopeRoute(props.agent, {
                    type: "user",
                    name: props.user.name,
                })}
                className="min-w-0 truncate py-1 font-medium text-blue-300 hover:text-blue-200 hover:underline @xl:py-0"
            >
                {props.user.name}
            </Link>
            <span className="text-sm tabular-nums text-slate-400">
                <span className="@xl:hidden">UID </span>
                {props.user.uid}
            </span>
            <StateText
                on={props.user.linger}
                onText="Linger on"
                offText="Linger off"
            />
            <StateText
                on={props.user.manager_running}
                onText="Manager running"
                offText="Manager not running"
            />
        </li>
    );
}

/**
 * Lists the accounts whose managers a root agent can manage, with the linger and manager
 * state that decide whether their units can run without a login.
 */
export function SystemdUsersList(props: { agent: Agent }) {
    const { data: overview } = useSuspenseQuery(
        systemdOverviewQueryOptions(props.agent),
    );

    return (
        <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-slate-100">Users</h2>
            {overview.users_truncated ? (
                <p className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-400">
                    <Info
                        className="mt-0.5 h-4 w-4 shrink-0 text-blue-400"
                        aria-hidden="true"
                    />
                    The device has more accounts than this list can show.
                </p>
            ) : null}
            {overview.users.length === 0 ? (
                <section className="rounded-lg border border-dashed border-slate-700 bg-slate-900/25 px-6 py-12 text-center">
                    <Users
                        className="mx-auto h-8 w-8 text-slate-600"
                        aria-hidden="true"
                    />
                    <p className="mt-3 text-sm text-slate-400">
                        No user accounts with a systemd manager.
                    </p>
                </section>
            ) : (
                <div className="overflow-hidden rounded-lg border border-slate-800 bg-surface">
                    <div
                        aria-hidden="true"
                        className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_10rem] gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 @xl:grid"
                    >
                        <span>User</span>
                        <span>UID</span>
                        <span>Linger</span>
                        <span>Manager</span>
                    </div>
                    <ul aria-label="Users">
                        {overview.users.map((user) => (
                            <UserRow
                                key={user.name}
                                agent={props.agent}
                                user={user}
                            />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
