import { useAtom } from "jotai";
import { ArrowUpDown, Files, SquareTerminal } from "lucide-react";

import { TabbedBottomDrawer } from "#ui/components/collapsible-bottom-panel";
import {
    SelectedFilesBadge,
    SelectedFilesPane,
} from "#ui/components/shell/selected-files-pane";
import {
    TransferProgressPane,
    TransferTabBadge,
} from "#ui/components/shell/transfers-pane";
import { TerminalPanel } from "#ui/components/terminal-panel";
import {
    bottomDrawerActiveTabAtom,
    bottomDrawerCollapsedAtom,
    bottomDrawerHeightAtom,
} from "#ui/bottom-drawer-state";
import { useAgents } from "#ui/use-agents";
import { useActiveTerminalTarget } from "#ui/use-terminals";

/**
 * Hosts the shared tools in one drawer. The badges and panes read their own data, so the
 * drawer only rerenders for its own state and never because transfers or selections move.
 */
export function ApplicationBottomDrawer(props: {
    isTerminalFullWindow: boolean;
    onTerminalFullWindowChange: (isFullWindow: boolean) => void;
}) {
    const [activeTab, setActiveTab] = useAtom(bottomDrawerActiveTabAtom);
    const [isCollapsed, setIsCollapsed] = useAtom(bottomDrawerCollapsedAtom);
    const [height, setHeight] = useAtom(bottomDrawerHeightAtom);

    return (
        <TabbedBottomDrawer
            activeTab={activeTab}
            isCollapsed={isCollapsed}
            isFullWindow={props.isTerminalFullWindow}
            expandedHeight={height}
            onActiveTabChange={setActiveTab}
            onCollapsedChange={setIsCollapsed}
            onExpandedHeightChange={setHeight}
            tabs={[
                {
                    id: "selected",
                    label: "Selected",
                    icon: <Files className="h-4 w-4" />,
                    badge: <SelectedFilesBadge />,
                    content: <SelectedFilesPane />,
                },
                {
                    id: "transfers",
                    label: "Transfers",
                    icon: <ArrowUpDown className="h-4 w-4" />,
                    badge: <TransferTabBadge />,
                    content: <TransferProgressPane />,
                },
                {
                    id: "terminal",
                    label: "Terminal",
                    icon: <SquareTerminal className="h-4 w-4" />,
                    content: (
                        <ShellTerminalPane
                            isFullWindow={props.isTerminalFullWindow}
                            onFullWindowChange={
                                props.onTerminalFullWindowChange
                            }
                        />
                    ),
                },
            ]}
        />
    );
}

/** Gives the terminal panel the agents to pick from and the target a new shell would open in. */
function ShellTerminalPane(props: {
    isFullWindow: boolean;
    onFullWindowChange: (isFullWindow: boolean) => void;
}) {
    const agents = useAgents();
    const activeTarget = useActiveTerminalTarget();

    return (
        <TerminalPanel
            agents={agents}
            activeTarget={activeTarget}
            isFullWindow={props.isFullWindow}
            onFullWindowChange={props.onFullWindowChange}
        />
    );
}
