import { Search } from "lucide-react";

import { IconButton } from "#ui/components/icon-button";
import type { IconButtonSize } from "#ui/components/icon-button";
import { useAgentSearchNavigation } from "#ui/search-navigation";

/** Opens the shared URL-owned search workflow from any agent-specific toolbar. */
export function SearchButton(props: {
    size: IconButtonSize;
    className?: string;
}) {
    const { openSearch } = useAgentSearchNavigation();

    return (
        <IconButton
            type="button"
            label="Search device"
            tooltip="Search device (s, Cmd/Ctrl+K)"
            variant="ghost"
            size={props.size}
            className={props.className}
            onClick={() => void openSearch()}
        >
            <Search className="h-5 w-5" aria-hidden="true" />
        </IconButton>
    );
}
