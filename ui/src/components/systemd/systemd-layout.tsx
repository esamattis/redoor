import type * as React from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMatches, useNavigate, useParams } from "@tanstack/react-router";
import { Server, User, Users } from "lucide-react";

import type { Agent } from "#ui/api-client";
import { systemdScopeRoute, systemdUsersRoute } from "#ui/browser-route";
import {
    SegmentedControl,
    type SegmentedControlOption,
} from "#ui/components/segmented-control";
import { systemdOverviewQueryOptions } from "#ui/systemd-queries";

/** The managers the scope switch offers: the system, the agent's own user, every user. */
type SystemdSection = "system" | "self" | "users";

/**
 * Tells which section the page on screen belongs to. A user page is the agent's own section
 * only for the agent's own account; another user's page belongs to the root user list.
 */
function useSystemdSection(ownUser: string): SystemdSection {
    const leafRouteId = useMatches({
        select: (matches) => matches.at(-1)?.routeId,
    });

    const params = useParams({ strict: false });

    if (leafRouteId?.startsWith("/_app/agents/$deviceName/systemd/system")) {
        return "system";
    }

    if (params.user === ownUser) {
        return "self";
    }

    return "users";
}

/**
 * Frames every systemd page with the device, the title and a switch between the managers
 * the agent can reach, so moving between the system and a user's units is one tap.
 */
export function SystemdLayout(props: {
    agent: Agent;
    children: React.ReactNode;
}) {
    const { data: overview } = useSuspenseQuery(
        systemdOverviewQueryOptions(props.agent),
    );

    const navigate = useNavigate();
    const section = useSystemdSection(overview.username);

    const options: SegmentedControlOption<SystemdSection>[] = [
        {
            value: "system",
            label: "System",
            icon: Server,
            tooltip: overview.is_root
                ? "Units of the system manager"
                : "Units of the system manager, read-only without root",
        },
        {
            value: "self",
            label: overview.username,
            icon: User,
            tooltip: `Units of ${overview.username}'s user manager`,
        },
    ];

    // Only root reaches other users' managers, so only root gets the list of them.
    if (overview.is_root) {
        options.push({
            value: "users",
            label: "Users",
            icon: Users,
            tooltip: "Every user's manager and linger",
        });
    }

    /** Opens the chosen manager's page; the router keeps the device the page was opened for. */
    const openSection = (next: SystemdSection) => {
        if (next === "users") {
            void navigate(systemdUsersRoute(props.agent));

            return;
        }

        void navigate(
            systemdScopeRoute(
                props.agent,
                next === "system"
                    ? { type: "system" }
                    : { type: "user", name: overview.username },
            ),
        );
    };

    return (
        <main className="h-full overflow-y-auto p-3 @xl:p-5 @4xl:p-7">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
                <header className="flex flex-col gap-3 @2xl:flex-row @2xl:items-end @2xl:justify-between">
                    <div className="min-w-0">
                        <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {props.agent.name}
                        </p>
                        <h1 className="mt-1 text-2xl font-semibold text-slate-100">
                            Systemd
                        </h1>
                    </div>
                    <SegmentedControl
                        label="Systemd manager"
                        options={options}
                        value={section}
                        onChange={openSection}
                        className="@2xl:w-auto @2xl:min-w-80"
                    />
                </header>
                {props.children}
            </div>
        </main>
    );
}
