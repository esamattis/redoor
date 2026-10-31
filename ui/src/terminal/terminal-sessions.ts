import {
    MutationObserver,
    QueryObserver,
    type QueryClient,
} from "@tanstack/react-query";
import type { createStore } from "jotai";

import type { Agent, ApiClient } from "#ui/api-client";
import type { CloseTerminalSessionResponse } from "#bindings/CloseTerminalSessionResponse";
import type { CreateTerminalSessionRequest } from "#bindings/CreateTerminalSessionRequest";
import type { CreateTerminalSessionResponse } from "#bindings/CreateTerminalSessionResponse";
import type { TerminalSessionInfo } from "#bindings/TerminalSessionInfo";
import type { TerminalSessionList } from "#bindings/TerminalSessionList";
import type { TerminalSize } from "#bindings/TerminalSize";
import {
    activateBottomDrawerTabAtom,
    bottomDrawerActiveTabAtom,
    bottomDrawerCollapsedAtom,
} from "#ui/bottom-drawer-state";
import {
    findCachedAgent,
    queryKeys,
    terminalSessionsQueryOptions,
} from "#ui/queries";
import { OneShotTerminalCommand } from "#ui/terminal/one-shot-command";
import {
    TerminalSession,
    type BrowserListingRefreshTarget,
    type TerminalTabSnapshot,
} from "#ui/terminal/terminal-session";
import { createWTerm, type CreateEmulator } from "#ui/terminal/wterm";
import {
    defaultUserState,
    updateUserState,
    type UserState,
} from "#ui/user-state";
import { ExternalStore } from "#ui/utils/external-store";
import { moveKeyedItems, type ItemMove } from "#ui/utils/reorder";

/** Identifies the routed agent and directory used by the direct new-terminal action. */
export type ActiveTerminalTarget = { agent: Agent; cwd: string };

/** Adds one-shot shell input only for feature-created terminals. */
export type TerminalCreationTarget = ActiveTerminalTarget & {
    startupCommand?: string;
    refreshTarget?: BrowserListingRefreshTarget;
};

/** What the terminal panel renders: the tabs and the few facts about how they are shown. */
export type TerminalSessionsSnapshot = {
    readonly tabs: readonly TerminalTabSnapshot[];
    readonly activeTabId: number | null;
    /** Whether the device picker is open, because the shortcut opens it when no target exists. */
    readonly isPickerOpen: boolean;
    /** Counts focus requests so the view can retry focusing once its DOM is interactive. */
    readonly focusEpoch: number;
    /** Whether the drawer is expanded on the terminal pane. */
    readonly isPanelVisible: boolean;
};

/** Delays the refresh so a command that was just typed has time to change the directory. */
const LISTING_REFRESH_DELAY_MS = 1000;

/** What the owner is built from; `createEmulator` is replaced only in tests. */
export type TerminalSessionsOptions = {
    queryClient: QueryClient;
    store: ReturnType<typeof createStore>;
    api: ApiClient;
    createEmulator?: CreateEmulator;
};

/** One create request, with the device that runs it. */
type CreateVariables = {
    agent: Agent;
    request: CreateTerminalSessionRequest;
};

/**
 * Orders restored sessions as the user left them: saved tab order first, then sessions the
 * order does not know (created by another window or before the order was saved) by age.
 */
export function orderRestoredSessions(
    sessions: readonly TerminalSessionInfo[],
    savedOrder: readonly string[],
): TerminalSessionInfo[] {
    const position = (id: string) => {
        const index = savedOrder.indexOf(id);

        return index === -1 ? Number.POSITIVE_INFINITY : index;
    };

    return [...sessions].sort(
        (left, right) =>
            position(left.id) - position(right.id) ||
            left.created_at - right.created_at,
    );
}

/** Reuses a live shell only when it was opened in the same directory as the current browse path. */
function findOpenTerminalForTarget(
    sessions: readonly TerminalSession[],
    activeTabId: number | null,
    target: ActiveTerminalTarget,
): TerminalSession | undefined {
    const matching = sessions.filter(
        (session) =>
            session.tab.agent.id === target.agent.id &&
            session.tab.cwd === target.cwd &&
            session.tab.state.type !== "disconnected",
    );

    return (
        matching.find((session) => session.tab.id === activeTabId) ??
        matching.at(-1)
    );
}

/**
 * Owns every terminal tab of the application. Tabs outlive routes, the drawer and any
 * component, so the owner is created once with the application and everything else asks it
 * to do things: features call `create` to run a command in a new shell, the shortcut and the
 * toolbar button call `openOrFocus`, and the panel only subscribes to the snapshot. The
 * drawer's visibility is read from the shared store, which is also how a tab learns whether
 * it is being shown.
 *
 * The shells themselves are server sessions, so the tabs follow the server's session list:
 * a reloaded page restores one tab per session, and tabs opened or closed in another window
 * appear and disappear here too. Tab order and the active tab are kept in the user state.
 */
export class TerminalSessions extends ExternalStore<TerminalSessionsSnapshot> {
    private sessions: TerminalSession[] = [];
    private activeTabId: number | null = null;
    private isPickerOpen = false;
    private focusEpoch = 0;
    private isPanelVisible = false;
    private pendingFocus = false;
    private theme: "dark" | "light" = "dark";
    private nextTabId = 1;
    private readonly nextNumberByAgent = new Map<string, number>();
    private readonly refreshTimers = new Set<number>();
    private readonly unsubscribeDrawer: () => void;
    /**
     * This window's creates still waiting for their response. While any is pending, sessions
     * from the list are not added: the list can already hold a new session whose tab here
     * does not know its id yet, and adding it would make a duplicate tab.
     */
    private pendingCreates = 0;
    /** Sessions this window is deleting, so a list fetched meanwhile does not bring them back. */
    private readonly pendingDeletes = new Set<string>();
    private stopObserving: (() => void) | null = null;
    private readonly sessionList: QueryObserver<
        TerminalSessionList,
        Error,
        TerminalSessionList,
        TerminalSessionList,
        ReturnType<typeof queryKeys.terminalSessions>
    >;
    private readonly creates: MutationObserver<
        CreateTerminalSessionResponse,
        Error,
        CreateVariables
    >;
    private readonly deletes: MutationObserver<
        CloseTerminalSessionResponse,
        Error,
        string
    >;

    private readonly queryClient: QueryClient;
    private readonly store: ReturnType<typeof createStore>;
    private readonly api: ApiClient;
    private readonly createEmulator: CreateEmulator;

    /**
     * Needs the query client for the session list and listing refreshes, the store for the
     * drawer atoms and the user state, and the API for the sessions themselves.
     */
    constructor(options: TerminalSessionsOptions) {
        super({
            tabs: [],
            activeTabId: null,
            isPickerOpen: false,
            focusEpoch: 0,
            isPanelVisible: false,
        });

        const { queryClient, store, api } = options;
        this.queryClient = queryClient;
        this.store = store;
        this.api = api;
        this.createEmulator = options.createEmulator ?? createWTerm;

        const unsubscribeCollapsed = store.sub(bottomDrawerCollapsedAtom, () =>
            this.syncVisibility(),
        );

        const unsubscribeTab = store.sub(bottomDrawerActiveTabAtom, () =>
            this.syncVisibility(),
        );

        this.unsubscribeDrawer = () => {
            unsubscribeCollapsed();
            unsubscribeTab();
        };

        this.isPanelVisible = this.readPanelVisible();
        this.sessionList = new QueryObserver(
            queryClient,
            terminalSessionsQueryOptions(api),
        );
        this.creates = new MutationObserver(queryClient, {
            mutationFn: (variables: CreateVariables) =>
                variables.agent.createTerminalSession(variables.request),
        });
        this.deletes = new MutationObserver(queryClient, {
            mutationFn: (sessionId: string) =>
                api.deleteTerminalSession(sessionId),
        });
    }

    /**
     * Follows the server's session list while the authenticated shell is mounted. The first
     * result restores the tabs; later ones add and drop tabs changed by other windows.
     */
    start(): void {
        if (this.stopObserving !== null) {
            return;
        }

        this.stopObserving = this.sessionList.subscribe(() => this.reconcile());
        this.reconcile();
    }

    /** Stops following the session list, leaving the tabs as they are. */
    stop(): void {
        this.stopObserving?.();
        this.stopObserving = null;
    }

    /** Opens a fresh shell for a target, such as one that runs an extraction command. */
    create(target: TerminalCreationTarget): void {
        const agentTerminalNumber =
            this.nextNumberByAgent.get(target.agent.id) ?? 1;

        this.nextNumberByAgent.set(target.agent.id, agentTerminalNumber + 1);
        const refreshTarget = target.refreshTarget;

        const startupCommand =
            target.startupCommand !== undefined && refreshTarget !== undefined
                ? new OneShotTerminalCommand(target.startupCommand, () =>
                      this.scheduleListingRefresh(refreshTarget),
                  )
                : null;

        const session = this.newSession({
            sessionId: null,
            agent: target.agent,
            agentTerminalNumber,
            title: `${target.agent.name} ${agentTerminalNumber}`,
            cwd: target.cwd,
            startupCommand,
        });

        this.sessions = [...this.sessions, session];
        this.activeTabId = session.tab.id;
        this.revealTerminal();
        this.requestFocus();
    }

    /** Builds one tab, new or restored, wired to this owner. */
    private newSession(tab: {
        sessionId: string | null;
        agent: Agent;
        agentTerminalNumber: number;
        title: string;
        cwd: string;
        startupCommand: OneShotTerminalCommand | null;
    }): TerminalSession {
        const id = this.nextTabId;
        this.nextTabId += 1;

        return new TerminalSession({
            ...tab,
            id,
            theme: this.theme,
            createEmulator: this.createEmulator,
            server: {
                create: (session, size) =>
                    this.createServerSession(session, size),
                remove: (sessionId) => this.deleteServerSession(sessionId),
                exists: (sessionId) => this.sessionExists(sessionId),
                attachUrl: (sessionId, size) =>
                    this.api.getTerminalSessionWebSocketUrl(sessionId, size),
            },
            onChange: () => this.emit(),
        });
    }

    /**
     * Creates the server session of a new tab. The list cache is updated before the tab
     * learns its id, in an order that keeps any list fetch from adding a duplicate tab or
     * removing the new one: a fetch that started before the create is cancelled, the new
     * session is merged into the cached list, and only then a refetch starts, which already
     * contains it because the server registered it before replying.
     */
    private async createServerSession(
        session: TerminalSession,
        size: TerminalSize,
    ): Promise<void> {
        this.pendingCreates += 1;

        try {
            const response = await this.creates.mutate({
                agent: session.tab.agent,
                request: {
                    cwd: session.tab.cwd,
                    title: session.tab.title,
                    number: session.tab.agentTerminalNumber,
                    size,
                },
            });

            const created = response.session;
            const listKey = queryKeys.terminalSessions();
            await this.queryClient.cancelQueries({ queryKey: listKey });
            this.queryClient.setQueryData<TerminalSessionList>(
                listKey,
                (list) => ({
                    sessions: [
                        ...(list?.sessions ?? []).filter(
                            (entry) => entry.id !== created.id,
                        ),
                        created,
                    ],
                }),
            );

            if (this.sessions.includes(session)) {
                session.setSessionId(created.id);
                this.persistTabs();
            } else {
                // The tab was closed while its shell was being created.
                this.deleteServerSession(created.id);
            }

            void this.queryClient.invalidateQueries({
                queryKey: queryKeys.terminalSessions(),
                exact: true,
            });
        } finally {
            this.pendingCreates -= 1;
            // Sessions of other windows skipped while this create was pending are added now.
            this.reconcile();
        }
    }

    /** Deletes a session in the background, keeping it out of the tabs meanwhile. */
    private deleteServerSession(sessionId: string): void {
        this.pendingDeletes.add(sessionId);
        this.queryClient.setQueryData<TerminalSessionList>(
            queryKeys.terminalSessions(),
            (list) =>
                list && {
                    sessions: list.sessions.filter(
                        (entry) => entry.id !== sessionId,
                    ),
                },
        );
        // A failed delete (the session was already gone) needs no report: the tab is closed.
        this.deletes
            .mutate(sessionId)
            .catch(() => undefined)
            .finally(() => {
                this.pendingDeletes.delete(sessionId);
                void this.queryClient.invalidateQueries({
                    queryKey: queryKeys.terminalSessions(),
                    exact: true,
                });
            });
    }

    /**
     * Asks the server whether a session still exists before a reconnect. `null` means the
     * server could not be asked, so the reconnect is tried anyway.
     */
    private async sessionExists(sessionId: string): Promise<boolean | null> {
        try {
            const list = await this.queryClient.fetchQuery({
                ...terminalSessionsQueryOptions(this.api),
                staleTime: 0,
            });

            return list.sessions.some((entry) => entry.id === sessionId);
        } catch {
            return null;
        }
    }

    /**
     * Makes the tabs follow the server's list: drops tabs whose session is gone, such as one
     * closed in another window, and adds sessions this window has no tab for. Restored tabs
     * follow the saved order, and whenever no tab is active the saved one is picked again.
     */
    private reconcile(): void {
        const list = this.sessionList.getCurrentResult().data;

        if (list === undefined) {
            return;
        }

        const listedIds = new Set(list.sessions.map((entry) => entry.id));

        const gone = this.sessions.filter(
            (session) =>
                session.sessionId !== null && !listedIds.has(session.sessionId),
        );

        for (const session of gone) {
            this.removeTab(session);
        }

        const added =
            this.pendingCreates > 0 ? 0 : this.restoreMissing(list.sessions);

        const activated = this.restoreActiveTab();

        if (gone.length > 0 || added > 0 || activated) {
            this.syncVisibility();
        }
    }

    /**
     * Picks an active tab when there is none, so a drawer restored open after a reload shows
     * a shell instead of an empty pane. This runs on every list result, not just the first,
     * because tabs of devices that are not known yet are restored later. The saved tab is
     * preferred; when its shell was destroyed meanwhile the first tab stands in. Returns
     * whether the active tab changed.
     */
    private restoreActiveTab(): boolean {
        if (this.activeTabId !== null || this.sessions.length === 0) {
            return false;
        }

        const saved = this.savedTabs().active;

        const active =
            this.sessions.find(
                (session) =>
                    session.sessionId !== null && session.sessionId === saved,
            ) ?? this.sessions[0];

        this.activeTabId = active?.tab.id ?? null;

        return this.activeTabId !== null;
    }

    /** Adds a detached tab for every listed session without one; returns how many. */
    private restoreMissing(listed: readonly TerminalSessionInfo[]): number {
        const known = new Set(
            this.sessions.flatMap((session) =>
                session.sessionId === null ? [] : [session.sessionId],
            ),
        );

        const missing = orderRestoredSessions(
            listed.filter(
                (entry) =>
                    !known.has(entry.id) && !this.pendingDeletes.has(entry.id),
            ),
            this.savedTabs().order,
        );

        const restored = missing.flatMap((entry) => {
            const agent = findCachedAgent(
                this.queryClient,
                this.api,
                entry.agent_id,
            );

            // A session of a device missing from the inventory waits until it is known.
            if (agent === undefined) {
                return [];
            }

            this.nextNumberByAgent.set(
                agent.id,
                Math.max(
                    this.nextNumberByAgent.get(agent.id) ?? 1,
                    entry.number + 1,
                ),
            );

            return [
                this.newSession({
                    sessionId: entry.id,
                    agent,
                    agentTerminalNumber: entry.number,
                    title: entry.title,
                    cwd: entry.cwd,
                    startupCommand: null,
                }),
            ];
        });

        this.sessions = [...this.sessions, ...restored];

        return restored.length;
    }

    /** The saved tab order and active tab. */
    private savedTabs(): UserState["terminalTabs"] {
        return (
            this.queryClient.getQueryData<UserState>(queryKeys.userState()) ??
            defaultUserState
        ).terminalTabs;
    }

    /** Saves tab order and the active tab, so a reload restores them. */
    private persistTabs(): void {
        const order = this.sessions.flatMap((session) =>
            session.sessionId === null ? [] : [session.sessionId],
        );

        const active =
            this.sessions.find((session) => session.tab.id === this.activeTabId)
                ?.sessionId ?? null;

        updateUserState(
            { api: this.api, queryClient: this.queryClient, store: this.store },
            (current) =>
                current.terminalTabs.active === active &&
                current.terminalTabs.order.length === order.length &&
                current.terminalTabs.order.every(
                    (id, index) => id === order[index],
                )
                    ? current
                    : { ...current, terminalTabs: { order, active } },
        );
    }

    /**
     * Shares tab reuse and focus between the shortcut and the toolbar button: reuse the live
     * shell for the same directory, create one if there is none, or open the device picker
     * when there is no routed target.
     */
    openOrFocus(target: ActiveTerminalTarget | null): void {
        if (target === null) {
            if (!this.isPickerOpen) {
                this.revealTerminal();
                this.setPickerOpen(true);
            }

            return;
        }

        const existing = findOpenTerminalForTarget(
            this.sessions,
            this.activeTabId,
            target,
        );

        if (existing) {
            this.activeTabId = existing.tab.id;
            this.revealTerminal();
            this.requestFocus();
            this.persistTabs();
        } else {
            this.create(target);
        }
    }

    /** Opens or closes the device picker, which the panel's menu reflects. */
    setPickerOpen(isOpen: boolean): void {
        this.isPickerOpen = isOpen;
        this.emit();
    }

    /** Makes a tab the visible one. */
    select(tabId: number): void {
        if (this.activeTabId === tabId) {
            return;
        }

        this.activeTabId = tabId;
        this.syncVisibility();
        this.persistTabs();
    }

    /** Closes a tab and stops its shell on the server. */
    close(tabId: number): void {
        const session = this.sessions.find((entry) => entry.tab.id === tabId);

        if (session === undefined) {
            return;
        }

        const sessionId = session.sessionId;
        this.removeTab(session);

        if (sessionId !== null) {
            this.deleteServerSession(sessionId);
        }

        this.syncVisibility();
        this.persistTabs();
    }

    /**
     * Disposes one tab and picks its nearest surviving neighbour when it was active. The
     * server session is not touched, so this also serves tabs whose session is already gone.
     */
    private removeTab(session: TerminalSession): void {
        const index = this.sessions.indexOf(session);

        if (index === -1) {
            return;
        }

        session.dispose();
        this.sessions = this.sessions.filter((entry) => entry !== session);

        if (this.activeTabId === session.tab.id) {
            const replacement =
                this.sessions[index] ?? this.sessions[index - 1] ?? null;

            this.activeTabId = replacement?.tab.id ?? null;
        }
    }

    /** Starts a new shell in a disconnected tab while preserving its identity and directory. */
    restart(tabId: number): void {
        const session = this.sessions.find((entry) => entry.tab.id === tabId);

        if (session === undefined) {
            return;
        }

        this.activeTabId = tabId;
        session.restart();
        this.revealTerminal();
        this.requestFocus();
    }

    /** Reorders tab presentation without replacing any live shell. */
    move(move: ItemMove): void {
        this.sessions = moveKeyedItems(
            this.sessions,
            (session) => String(session.tab.id),
            move,
        );

        this.emit();
        this.persistTabs();
    }

    /** Gives a session to its view, which attaches the session's host element. */
    sessionFor(tabId: number): TerminalSession | undefined {
        return this.sessions.find((session) => session.tab.id === tabId);
    }

    /** Follows the app theme for every shell and for those created later. */
    setTheme(theme: "dark" | "light"): void {
        this.theme = theme;

        for (const session of this.sessions) {
            session.setTheme(theme);
        }
    }

    /** Drops a pending focus request, because the user already went back to the editor. */
    cancelPendingFocus(): void {
        this.pendingFocus = false;
    }

    /**
     * Moves focus into the active shell once it can take it: displayed and connected. The
     * view calls this after each render that could have made that true, because a tab that
     * was just revealed is still inert until React has committed it. A late connection after
     * the user returned to the editor must not keep the shell, so the editor takes focus back.
     */
    flushFocus(tabId: number): void {
        const session = this.sessions.find((entry) => entry.tab.id === tabId);

        if (
            this.focusEpoch === 0 ||
            session === undefined ||
            this.activeTabId !== tabId ||
            !this.isPanelVisible
        ) {
            return;
        }

        // Asking for a shell that another window has is asking to take it back.
        if (this.pendingFocus && session.tab.state.type === "taken_over") {
            session.takeOver();

            return;
        }

        if (session.tab.state.type !== "connected") {
            return;
        }

        if (this.pendingFocus) {
            session.focus();
            this.pendingFocus = false;

            return;
        }

        const editor = document.querySelector<HTMLElement>(
            '[role="textbox"][data-file-editor]',
        );

        if (
            editor &&
            document.activeElement?.closest("[data-terminal-input]")
        ) {
            editor.focus();
        }
    }

    /**
     * Releases every tab, timer and subscription, for tests and teardown. The server
     * sessions keep running, as they do when the page unloads.
     */
    dispose(): void {
        this.stop();
        this.unsubscribeDrawer();

        for (const timer of this.refreshTimers) {
            window.clearTimeout(timer);
        }

        this.refreshTimers.clear();

        for (const session of this.sessions) {
            session.dispose();
        }

        this.sessions = [];
        this.activeTabId = null;
        this.emit();
    }

    /** Expands the drawer onto the terminal pane; the drawer's atoms are the only state. */
    private revealTerminal(): void {
        this.store.set(activateBottomDrawerTabAtom, "terminal");
        this.syncVisibility();
    }

    /** Remembers that the user asked for the shell, to focus it as soon as it is ready. */
    private requestFocus(): void {
        this.pendingFocus = true;
        this.focusEpoch += 1;
        this.emit();
    }

    /** Reads whether the drawer shows the terminal pane at all. */
    private readPanelVisible(): boolean {
        return (
            !this.store.get(bottomDrawerCollapsedAtom) &&
            this.store.get(bottomDrawerActiveTabAtom) === "terminal"
        );
    }

    /** Tells each session whether it is on screen, which gates starting and resizing. */
    private syncVisibility(): void {
        this.isPanelVisible = this.readPanelVisible();

        for (const session of this.sessions) {
            session.setShown(
                this.isPanelVisible && session.tab.id === this.activeTabId,
            );
        }

        this.emit();
    }

    /**
     * Invalidates only the listing that originated a command, a moment after it was typed.
     * The timer outlives the tab, because the command keeps running after the tab closes.
     */
    private scheduleListingRefresh(target: BrowserListingRefreshTarget): void {
        const timer = window.setTimeout(() => {
            this.refreshTimers.delete(timer);

            void this.queryClient.invalidateQueries({
                queryKey: queryKeys.browserListing(target.agentId, target.path),
                exact: true,
                refetchType: "active",
            });
        }, LISTING_REFRESH_DELAY_MS);

        this.refreshTimers.add(timer);
    }

    /** Publishes a snapshot that reuses the arrays and tab objects that did not change. */
    private emit(): void {
        const previous = this.getSnapshot();
        const tabs = this.sessions.map((session) => session.tab);

        const tabsUnchanged =
            tabs.length === previous.tabs.length &&
            tabs.every((tab, index) => tab === previous.tabs[index]);

        const next: TerminalSessionsSnapshot = {
            tabs: tabsUnchanged ? previous.tabs : tabs,
            activeTabId: this.activeTabId,
            isPickerOpen: this.isPickerOpen,
            focusEpoch: this.focusEpoch,
            isPanelVisible: this.isPanelVisible,
        };

        if (
            next.tabs === previous.tabs &&
            next.activeTabId === previous.activeTabId &&
            next.isPickerOpen === previous.isPickerOpen &&
            next.focusEpoch === previous.focusEpoch &&
            next.isPanelVisible === previous.isPanelVisible
        ) {
            return;
        }

        this.publish(next);
    }
}
