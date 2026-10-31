// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { CreateTerminalSessionResponse } from "#bindings/CreateTerminalSessionResponse";
import type { TerminalSessionInfo } from "#bindings/TerminalSessionInfo";
import type { TerminalSessionList } from "#bindings/TerminalSessionList";
import { ApiClient } from "#ui/api-client";
import {
    bottomDrawerActiveTabAtom,
    bottomDrawerCollapsedAtom,
} from "#ui/bottom-drawer-state";
import { queryKeys } from "#ui/queries";
import { TerminalSessions } from "#ui/terminal/terminal-sessions";
import type { CreateEmulator } from "#ui/terminal/wterm";
import { defaultUserState, type UserState } from "#ui/user-state";

/** Stands in for wterm, which is wasm and draws into a real layout; tabs only need a size. */
const createIdleEmulator: CreateEmulator = async () => ({
    terminal: {
        rows: 24,
        cols: 80,
        bridge: null,
        write: () => {},
        destroy: () => {},
        focus: () => {},
        getSelectionText: () => "",
    },
    core: { dispose: () => {} },
});

/** A socket that never connects, so attaching a tab stays local to the test. */
class IdleWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = IdleWebSocket.CONNECTING;
    binaryType = "blob";

    constructor(readonly url: string) {
        super();
    }

    send(): void {}

    close(): void {
        this.readyState = IdleWebSocket.CLOSED;
    }
}

/** A promise the test resolves by hand, to order responses against each other. */
function deferred<T>() {
    let resolve: (value: T) => void = () => {};

    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });

    return { promise, resolve };
}

/** A listed session of a device; its title follows the device and number. */
function sessionInfo(session: {
    id: string;
    agentId: string;
    number: number;
    createdAt: number;
}): TerminalSessionInfo {
    return {
        id: session.id,
        agent_id: session.agentId,
        cwd: `/home/${session.agentId}`,
        title: `${session.agentId} ${session.number}`,
        number: session.number,
        created_at: session.createdAt,
        status: { type: "running" },
        attached: false,
    };
}

/** Describes a connected agent; only its id, name and home matter to terminal tabs. */
function agentInfo(id: string, name: string): AgentInfoResponse {
    return {
        id,
        name,
        cwd: `/home/${id}`,
        managed: false,
        configuration_editable: false,
        ssh_target: null,
        status: "connected",
        connected_at: 1,
        connection_id: `socket-${id}`,
        last_seen_at: 1,
        connection_issue: null,
        provisioning_status: [],
        binary: null,
        supports_native_open: false,
        supports_move_to_trash: false,
        supports_trash: false,
        supports_upload_preconditions: false,
        uid: null,
        is_root: false,
        duplicate_id: null,
    };
}

/** Builds an owner against a real store, so drawer effects are observed through the atoms. */
function createOwner() {
    const store = createStore();
    const queryClient = new QueryClient();
    const api = new ApiClient("http://localhost:1");
    // Settings writes are not under test; they must not reach the network.
    vi.spyOn(api, "updateUserState").mockImplementation(async (request) => ({
        state: request.state,
    }));

    const terminals = new TerminalSessions({
        queryClient,
        store,
        api,
        createEmulator: createIdleEmulator,
    });

    const alpha = api.agentFor(agentInfo("alpha", "Alpha"));
    const beta = api.agentFor(agentInfo("beta", "Beta"));

    onTestFinished(() => {
        terminals.dispose();
        queryClient.clear();
        // The drawer atoms live in session storage, which jsdom keeps between tests.
        window.sessionStorage.clear();
    });

    return { terminals, store, alpha, beta, api, queryClient };
}

/** Lets the owner follow a session list, starting from `sessions`. */
function followList(
    owner: ReturnType<typeof createOwner>,
    sessions: TerminalSessionInfo[],
) {
    owner.queryClient.setQueryData<TerminalSessionList>(
        queryKeys.terminalSessions(),
        { sessions },
    );
    owner.terminals.start();
}

/** Shows the active tab in a container, which starts it, with sockets that stay idle. */
function showActiveTab(owner: ReturnType<typeof createOwner>) {
    vi.stubGlobal("WebSocket", IdleWebSocket);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
        queueMicrotask(callback);

        return 0;
    });
    onTestFinished(() => {
        vi.unstubAllGlobals();
    });
    const tabId = owner.terminals.getSnapshot().activeTabId ?? -1;

    owner.terminals.sessionFor(tabId)?.attach(document.createElement("div"));
}

describe("TerminalSessions", () => {
    test("creating a terminal activates it and reveals the drawer", () => {
        const { terminals, store, alpha } = createOwner();

        terminals.create({ agent: alpha, cwd: "/home/alpha" });

        const snapshot = terminals.getSnapshot();
        // The new tab is the one the user sees, titled by device and a per-device counter.
        expect(snapshot.tabs.map((tab) => tab.title)).toEqual(["Alpha 1"]);
        expect(snapshot.activeTabId).toBe(snapshot.tabs[0]?.id);
        // Creation is an explicit user action, so the drawer must open on the terminal pane.
        expect(store.get(bottomDrawerCollapsedAtom)).toBe(false);
        expect(store.get(bottomDrawerActiveTabAtom)).toBe("terminal");
        // The panel is told it is on screen, which is what lets the shell start.
        expect(snapshot.isPanelVisible).toBe(true);
        // A focus request is recorded so the shell is focused once it connects.
        expect(snapshot.focusEpoch).toBe(1);
    });

    test("numbers terminals per device", () => {
        const { terminals, alpha, beta } = createOwner();

        terminals.create({ agent: alpha, cwd: "/a" });
        terminals.create({ agent: beta, cwd: "/b" });
        terminals.create({ agent: alpha, cwd: "/c" });

        // Each device counts its own terminals, so tab names stay short and predictable.
        expect(terminals.getSnapshot().tabs.map((tab) => tab.title)).toEqual([
            "Alpha 1",
            "Beta 1",
            "Alpha 2",
        ]);
    });

    test("openOrFocus reuses the live terminal of the same directory", () => {
        const { terminals, alpha } = createOwner();

        terminals.openOrFocus({ agent: alpha, cwd: "/work" });
        terminals.openOrFocus({ agent: alpha, cwd: "/work" });
        // Pressing the shortcut again must focus the existing shell, not pile up duplicates.
        expect(terminals.getSnapshot().tabs).toHaveLength(1);

        terminals.openOrFocus({ agent: alpha, cwd: "/elsewhere" });
        // A different directory is a different shell, because cwd is fixed at creation.
        expect(terminals.getSnapshot().tabs).toHaveLength(2);
    });

    test("openOrFocus selects an existing terminal and reveals a collapsed drawer", () => {
        const { terminals, store, alpha } = createOwner();

        terminals.openOrFocus({ agent: alpha, cwd: "/one" });
        terminals.openOrFocus({ agent: alpha, cwd: "/two" });
        const first = terminals.getSnapshot().tabs[0];
        store.set(bottomDrawerCollapsedAtom, true);

        terminals.openOrFocus({ agent: alpha, cwd: "/one" });

        // Reusing a tab still has to bring it back on screen and make it the active one.
        expect(terminals.getSnapshot().activeTabId).toBe(first?.id);
        expect(store.get(bottomDrawerCollapsedAtom)).toBe(false);
    });

    test("without a target openOrFocus opens the device picker once", () => {
        const { terminals, store } = createOwner();

        terminals.openOrFocus(null);

        // With nowhere to open a shell the user chooses a device, in a visible drawer.
        expect(terminals.getSnapshot().isPickerOpen).toBe(true);
        expect(store.get(bottomDrawerCollapsedAtom)).toBe(false);

        terminals.setPickerOpen(false);
        expect(terminals.getSnapshot().isPickerOpen).toBe(false);
    });

    test("closing the active tab selects its nearest neighbour", () => {
        const { terminals, alpha } = createOwner();

        terminals.create({ agent: alpha, cwd: "/1" });
        terminals.create({ agent: alpha, cwd: "/2" });
        terminals.create({ agent: alpha, cwd: "/3" });
        const [first, second, third] = terminals.getSnapshot().tabs;

        terminals.select(second?.id ?? -1);
        terminals.close(second?.id ?? -1);
        // The tab that slid into the closed slot takes over, like closing a browser tab.
        expect(terminals.getSnapshot().activeTabId).toBe(third?.id);

        terminals.close(third?.id ?? -1);
        // With no right neighbour the left one is chosen.
        expect(terminals.getSnapshot().activeTabId).toBe(first?.id);

        terminals.close(first?.id ?? -1);
        // The last tab leaves nothing active.
        expect(terminals.getSnapshot().activeTabId).toBeNull();
    });

    test("closing an inactive tab keeps the active one", () => {
        const { terminals, alpha } = createOwner();

        terminals.create({ agent: alpha, cwd: "/1" });
        terminals.create({ agent: alpha, cwd: "/2" });
        const [first, second] = terminals.getSnapshot().tabs;

        terminals.close(first?.id ?? -1);

        // Closing a background tab must not change what the user is looking at.
        expect(terminals.getSnapshot().activeTabId).toBe(second?.id);
    });

    test("moving a tab reorders without replacing sessions", () => {
        const { terminals, alpha } = createOwner();

        terminals.create({ agent: alpha, cwd: "/1" });
        terminals.create({ agent: alpha, cwd: "/2" });
        const [first, second] = terminals.getSnapshot().tabs;
        const sessionBefore = terminals.sessionFor(first?.id ?? -1);

        terminals.move({
            activeId: String(first?.id),
            overId: String(second?.id),
        });

        expect(terminals.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
            second?.id,
            first?.id,
        ]);
        // Reordering is presentation only; a live shell must survive it.
        expect(terminals.sessionFor(first?.id ?? -1)).toBe(sessionBefore);
    });

    test("notifies subscribers and keeps unchanged snapshots identical", () => {
        const { terminals, alpha } = createOwner();
        let notifications = 0;
        const unsubscribe = terminals.subscribe(() => (notifications += 1));

        terminals.create({ agent: alpha, cwd: "/1" });
        const afterCreate = terminals.getSnapshot();
        terminals.select(afterCreate.activeTabId ?? -1);

        // Selecting the tab that is already active changes nothing, so nobody should rerender.
        expect(terminals.getSnapshot()).toBe(afterCreate);
        expect(notifications).toBeGreaterThan(0);
        unsubscribe();
    });
});

describe("TerminalSessions following the server's session list", () => {
    test("a list containing the new session before its create response makes one tab", async () => {
        const owner = createOwner();
        followList(owner, []);
        const created = deferred<CreateTerminalSessionResponse>();

        const create = vi
            .spyOn(owner.alpha, "createTerminalSession")
            .mockReturnValue(created.promise);

        owner.terminals.create({ agent: owner.alpha, cwd: "/home/alpha" });
        showActiveTab(owner);
        await vi.waitFor(() => expect(create).toHaveBeenCalled());

        // The server announces the session to every window before this one hears back.
        const session = sessionInfo({
            id: "s-new",
            agentId: "alpha",
            number: 1,
            createdAt: 10,
        });

        owner.queryClient.setQueryData<TerminalSessionList>(
            queryKeys.terminalSessions(),
            { sessions: [session] },
        );
        // The list must not add a second tab for the session this window is creating.
        expect(owner.terminals.getSnapshot().tabs).toHaveLength(1);

        created.resolve({ session });
        await vi.waitFor(() =>
            expect(owner.terminals.getSnapshot().tabs[0]?.sessionId).toBe(
                "s-new",
            ),
        );
        // The creating tab took the session; there is still exactly one tab.
        expect(owner.terminals.getSnapshot().tabs).toHaveLength(1);
    });

    test("a list fetch that started before the create cannot remove the new tab", async () => {
        const owner = createOwner();
        followList(owner, []);
        const staleList = deferred<TerminalSessionList>();

        const session = sessionInfo({
            id: "s-new",
            agentId: "alpha",
            number: 1,
            createdAt: 10,
        });

        const list = vi
            .spyOn(owner.api, "listTerminalSessions")
            .mockReturnValueOnce(staleList.promise)
            .mockResolvedValue({ sessions: [session] });

        void owner.queryClient.invalidateQueries({
            queryKey: queryKeys.terminalSessions(),
        });
        vi.spyOn(owner.alpha, "createTerminalSession").mockResolvedValue({
            session,
        });

        owner.terminals.create({ agent: owner.alpha, cwd: "/home/alpha" });
        showActiveTab(owner);
        await vi.waitFor(() =>
            expect(owner.terminals.getSnapshot().tabs[0]?.sessionId).toBe(
                "s-new",
            ),
        );

        // The fetch from before the create answers last, without the new session.
        staleList.resolve({ sessions: [] });
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        // The new tab survives, because the stale answer was cancelled.
        expect(
            owner.terminals.getSnapshot().tabs.map((tab) => tab.sessionId),
        ).toEqual(["s-new"]);
    });
});

describe("TerminalSessions restoring tabs", () => {
    test("restores tabs in the saved order and follows other windows", () => {
        const owner = createOwner();
        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
            agentInfo("beta", "Beta"),
        ]);
        owner.queryClient.setQueryData(queryKeys.userState(), {
            ...defaultUserState,
            terminalTabs: { order: ["s-2", "s-1"], active: "s-1" },
        });
        followList(owner, [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
            sessionInfo({
                id: "s-2",
                agentId: "beta",
                number: 4,
                createdAt: 2,
            }),
            sessionInfo({
                id: "s-3",
                agentId: "alpha",
                number: 2,
                createdAt: 3,
            }),
        ]);

        const tabs = owner.terminals.getSnapshot().tabs;
        // Saved order first, then sessions the order does not know, oldest first.
        expect(tabs.map((tab) => tab.sessionId)).toEqual(["s-2", "s-1", "s-3"]);
        // The saved active tab is active again.
        expect(owner.terminals.getSnapshot().activeTabId).toBe(tabs[1]?.id);
        // Titles and numbers come from the server, so every window names tabs alike.
        expect(tabs[0]?.title).toBe("beta 4");

        // Another window closes one session and opens another.
        owner.queryClient.setQueryData<TerminalSessionList>(
            queryKeys.terminalSessions(),
            {
                sessions: [
                    sessionInfo({
                        id: "s-1",
                        agentId: "alpha",
                        number: 1,
                        createdAt: 1,
                    }),
                    sessionInfo({
                        id: "s-3",
                        agentId: "alpha",
                        number: 2,
                        createdAt: 3,
                    }),
                    sessionInfo({
                        id: "s-4",
                        agentId: "alpha",
                        number: 3,
                        createdAt: 4,
                    }),
                ],
            },
        );
        expect(
            owner.terminals.getSnapshot().tabs.map((tab) => tab.sessionId),
        ).toEqual(["s-1", "s-3", "s-4"]);

        owner.terminals.create({ agent: owner.alpha, cwd: "/a" });
        // New tabs are numbered after the restored ones of the same device, including the
        // session another window opened as number 3.
        expect(owner.terminals.getSnapshot().tabs.at(-1)?.title).toBe(
            "Alpha 4",
        );
    });

    test("closing a restored tab deletes its session and keeps it from coming back", async () => {
        const owner = createOwner();
        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
        ]);
        const deleted = deferred<{ id: string }>();

        const remove = vi
            .spyOn(owner.api, "deleteTerminalSession")
            .mockReturnValue(deleted.promise);

        vi.spyOn(owner.api, "listTerminalSessions").mockResolvedValue({
            sessions: [],
        });
        followList(owner, [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
        ]);
        const tab = owner.terminals.getSnapshot().tabs[0];

        owner.terminals.close(tab?.id ?? -1);
        await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("s-1"));
        // A list that still has the session while the delete runs must not restore it.
        owner.queryClient.setQueryData<TerminalSessionList>(
            queryKeys.terminalSessions(),
            {
                sessions: [
                    sessionInfo({
                        id: "s-1",
                        agentId: "alpha",
                        number: 1,
                        createdAt: 1,
                    }),
                ],
            },
        );
        expect(owner.terminals.getSnapshot().tabs).toHaveLength(0);
        deleted.resolve({ id: "s-1" });
    });

    test("restarting a tab deletes its old session but keeps the tab", async () => {
        const owner = createOwner();

        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
        ]);

        const remove = vi
            .spyOn(owner.api, "deleteTerminalSession")
            .mockResolvedValue({ id: "s-1" });

        vi.spyOn(owner.api, "listTerminalSessions").mockResolvedValue({
            sessions: [],
        });
        followList(owner, [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
        ]);

        const tab = owner.terminals.getSnapshot().tabs[0];

        owner.terminals.restart(tab?.id ?? -1);
        await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("s-1"));

        // The old session leaving the list must not take the restarting tab with it.
        expect(
            owner.terminals.getSnapshot().tabs.map((entry) => entry.title),
        ).toEqual(["alpha 1"]);
        // The tab waits for a new session of its own.
        expect(owner.terminals.getSnapshot().tabs[0]?.sessionId).toBeNull();
    });

    test("focusing an existing terminal saves it as the active tab", () => {
        const owner = createOwner();

        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
        ]);
        followList(owner, [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
            sessionInfo({
                id: "s-2",
                agentId: "alpha",
                number: 2,
                createdAt: 2,
            }),
        ]);

        owner.terminals.openOrFocus({
            agent: owner.alpha,
            cwd: "/home/alpha",
        });

        // The shortcut picked a tab, so a reload must come back to that same tab.
        expect(
            owner.queryClient.getQueryData<UserState>(queryKeys.userState())
                ?.terminalTabs.active,
        ).toBe(
            owner.terminals.sessionFor(
                owner.terminals.getSnapshot().activeTabId ?? -1,
            )?.sessionId,
        );
    });
});

describe("TerminalSessions picking the restored active tab", () => {
    test("falls back to the first tab when the saved active shell was destroyed", () => {
        const owner = createOwner();
        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
        ]);
        owner.queryClient.setQueryData(queryKeys.userState(), {
            ...defaultUserState,
            terminalTabs: { order: ["s-gone", "s-1", "s-2"], active: "s-gone" },
        });
        followList(owner, [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
            sessionInfo({
                id: "s-2",
                agentId: "alpha",
                number: 2,
                createdAt: 2,
            }),
        ]);

        const snapshot = owner.terminals.getSnapshot();
        // A drawer restored open must show a shell, not an empty pane with no active tab.
        expect(snapshot.activeTabId).toBe(snapshot.tabs[0]?.id);
    });

    test("activates the saved tab once its device becomes known", () => {
        const owner = createOwner();
        owner.queryClient.setQueryData(queryKeys.agents(), []);
        owner.queryClient.setQueryData(queryKeys.userState(), {
            ...defaultUserState,
            terminalTabs: { order: ["s-1", "s-2"], active: "s-2" },
        });

        const sessions = [
            sessionInfo({
                id: "s-1",
                agentId: "alpha",
                number: 1,
                createdAt: 1,
            }),
            sessionInfo({
                id: "s-2",
                agentId: "alpha",
                number: 2,
                createdAt: 2,
            }),
        ];

        followList(owner, sessions);
        // The device list has not loaded, so there is nothing to restore yet.
        expect(owner.terminals.getSnapshot().tabs).toEqual([]);

        owner.queryClient.setQueryData(queryKeys.agents(), [
            agentInfo("alpha", "Alpha"),
        ]);
        // The next list result restores the tabs. It must differ from the previous one, or the
        // structurally equal data would not notify the owner.
        owner.queryClient.setQueryData<TerminalSessionList>(
            queryKeys.terminalSessions(),
            {
                sessions: [
                    ...sessions,
                    sessionInfo({
                        id: "s-3",
                        agentId: "alpha",
                        number: 3,
                        createdAt: 3,
                    }),
                ],
            },
        );

        const snapshot = owner.terminals.getSnapshot();
        // Tabs restored after the first list result still get the saved tab as the active
        // one, instead of leaving every tab hidden.
        expect(
            owner.terminals.sessionFor(snapshot.activeTabId ?? -1)?.sessionId,
        ).toBe("s-2");
    });
});
