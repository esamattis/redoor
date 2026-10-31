import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";

import { useTargetAgent } from "#ui/use-active-agent";
import { useBrowserLocation } from "#ui/use-browser-location";
import type { TerminalSessions } from "#ui/terminal/terminal-sessions";
import type {
    ActiveTerminalTarget,
    TerminalSessionsSnapshot,
} from "#ui/terminal/terminal-sessions";
import { getParentPath } from "#ui/utils/path";

const rootRouteApi = getRouteApi("__root__");

/** Returns the application's terminal owner, which outlives every route and component. */
export function useTerminals(): TerminalSessions {
    return rootRouteApi.useRouteContext().terminals;
}

/**
 * Makes the terminal tabs follow the server's session list while the authenticated shell is
 * mounted. The effect only subscribes to the query cache, which the `_app` loader primed;
 * the login page never asks for terminal sessions.
 */
export function useTerminalSessionSync(): void {
    const terminals = useTerminals();

    React.useEffect(() => {
        terminals.start();

        return () => terminals.stop();
    }, [terminals]);
}

/** Subscribes to the tabs and display facts of the terminal panel. */
export function useTerminalsSnapshot(): TerminalSessionsSnapshot {
    const terminals = useTerminals();

    return React.useSyncExternalStore(
        terminals.subscribe,
        terminals.getSnapshot,
    );
}

/**
 * Resolves where a new terminal opens: the agent the user is heading to, in the browsed
 * directory when there is one and in the agent's home otherwise. Missing paths still expose a
 * directory so the terminal opens near the attempted location. Null when no connected agent
 * is targeted, in which case the shortcut asks the user to pick a device.
 */
export function useActiveTerminalTarget(): ActiveTerminalTarget | null {
    const activeAgent = useTargetAgent();
    const browser = useBrowserLocation();

    // While navigating to another agent the browser location still belongs to the previous
    // one, whose directory means nothing on the new device.
    const browsedDirectory =
        browser === null || browser.agentId !== activeAgent?.id
            ? null
            : browser.entry === "file"
              ? getParentPath(browser.path)
              : browser.path;

    return activeAgent?.status === "connected" && activeAgent.cwd !== null
        ? { agent: activeAgent, cwd: browsedDirectory ?? activeAgent.cwd }
        : null;
}
