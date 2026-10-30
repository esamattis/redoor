import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import {
    ArrowLeftRight,
    Ellipsis,
    Home,
    KeyRound,
    LoaderCircle,
    LogOut,
    FileText,
    RefreshCw,
    ScrollText,
    Users,
    X,
    type LucideIcon,
} from "lucide-react";

import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { AgentStatusDot } from "#ui/components/agent-status-dot";
import { Button } from "#ui/components/button";
import { IconButton, IconLinkButton } from "#ui/components/icon-button";
import { RestartDialog } from "#ui/components/restart-button";
import { SidebarModeToggle } from "#ui/components/sidebar-mode-toggle";
import { SideMenu, SideMenuCloseButton } from "#ui/components/side-menu";
import { SortableItem, SortableList } from "#ui/components/sortable-list";
import { Tooltip } from "#ui/components/tooltip";
import { useCloseSideMenu } from "#ui/side-menu-state";
import { useAgents } from "#ui/use-agents";
import { useBrowserLocation } from "#ui/use-browser-location";
import { useWaitForServerRestart } from "#ui/use-server-restart";
import { cn } from "#ui/utils/cn";
import { useIsBelowBreakpoint } from "#ui/utils/use-breakpoint";
import { useCloseOpenFiles } from "#ui/components/browser/open-file-actions";
import {
    changedFilesOutlineAtom,
    type ChangedFilesOutlineFile,
    type ChangedFilesOutlineSnapshot,
} from "#ui/components/browser/changed-files-outline";
import { ChangeBadge } from "#ui/components/browser/git-parts";
import {
    getOpenFileKey,
    reorderOpenFiles,
    useUserState,
    type OpenFile,
} from "#ui/user-state";

const rootRouteApi = getRouteApi("__root__");

/**
 * Describes one application destination once, so the desktop rail and the phone bar cannot
 * disagree about where the menu leads or what each icon is called.
 */
type NavigationItem = {
    to: "/" | "/agents" | "/logs" | "/transfers" | "/settings/tokens";
    /** Short visible name, shown as the tooltip because the icon has no text beside it. */
    label: string;
    /** Accessible name; the existing names stay so tests and screen readers keep working. */
    ariaLabel: string;
    icon: LucideIcon;
    /** Whether only the destination itself, and not its children, marks the link current. */
    exact: boolean;
};

const navigationItems: ReadonlyArray<NavigationItem> = [
    {
        to: "/",
        label: "Home",
        ariaLabel: "Server home",
        icon: Home,
        exact: true,
    },
    {
        to: "/agents",
        label: "Devices",
        ariaLabel: "Manage devices",
        icon: Users,
        exact: true,
    },
    {
        to: "/logs",
        label: "Server logs",
        ariaLabel: "Server logs",
        icon: ScrollText,
        exact: true,
    },
    // The history page has no children today, but keeps highlighting if one is added.
    {
        to: "/transfers",
        label: "Transfers",
        ariaLabel: "Transfers",
        icon: ArrowLeftRight,
        exact: false,
    },
    {
        to: "/settings/tokens",
        label: "Access tokens",
        ariaLabel: "Manage access tokens",
        icon: KeyRound,
        // Stays highlighted on a token's edit page.
        exact: false,
    },
];

/** Places application-level destinations in the shared left-side presentation. */
export function ApplicationNavigation() {
    return (
        <SideMenu
            menu="application"
            placement="left"
            label="Application menu"
            flush
            closeButtonInContent
        >
            <ApplicationMenu />
        </SideMenu>
    );
}

/**
 * Gives open files the menu's space and compresses the destinations into icons. Wide
 * windows put them in a rail beside the open files; phones put them in a bar along the
 * bottom,
 * within thumb reach, with restart and logout behind a menu so a stray tap cannot hit them.
 * One tree switches between the two, so both share the destinations and the open files list.
 */
function ApplicationMenu() {
    const isCompact = useIsBelowBreakpoint("lg");
    const [isRestartOpen, setIsRestartOpen] = React.useState(false);
    const openRestart = () => setIsRestartOpen(true);

    return (
        <nav
            aria-label="Application"
            className={cn(
                "flex min-h-0 flex-1",
                isCompact ? "flex-col" : "flex-row",
            )}
        >
            {isCompact ? (
                <>
                    {/* The wordmark gives way in a phone-width persistent sidebar, where
                        the logo and toggle alone fill the header. */}
                    <div className="@container flex items-center gap-1.5 px-3 pt-3.5 pb-2">
                        <span className="mr-auto flex min-w-0 items-center gap-2 text-slate-100">
                            <Logo className="h-8 w-8" />
                            <span className="hidden truncate text-lg font-semibold tracking-tight @[15rem]:block">
                                Redoor
                            </span>
                        </span>
                        <SidebarModeToggle />
                        <SideMenuCloseButton />
                    </div>
                    <SidebarFiles isCompact className="px-3" />
                    <NavigationBar onRestart={openRestart} />
                </>
            ) : (
                <>
                    <NavigationRail onRestart={openRestart} />
                    <div className="flex min-w-0 flex-1 flex-col pt-3.5 pr-2 pb-2.5 pl-2.5">
                        {/* The wordmark gives way when a narrowed sidebar has room only
                            for the toggle, rather than shrinking to an ellipsis. */}
                        <div className="@container flex items-center justify-end gap-1.5 pb-2.5">
                            <span className="mr-auto hidden pl-1 text-sm font-semibold tracking-tight text-slate-100 @[9rem]:block">
                                Redoor
                            </span>
                            <SidebarModeToggle />
                            <SideMenuCloseButton />
                        </div>
                        <SidebarFiles isCompact={false} />
                    </div>
                </>
            )}
            <ServerRestartDialog
                isOpen={isRestartOpen}
                onClose={() => setIsRestartOpen(false)}
            />
        </nav>
    );
}

/** Keeps every destination one click away on wide windows while taking only an icon's width. */
function NavigationRail(props: { onRestart: () => void }) {
    const logout = useLogout();

    return (
        <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-slate-800 bg-canvas/40 pt-3.5 pb-2.5">
            <Logo className="mb-2 h-8 w-8" />
            {navigationItems.map((item) => (
                <NavigationLink key={item.to} item={item} className="h-9 w-9" />
            ))}
            <div className="flex-1" />
            <IconButton
                type="button"
                label="Restart server"
                variant="ghost"
                size="xl"
                onClick={props.onRestart}
            >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <IconButton
                type="button"
                label={logout.isPending ? "Logging out…" : "Log out"}
                variant="ghost"
                size="xl"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                className="disabled:cursor-wait"
            >
                {logout.isPending ? (
                    <LoaderCircle
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                    />
                ) : (
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                )}
            </IconButton>
        </div>
    );
}

/**
 * Lines up the destinations along the bottom of the phone drawer. Restart and logout sit
 * behind the last button because, unlike the destinations, a mistaken tap on them costs the
 * user their session or interrupts every device's transfers.
 */
function NavigationBar(props: { onRestart: () => void }) {
    const logout = useLogout();

    return (
        <div className="grid grid-cols-6 gap-0.5 border-t border-slate-800 p-2">
            {navigationItems.map((item) => (
                <NavigationLink
                    key={item.to}
                    item={item}
                    className="h-10 w-full"
                    tooltipClassName="min-w-0"
                />
            ))}
            <ActionMenu
                label="More"
                title="More actions"
                closeAriaLabel="Close more actions"
                variant="icon"
                icon={<Ellipsis className="h-4 w-4" aria-hidden="true" />}
                className="h-10 w-full"
            >
                {(close) => (
                    <>
                        <ActionMenuButton
                            onClick={() => {
                                // The confirmation lives outside the menu, so closing it first
                                // does not take the dialog down with it.
                                close();
                                props.onRestart();
                            }}
                        >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            Restart server
                        </ActionMenuButton>
                        <ActionMenuButton
                            onClick={() => logout.mutate()}
                            disabled={logout.isPending}
                        >
                            {logout.isPending ? (
                                <LoaderCircle
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : (
                                <LogOut
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            )}
                            {logout.isPending ? "Logging out…" : "Log out"}
                        </ActionMenuButton>
                    </>
                )}
            </ActionMenu>
        </div>
    );
}

/** Renders one destination as an icon whose tooltip names it, marking the current page. */
function NavigationLink(props: {
    item: NavigationItem;
    className: string;
    tooltipClassName?: string;
}) {
    const closeMenu = useCloseSideMenu();
    const Icon = props.item.icon;

    return (
        <IconLinkButton
            to={props.item.to}
            label={props.item.ariaLabel}
            tooltip={props.item.label}
            tooltipClassName={props.tooltipClassName}
            activeOptions={{ exact: props.item.exact }}
            variant="ghost"
            onClick={closeMenu}
            className={cn(
                "aria-[current=page]:bg-tint-strong aria-[current=page]:text-slate-100",
                props.className,
            )}
        >
            <Icon className="h-4 w-4" aria-hidden="true" />
        </IconLinkButton>
    );
}

/** Shows the product mark in both themes; it is decorative because Home is a link beside it. */
function Logo(props: { className: string }) {
    return (
        <span
            className={cn("relative shrink-0", props.className)}
            aria-hidden="true"
        >
            <img
                src="/logo-dark-transparent.svg"
                alt=""
                className="theme-logo-dark absolute inset-0 h-full w-full"
            />
            <img
                src="/logo-light-transparent.svg"
                alt=""
                className="theme-logo-light absolute inset-0 h-full w-full"
            />
        </span>
    );
}

/**
 * Restarts the server process and waits for the replacement before closing. It is shared by
 * the rail button and the phone's More menu, and is kept outside that menu so the
 * confirmation survives the menu closing.
 */
function ServerRestartDialog(props: { isOpen: boolean; onClose: () => void }) {
    const { api } = rootRouteApi.useRouteContext();
    const waitForServerRestart = useWaitForServerRestart();

    return (
        <RestartDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            target="server"
            description="The server will restart and re-read its configuration. Connected agents reconnect automatically. In-flight transfers and terminals are interrupted."
            restart={() => api.restartServer()}
            waitUntilReady={waitForServerRestart}
        />
    );
}

/**
 * Ends the session and reloads into the login page, so no cached server state or open
 * socket outlives the user's credentials.
 */
function useLogout() {
    const { api } = rootRouteApi.useRouteContext();
    const router = useRouter();

    return useMutation({
        mutationFn: () => api.logout(),
        onSuccess: () => {
            window.location.replace(
                router.buildLocation({ to: "/login" }).href,
            );
        },
    });
}

/**
 * Stacks the open files and the changed files of the diff on screen. Each list scrolls on its
 * own and they share the column's height, so a long list of either never pushes the other
 * out of reach.
 */
function SidebarFiles(props: { isCompact: boolean; className?: string }) {
    const outline = useAtomValue(changedFilesOutlineAtom);

    return (
        <div
            className={cn("flex min-h-0 flex-1 flex-col pb-2", props.className)}
        >
            <OpenFiles isCompact={props.isCompact} />
            {outline === null ? null : (
                <ChangedFiles outline={outline} isCompact={props.isCompact} />
            )}
        </div>
    );
}

/**
 * Lists the files of the diff on screen, so a long change set can be navigated by name
 * instead of scrolling past every patch. Picking one expands its diff and scrolls to it.
 */
function ChangedFiles(props: {
    outline: ChangedFilesOutlineSnapshot;
    isCompact: boolean;
}) {
    const closeMenu = useCloseSideMenu();
    const files = props.outline.files;

    return (
        <section
            aria-label="Changed files"
            className="mt-2 flex min-h-24 shrink flex-col"
        >
            <div className="flex min-h-7 items-center gap-1.5 py-1 pl-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Changed files
                <span
                    className="rounded-full bg-tint-strong px-1.5 text-[10px] leading-4 tracking-normal text-slate-300"
                    aria-label={`${files.length} changed`}
                >
                    {files.length}
                </span>
            </div>
            {files.length === 0 ? (
                <p className="mt-1 px-1 text-xs text-slate-500">
                    No files to show
                </p>
            ) : (
                <ul
                    aria-label="Changed files"
                    className="mt-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto"
                >
                    {files.map((file) => (
                        <ChangedFileRow
                            key={file.path}
                            file={file}
                            isCompact={props.isCompact}
                            onReveal={(path) => {
                                // The drawer covers the diff on phones, so it gets out of the way.
                                closeMenu();
                                props.outline.reveal(path);
                            }}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** One changed file, leading with its name and dimming its directory below it. */
function ChangedFileRow(props: {
    file: ChangedFilesOutlineFile;
    /** Phones get taller rows, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
    onReveal: (path: string) => void;
}) {
    const relativePath = props.file.relativePath;
    const slash = relativePath.lastIndexOf("/");
    const name = slash === -1 ? relativePath : relativePath.slice(slash + 1);
    const directory = slash === -1 ? "" : relativePath.slice(0, slash);

    return (
        <li>
            <Button
                type="button"
                variant="ghost"
                aria-label={relativePath}
                tooltip={`Show the diff of ${relativePath}`}
                tooltipClassName="w-full min-w-0"
                onClick={() => props.onReveal(props.file.path)}
                className={cn(
                    "w-full min-w-0 justify-start gap-2 px-2.5 text-left font-normal text-slate-300",
                    props.isCompact ? "py-2" : "py-1.5",
                )}
            >
                {props.file.change === null ? null : (
                    <ChangeBadge kind={props.file.change} />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-slate-200">
                        {name}
                    </span>
                    {directory === "" ? null : (
                        <span className="truncate text-[11px] leading-tight text-slate-500">
                            {directory}
                        </span>
                    )}
                </span>
            </Button>
        </li>
    );
}

/**
 * Lists open files so they stay available from every route. The section stays visible
 * while empty because open files are the column's main content, and a blank column would
 * not tell the user how to fill it. Closing a file with unsaved edits asks first.
 */
function OpenFiles(props: { isCompact: boolean }) {
    const [userState, setUserState] = useUserState();
    const agents = useAgents();
    const listRef = React.useRef<HTMLUListElement>(null);
    const openFiles = userState.openFiles;
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const closer = useCloseOpenFiles();

    const move = (itemMove: { activeId: string; overId: string }) => {
        setUserState((current) => {
            const reordered = reorderOpenFiles(current.openFiles, itemMove);

            if (reordered === current.openFiles) {
                return current;
            }

            return { ...current, openFiles: reordered };
        });
    };

    return (
        <div className="flex min-h-0 shrink flex-col">
            <div className="flex min-h-7 items-center justify-between gap-2 py-1 pl-1">
                <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
                    Open files
                    {openFiles.length > 0 ? (
                        <span
                            className="rounded-full bg-tint-strong px-1.5 text-[10px] leading-4 tracking-normal text-slate-300"
                            aria-label={`${openFiles.length} open`}
                        >
                            {openFiles.length}
                        </span>
                    ) : null}
                </span>
                {openFiles.length > 0 ? (
                    <Button
                        type="button"
                        variant="subtle"
                        aria-label="Close all open files"
                        tooltip="Close all open files"
                        onClick={() => closer.requestClose(openFiles)}
                        className="px-1 py-0.5 text-xs font-normal text-slate-500 hover:text-slate-200"
                    >
                        Clear
                    </Button>
                ) : null}
            </div>
            {openFiles.length === 0 ? (
                <p className="mt-1 flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-xs text-slate-500">
                    <FileText
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                    />
                    No open files — edit or double-click a file in the editor to
                    list it here
                </p>
            ) : (
                <SortableList
                    itemIds={openFiles.map((file) => getOpenFileKey(file))}
                    orientation="vertical"
                    label="Open files"
                    listRef={listRef}
                    getItemLabel={(itemId) =>
                        openFiles.find(
                            (file) => getOpenFileKey(file) === itemId,
                        )?.name ?? itemId
                    }
                    onMove={move}
                >
                    <ul
                        ref={listRef}
                        aria-label="Open files"
                        className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
                    >
                        {openFiles.map((file) => (
                            <OpenFileRow
                                key={getOpenFileKey(file)}
                                file={file}
                                agent={agentsById.get(file.agentId)}
                                isCompact={props.isCompact}
                                onClose={(closed) =>
                                    closer.requestClose([closed])
                                }
                            />
                        ))}
                    </ul>
                </SortableList>
            )}
            {closer.dialog}
        </div>
    );
}

/** Lets the row sort after a deliberate drag while a normal click still opens the file. */
function OpenFileRow(props: {
    file: OpenFile;
    /** The open file's device, or undefined while it is absent from the inventory. */
    agent: Agent | undefined;
    /** Phones get taller rows, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
    onClose: (file: OpenFile) => void;
}) {
    const closeMenu = useCloseSideMenu();
    const browser = useBrowserLocation();
    // The stored name is only a label for a device the inventory no longer lists.
    const deviceName = props.agent?.name ?? props.file.agentName;
    // Dimming tells the user before clicking that the file cannot be read right now.
    const isOffline = props.agent?.status !== "connected";

    // An open file is the working file, so the same path viewed at a Git revision is not it.
    const isActive =
        browser?.agentId === props.file.agentId &&
        browser.path === props.file.path &&
        browser.revision === null;

    const itemId = getOpenFileKey(props.file);

    const label = (
        <span className={cn("block min-w-0", isOffline && "opacity-60")}>
            <span className="flex min-w-0 items-baseline text-sm">
                <span
                    className={cn(
                        "truncate",
                        isActive ? "text-slate-100" : "text-slate-200",
                    )}
                >
                    {props.file.name}
                </span>
                {/* Shows where the caret is, so a line picked in a diff or search result is
                    confirmed in the list before the file is visited. It never truncates,
                    since the name says which file and the line is the new information. */}
                {props.file.line === undefined ? null : (
                    <span
                        aria-label={`Caret line ${String(props.file.line)}`}
                        className="shrink-0 text-slate-500"
                    >
                        :{props.file.line}
                    </span>
                )}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-slate-500">
                {props.agent ? (
                    <AgentStatusDot agent={props.agent} />
                ) : (
                    <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-600"
                        aria-hidden="true"
                    />
                )}
                <span className="truncate">{deviceName}</span>
            </span>
        </span>
    );

    const linkClassName = cn(
        "block w-full min-w-0 px-2.5",
        props.isCompact ? "py-2" : "py-1.5",
    );

    return (
        <SortableItem id={itemId}>
            {(item) => (
                <li
                    {...item.dragProps}
                    aria-label={`Open file ${props.file.name} on ${deviceName}`}
                    ref={item.setNodeRef}
                    style={item.style}
                    className={cn(
                        "group relative flex w-full min-w-0 items-center rounded-md",
                        item.isDragging && "opacity-70",
                        item.isOver &&
                            !item.isDragging &&
                            "ring-1 ring-blue-400/60",
                        isActive
                            ? "bg-tint-strong before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r before:bg-blue-400"
                            : "text-slate-300 hover:bg-tint",
                    )}
                >
                    <Tooltip
                        className="min-w-0 flex-1"
                        content={
                            props.agent
                                ? `Open ${props.file.path}`
                                : `${deviceName} is not available`
                        }
                    >
                        {/* Links follow the device id, never the stored name, which another
                            device may have taken since the file was opened. */}
                        {props.agent ? (
                            <Link
                                {...browserRoute(props.agent, props.file.path)}
                                // The route keeps `rev` across navigations, which would open the
                                // file read-only at the revision being browsed, where its buffer
                                // and line request do not apply.
                                search={{ rev: undefined }}
                                aria-label={props.file.name}
                                aria-current={isActive ? "page" : undefined}
                                onClick={closeMenu}
                                className={linkClassName}
                            >
                                {label}
                            </Link>
                        ) : (
                            <span
                                aria-label={props.file.name}
                                aria-disabled="true"
                                tabIndex={0}
                                className={linkClassName}
                            >
                                {label}
                            </span>
                        )}
                    </Tooltip>
                    <IconButton
                        type="button"
                        label={`Close open file ${props.file.name}`}
                        tooltip={`Close ${props.file.name}`}
                        onClick={() => props.onClose(props.file)}
                        variant="quiet"
                        size="xs"
                        className="mr-1 shrink-0"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                    </IconButton>
                </li>
            )}
        </SortableItem>
    );
}
