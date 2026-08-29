import { getRouteApi, useLocation } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { IconButton } from "#ui/components/icon-button";

const agentRoute = getRouteApi("/agents/$agentId");

/** Opens the shared URL-owned search workflow from any agent-specific toolbar. */
export function SearchButton(props: { className?: string }) {
    const navigate = agentRoute.useNavigate();
    const location = useLocation();
    return (
        <IconButton
            type="button"
            label="Search agent"
            tooltip="Search agent (Cmd/Ctrl+K)"
            onClick={() => {
                const params = new URLSearchParams(location.searchStr);
                params.set("q", "");
                params.delete("mode");
                void navigate({
                    to: `${location.pathname}?${params.toString()}${location.hash}`,
                    replace: true,
                });
            }}
            className={props.className}
        >
            <Search className="h-5 w-5" aria-hidden="true" />
        </IconButton>
    );
}
