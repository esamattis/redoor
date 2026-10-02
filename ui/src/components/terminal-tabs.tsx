import * as React from "react";
import {
    CircleCheck,
    CircleX,
    HardDrive,
    LoaderCircle,
    MoreHorizontal,
    RotateCcw,
    X,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { BrowserListingRefreshTarget } from "#ui/bottom-drawer-state";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { AddButton } from "#ui/components/add-button";
import { IconButton } from "#ui/components/icon-button";
import { SortableItem, SortableList } from "#ui/components/sortable-list";
import type { ItemMove } from "#ui/utils/reorder";

/** Separates shell setup progress from recoverable terminal disconnection. */
export type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

/** Keeps each tab's owning agent, creation directory, and lifecycle independent. */
export type TerminalTab = {
    id: number;
    agent: Agent;
    agentTerminalNumber: number;
    title: string;
    cwd: string;
    state: TerminalState;
    restartGeneration: number;
    startupCommand: string | null;
    refreshTarget: BrowserListingRefreshTarget | null;
};

/** Identifies the routed agent and directory used by the direct new-terminal action. */
export type ActiveTerminalTarget = { agent: Agent; cwd: string };

/** Adds one-shot shell input only for feature-created terminals. */
export type TerminalCreationTarget = ActiveTerminalTarget & {
    startupCommand?: string;
    refreshTarget?: BrowserListingRefreshTarget;
};

/** Gives each terminal tab its own concise lifecycle label and color. */
function getTerminalStatus(state: TerminalState) {
    if (state.type === "connected") {
        return { label: "Connected", color: "text-emerald-400" };
    }
    if (state.type === "disconnected") {
        return { label: "Disconnected", color: "text-amber-400" };
    }
    return { label: "Connecting", color: "text-slate-400" };
}

/** Renders terminal-tab controls while keeping panel lifecycle state local to the parent. */
export function TerminalTabActions(props: {
    agents: Agent[];
    activeTarget: ActiveTerminalTarget | null;
    isPickerOpen: boolean;
    tabs: TerminalTab[];
    activeTabId: number | null;
    onCreate: (target: TerminalCreationTarget) => void;
    onPickerOpenChange: (isOpen: boolean) => void;
    onClose: (tabId: number) => void;
    onMove: (move: ItemMove) => void;
    onRestart: (tabId: number) => void;
    onSelect: (tabId: number) => void;
    onTabKeyDown: (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => void;
}) {
    const listRef = React.useRef<HTMLDivElement>(null);
    const availableAgents = props.agents.filter(
        (agent) => agent.status === "connected" && agent.cwd !== null,
    );
    return (
        <div className="flex min-w-max max-w-none items-center gap-1">
            <SortableList
                itemIds={props.tabs.map((tab) => String(tab.id))}
                orientation="horizontal"
                label="Terminal tabs"
                listRef={listRef}
                getItemLabel={(itemId) =>
                    props.tabs.find((tab) => String(tab.id) === itemId)
                        ?.title ?? itemId
                }
                onMove={props.onMove}
            >
                <div
                    ref={listRef}
                    role="tablist"
                    aria-label="Terminal tabs"
                    className="flex min-h-8 min-w-px items-center gap-1"
                >
                    {props.tabs.map((tab, tabIndex) => (
                        <TerminalTabControl
                            key={tab.id}
                            tab={tab}
                            tabIndex={tabIndex}
                            isActive={tab.id === props.activeTabId}
                            onClose={props.onClose}
                            onRestart={props.onRestart}
                            onSelect={props.onSelect}
                            onTabKeyDown={props.onTabKeyDown}
                        />
                    ))}
                </div>
            </SortableList>
            {props.activeTarget ? (
                <AddButton
                    tooltip={`New terminal in ${props.activeTarget.agent.name} (t, Alt+t)`}
                >
                    <button
                        type="button"
                        aria-label="New terminal"
                        onClick={() => {
                            if (props.activeTarget) {
                                props.onCreate(props.activeTarget);
                            }
                        }}
                    />
                </AddButton>
            ) : null}
            <ActionMenu
                label="Choose device for new terminal"
                title="New terminal"
                closeAriaLabel="Close device picker"
                hideTitle={false}
                tooltip={
                    props.activeTarget
                        ? "New terminal on another device"
                        : "Choose device for new terminal (t)"
                }
                icon={<MoreHorizontal className="h-4 w-4" />}
                variant="icon"
                isOpen={props.isPickerOpen}
                onOpenChange={props.onPickerOpenChange}
            >
                {(close) => (
                    <>
                        {availableAgents.map((agent) => (
                            <ActionMenuButton
                                key={agent.id}
                                onClick={() => {
                                    if (agent.cwd === null) {
                                        return;
                                    }
                                    props.onCreate({ agent, cwd: agent.cwd });
                                    close();
                                }}
                            >
                                <HardDrive className="h-4 w-4 text-slate-500" />
                                <span className="truncate">{agent.name}</span>
                            </ActionMenuButton>
                        ))}
                        {availableAgents.length === 0 ? (
                            <p className="px-3 py-2 text-sm text-slate-500">
                                No connected devices
                            </p>
                        ) : null}
                    </>
                )}
            </ActionMenu>
        </div>
    );
}

/** Keeps sorting, activation, and lifecycle controls together for one terminal tab. */
function TerminalTabControl(props: {
    tab: TerminalTab;
    tabIndex: number;
    isActive: boolean;
    onClose: (tabId: number) => void;
    onRestart: (tabId: number) => void;
    onSelect: (tabId: number) => void;
    onTabKeyDown: (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => void;
}) {
    const status = getTerminalStatus(props.tab.state);
    return (
        <SortableItem
            id={String(props.tab.id)}
            onRemove={() => props.onClose(props.tab.id)}
        >
            {(item) => (
                <div
                    {...item.dragProps}
                    ref={item.setNodeRef}
                    style={item.style}
                    aria-label={`Terminal tab ${props.tab.title}`}
                    className={`flex shrink-0 items-center overflow-hidden rounded-md border transition-colors ${
                        item.isDragging ? "opacity-70" : ""
                    } ${
                        item.isOver && !item.isDragging
                            ? "ring-1 ring-blue-400/60"
                            : ""
                    } ${
                        props.isActive
                            ? "border-blue-500/50 bg-slate-700 shadow-[0_0_0_1px_rgba(59,130,246,0.12)]"
                            : "border-slate-700 bg-slate-900"
                    }`}
                    title={`${props.tab.title}: ${props.tab.cwd}`}
                >
                    <button
                        type="button"
                        id={`terminal-tab-${props.tab.id}`}
                        role="tab"
                        aria-label={props.tab.title}
                        aria-selected={props.isActive}
                        aria-controls={`terminal-panel-${props.tab.id}`}
                        tabIndex={props.isActive ? 0 : -1}
                        onClick={() => props.onSelect(props.tab.id)}
                        onKeyDown={(event) =>
                            props.onTabKeyDown(event, props.tabIndex)
                        }
                        className={`flex h-8 items-center gap-2 px-2.5 text-xs font-medium transition-colors ${props.isActive ? "text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                    >
                        <span className="max-w-36 truncate whitespace-nowrap">
                            {props.tab.agent.name}
                        </span>
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-slate-950/70 px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-slate-300">
                            {props.tab.agentTerminalNumber}
                        </span>
                        <span
                            role="status"
                            aria-label={`${props.tab.title}: ${status.label}`}
                            title={status.label}
                            className={status.color}
                        >
                            {props.tab.state.type === "connected" ? (
                                <CircleCheck className="h-3.5 w-3.5" />
                            ) : props.tab.state.type === "disconnected" ? (
                                <CircleX className="h-3.5 w-3.5" />
                            ) : (
                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            )}
                        </span>
                    </button>
                    {props.tab.state.type === "disconnected" ? (
                        <IconButton
                            type="button"
                            label={`Restart ${props.tab.title}`}
                            onClick={() => props.onRestart(props.tab.id)}
                            className="inline-flex h-8 w-7 items-center justify-center border-l border-slate-700 text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                        </IconButton>
                    ) : null}
                    <IconButton
                        type="button"
                        label={`Close ${props.tab.title}`}
                        onClick={() => props.onClose(props.tab.id)}
                        className="inline-flex h-8 w-7 items-center justify-center border-l border-slate-700 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200"
                    >
                        <X className="h-3.5 w-3.5" />
                    </IconButton>
                </div>
            )}
        </SortableItem>
    );
}
