import * as React from "react";
import { Outlet, getRouteApi } from "@tanstack/react-router";

import { useRememberAgentTabLocation } from "#ui/agent-tab-locations";
import { AgentNavigation } from "#ui/components/agent-navigation";
import { ApplicationNavigation } from "#ui/components/application-navigation";
import { ContextualTopBar } from "#ui/components/contextual-top-bar";
import { GlobalFileImportHandler } from "#ui/components/global-file-import-handler";
import { OverlayChromeLayout } from "#ui/components/overlay-chrome-layout";
import { ApplicationBottomDrawer } from "#ui/components/shell/bottom-drawer";
import { DocumentTitle } from "#ui/components/shell/document-title";
import { RouteLoadingIndicator } from "#ui/components/shell/route-loading-indicator";
import { ThemeManager } from "#ui/components/theme-toggle";
import { UserStatePersistToast } from "#ui/components/user-state-persist-toast";
import { VaultDialog } from "#ui/components/vault-dialog";
import { useRefreshListener } from "#ui/refresh-listener";
import { useAgents } from "#ui/use-agents";
import { useBrowserLocation } from "#ui/use-browser-location";
import { useTerminalSessionSync } from "#ui/use-terminals";
import { useEscapeBlursTextControls } from "#ui/utils/use-escape-blur";

const rootRouteApi = getRouteApi("__root__");

/**
 * Frames every authenticated page with the menus, the top bar and the shared tools drawer.
 * It only exists below the `_app` layout route, so everything that needs a valid session,
 * such as the server event connection, starts and stops with it.
 */
export function AppShell() {
    const { api } = rootRouteApi.useRouteContext();

    const [isTerminalFullWindow, setIsTerminalFullWindow] =
        React.useState(false);

    useRefreshListener(api);
    useTerminalSessionSync();
    useRememberAgentTabLocation();
    useEscapeBlursTextControls();

    return (
        <ShellFileImportHandler>
            <div className="flex h-dvh overflow-hidden bg-canvas">
                <ThemeManager />
                <DocumentTitle />
                <RouteLoadingIndicator />
                <UserStatePersistToast />
                <VaultDialog />
                <ApplicationNavigation />
                <OverlayChromeLayout
                    isBottomChromeFullWindow={isTerminalFullWindow}
                    topChrome={<ContextualTopBar />}
                    bottomChrome={
                        <ApplicationBottomDrawer
                            isTerminalFullWindow={isTerminalFullWindow}
                            onTerminalFullWindowChange={setIsTerminalFullWindow}
                        />
                    }
                >
                    <Outlet />
                </OverlayChromeLayout>
                <AgentNavigation />
            </div>
        </ShellFileImportHandler>
    );
}

/**
 * Accepts dropped and pasted files into the directory on screen, but only while its agent
 * is connected and able to write there. It also provides the Paste button's import.
 */
function ShellFileImportHandler(props: { children: React.ReactNode }) {
    const agents = useAgents();
    const browser = useBrowserLocation();

    const agent =
        browser?.entry === "directory"
            ? agents.find((entry) => entry.id === browser.agentId)
            : undefined;

    const destination =
        browser && agent?.status === "connected" && agent.cwd !== null
            ? { agent, path: browser.path }
            : null;

    return (
        <GlobalFileImportHandler destination={destination}>
            {props.children}
        </GlobalFileImportHandler>
    );
}
