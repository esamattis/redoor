import { getRouteApi, useLocation } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { IconButton } from "#ui/components/icon-button";

const agentRoute = getRouteApi("/agents/$agentId");

/** Opens the shared URL-owned search workflow from any agent-specific toolbar. */
export function ContentSearchButton(props: { className?: string }) {
    const navigate = agentRoute.useNavigate();
    const location = useLocation();
    return (
        <IconButton
            type="button"
            label="Search agent content"
            tooltip="Search agent content (Cmd/Ctrl+K)"
            onClick={() =>
                void navigate({
                    to: `${location.pathname}${location.searchStr ? `${location.searchStr}&q=` : "?q="}`,
                    replace: true,
                })
            }
            className={props.className}
        >
            <Search className="h-5 w-5" aria-hidden="true" />
        </IconButton>
    );
}
