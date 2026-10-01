import * as React from "react";
import {
    closestCenter,
    pointerWithin,
    DndContext,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    type Announcements,
    type CollisionDetection,
    type DragEndEvent,
    type Modifier,
    type UniqueIdentifier,
} from "@dnd-kit/core";
import {
    horizontalListSortingStrategy,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { IconButton } from "#ui/components/icon-button";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";
import type { ItemMove } from "#ui/utils/reorder";

const reorderTooltip = {
    vertical:
        "Drag to reorder. Press Space to pick up, Up or Down to move, Space to drop, and Escape to cancel.",
    horizontal:
        "Drag to reorder. Press Space to pick up, Left or Right to move, Space to drop, and Escape to cancel.",
} as const;

let activeSortableDrags = 0;

/** Lets the drawer ignore Escape while a child sort is still cancelling. */
export function isSortableDragActive() {
    return activeSortableDrags > 0;
}

type SortableOrientation = "vertical" | "horizontal";

/** Bindings a row needs without learning about sensors or user state. */
export type SortableItemState = {
    setNodeRef: (element: HTMLElement | null) => void;
    style: React.CSSProperties;
    isDragging: boolean;
    isOver: boolean;
};

type SortableListContextValue = {
    orientation: SortableOrientation;
    canReorder: boolean;
    registerHandle: (itemId: string, element: HTMLButtonElement | null) => void;
};

const SortableListContext =
    React.createContext<SortableListContextValue | null>(null);

type ActivatorBindings = {
    itemId: string;
    setActivatorNodeRef: (element: HTMLElement | null) => void;
    attributes: React.HTMLAttributes<HTMLButtonElement>;
    onKeyDown?: (event: React.SyntheticEvent) => void;
    onMouseDown?: (event: React.SyntheticEvent) => void;
    onTouchStart?: (event: React.SyntheticEvent) => void;
};

const SortableActivatorContext = React.createContext<ActivatorBindings | null>(
    null,
);

/** Keeps a pointer drag from selecting a row after the dragged row has left the list. */
function visibleBounds(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    let top = Math.max(rect.top, 0);
    let left = Math.max(rect.left, 0);
    let bottom = Math.min(rect.bottom, window.innerHeight);
    let right = Math.min(rect.right, window.innerWidth);
    let parent = element.parentElement;
    while (parent) {
        const style = getComputedStyle(parent);
        const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
        if (/(auto|scroll|hidden|clip)/.test(overflow)) {
            const parentRect = parent.getBoundingClientRect();
            top = Math.max(top, parentRect.top);
            left = Math.max(left, parentRect.left);
            bottom = Math.min(bottom, parentRect.bottom);
            right = Math.min(right, parentRect.right);
        }
        // A full-window fixed surface escapes the document's normal scroll clipping.
        if (style.position === "fixed") {
            break;
        }
        parent = parent.parentElement;
    }
    return { top, left, bottom, right };
}

/** Rejects pointer drops outside the scope while keyboard sorting uses item centers. */
function boundedCollision(
    listRef: React.RefObject<HTMLElement | null>,
): CollisionDetection {
    return (args) => {
        const list = listRef.current;
        if (args.pointerCoordinates) {
            if (!list) {
                return [];
            }
            const bounds = visibleBounds(list);
            const pointer = args.pointerCoordinates;
            if (
                pointer.x < bounds.left ||
                pointer.x > bounds.right ||
                pointer.y < bounds.top ||
                pointer.y > bounds.bottom
            ) {
                return [];
            }
            // The moving source can overlap the destination, especially on wide editor pins.
            return pointerWithin({
                ...args,
                droppableContainers: args.droppableContainers.filter(
                    (container) => container.id !== args.active.id,
                ),
            });
        }
        return closestCenter(args);
    };
}

/** Limits keyboard movement to the collection's orientation. */
function axisCoordinates(orientation: SortableOrientation) {
    return (
        event: KeyboardEvent,
        args: Parameters<typeof sortableKeyboardCoordinates>[1],
    ) => {
        const vertical = event.code === "ArrowUp" || event.code === "ArrowDown";
        const horizontal =
            event.code === "ArrowLeft" || event.code === "ArrowRight";
        if (orientation === "vertical" && !vertical) {
            return undefined;
        }
        if (orientation === "horizontal" && !horizontal) {
            return undefined;
        }
        return sortableKeyboardCoordinates(event, args);
    };
}

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
    ...transform,
    x: 0,
});

const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
    ...transform,
    y: 0,
});

/** Normalizes library identifiers so callers can consistently use stable string keys. */
function textId(id: UniqueIdentifier) {
    return String(id);
}

/** Keeps the source footprint in layout while lifting the moving row above siblings. */
function sortableStyle(
    transform: Transform | null,
    transition: string | undefined,
    isDragging: boolean,
): React.CSSProperties {
    return {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
    };
}

/** Disables movement transitions when the user's motion preference changes. */
function usePrefersReducedMotion() {
    const [reduced, setReduced] = React.useState(false);
    React.useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const update = () => {
            setReduced(media.matches);
        };
        update();
        media.addEventListener("change", update);
        return () => {
            media.removeEventListener("change", update);
        };
    }, []);
    return reduced;
}

/** Describes destination positions in the owning collection rather than opaque ids. */
function collectionAnnouncements(
    label: string,
    labelFor: (id: UniqueIdentifier) => string,
    positionOf: (id: UniqueIdentifier) => string | null,
): Announcements {
    return {
        onDragStart({ active }) {
            return `Picked up ${labelFor(active.id)} in ${label}.`;
        },
        onDragOver({ active, over }) {
            if (!over) {
                return `${labelFor(active.id)} is no longer over a drop target.`;
            }
            const position = positionOf(over.id);
            if (!position) {
                return undefined;
            }
            return `${labelFor(active.id)} is now in position ${position}.`;
        },
        onDragEnd({ active, over }) {
            if (!over || textId(over.id) === textId(active.id)) {
                return `Cancelled reordering ${labelFor(active.id)}.`;
            }
            const position = positionOf(over.id);
            if (!position) {
                return `Cancelled reordering ${labelFor(active.id)}.`;
            }
            return `Dropped ${labelFor(active.id)} in position ${position}.`;
        },
        onDragCancel({ active }) {
            return `Cancelled reordering ${labelFor(active.id)}.`;
        },
    };
}

/** Tracks active child sorting even when a drawer's Escape listener runs first. */
function useDragSession() {
    const draggingRef = React.useRef(false);
    const markActive = React.useCallback(() => {
        if (draggingRef.current) {
            return;
        }
        draggingRef.current = true;
        activeSortableDrags += 1;
    }, []);
    const markInactive = React.useCallback(() => {
        if (!draggingRef.current) {
            return;
        }
        draggingRef.current = false;
        activeSortableDrags -= 1;
    }, []);
    React.useEffect(() => markInactive, [markInactive]);
    return { markActive, markInactive };
}

/** Consumes drag cancellation before drawers while leaving modified and text-entry keys alone. */
function useSortableKeys(activeId: string | null) {
    React.useEffect(() => {
        if (!activeId) {
            return;
        }
        // Capture runs before the drawer's bubble listener, which is registered earlier.
        const consumeKeys = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                return;
            }
            if (shouldIgnoreKeyboardShortcut(event)) {
                event.stopPropagation();
            }
        };
        document.addEventListener("keydown", consumeKeys, true);
        return () => {
            document.removeEventListener("keydown", consumeKeys, true);
        };
    }, [activeId]);
}

/** Invalidates a gesture permanently if its membership changes before the drop. */
function useDragScope(itemIds: string[]) {
    const dragIdsRef = React.useRef<string[] | null>(null);
    React.useEffect(() => {
        const initialIds = dragIdsRef.current;
        if (
            initialIds &&
            (initialIds.length !== itemIds.length ||
                initialIds.some((id) => !itemIds.includes(id)))
        ) {
            // Invalidate permanently, even if the same membership later reappears.
            dragIdsRef.current = null;
        }
    }, [itemIds]);
    return dragIdsRef;
}

/**
 * Shares sortable activation, cancellation, and announcements across navigation lists.
 * Domain rows and preference writes stay at the call site.
 */
export function SortableList(props: {
    itemIds: string[];
    orientation: SortableOrientation;
    label: string;
    listRef: React.RefObject<HTMLElement | null>;
    getItemLabel: (itemId: string) => string;
    onMove: (move: ItemMove) => void;
    children: React.ReactNode;
}) {
    const contextId = React.useId();
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const [announcement, setAnnouncement] = React.useState("");
    const [libraryContainer, setLibraryContainer] =
        React.useState<HTMLElement | null>(null);
    const handles = React.useRef(new Map<string, HTMLButtonElement>());
    const pendingFocusId = React.useRef<string | null>(null);
    const itemIdsRef = React.useRef(props.itemIds);
    const dragIdsRef = useDragScope(props.itemIds);
    const lastOverIdRef = React.useRef<string | null>(null);
    const onMoveRef = React.useRef(props.onMove);
    const labelRef = React.useRef(props.getItemLabel);
    const { markActive, markInactive } = useDragSession();
    itemIdsRef.current = props.itemIds;
    onMoveRef.current = props.onMove;
    labelRef.current = props.getItemLabel;
    const coordinateGetter = React.useMemo(
        () => axisCoordinates(props.orientation),
        [props.orientation],
    );
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, {
            activationConstraint: { delay: 200, tolerance: 8 },
        }),
        useSensor(KeyboardSensor, { coordinateGetter }),
    );
    const collisionDetection = React.useMemo(
        () => boundedCollision(props.listRef),
        [props.listRef],
    );
    const announcements = React.useMemo(
        () =>
            collectionAnnouncements(
                props.label,
                (id) => labelRef.current(textId(id)),
                (id) => {
                    const index = itemIdsRef.current.indexOf(textId(id));
                    if (index < 0) {
                        return null;
                    }
                    return `${index + 1} of ${itemIdsRef.current.length}`;
                },
            ),
        [props.label],
    );

    useSortableKeys(activeId);

    React.useEffect(() => {
        const focusId = pendingFocusId.current;
        if (!focusId) {
            return;
        }
        pendingFocusId.current = null;
        handles.current.get(focusId)?.focus();
    });

    const finishDrag = (focusId: string) => {
        markInactive();
        setActiveId(null);
        pendingFocusId.current = focusId;
    };
    const handleDragEnd = (event: DragEndEvent) => {
        const active = textId(event.active.id);
        const over = event.over ? textId(event.over.id) : null;
        finishDrag(active);
        if (!over || active === over) {
            return;
        }
        const ids = itemIdsRef.current;
        const initialIds = dragIdsRef.current;
        dragIdsRef.current = null;
        if (
            !initialIds ||
            initialIds.length !== ids.length ||
            initialIds.some((id) => !ids.includes(id)) ||
            !ids.includes(active) ||
            !ids.includes(over)
        ) {
            return;
        }
        onMoveRef.current({ activeId: active, overId: over });
    };
    const registerHandle = React.useCallback(
        (itemIdToRegister: string, element: HTMLButtonElement | null) => {
            if (element) {
                handles.current.set(itemIdToRegister, element);
                return;
            }
            handles.current.delete(itemIdToRegister);
        },
        [],
    );
    const listContext = React.useMemo(
        () => ({
            orientation: props.orientation,
            canReorder: props.itemIds.length >= 2,
            registerHandle,
        }),
        [props.itemIds.length, props.orientation, registerHandle],
    );

    return (
        <SortableListContext.Provider value={listContext}>
            <DndContext
                id={contextId}
                sensors={sensors}
                collisionDetection={collisionDetection}
                modifiers={[
                    props.orientation === "vertical"
                        ? restrictToVerticalAxis
                        : restrictToHorizontalAxis,
                ]}
                autoScroll
                cancelDrop={() => dragIdsRef.current === null}
                accessibility={{
                    container: libraryContainer ?? undefined,
                    screenReaderInstructions: {
                        draggable: `To reorder an item in ${props.label}, press Space or Enter. Use the arrow keys to move within the list. Press Space or Enter to drop, or Escape to cancel.`,
                    },
                    announcements,
                }}
                onDragStart={(event) => {
                    dragIdsRef.current = [...itemIdsRef.current];
                    lastOverIdRef.current = textId(event.active.id);
                    markActive();
                    setActiveId(textId(event.active.id));
                    setAnnouncement(
                        announcements.onDragStart({ active: event.active }) ??
                            "",
                    );
                }}
                onDragOver={(event) => {
                    const overId = event.over ? textId(event.over.id) : null;
                    // Initial collision with the source must not immediately replace pickup guidance.
                    if (overId === lastOverIdRef.current) {
                        return;
                    }
                    lastOverIdRef.current = overId;
                    const message = announcements.onDragOver(event);
                    if (message) {
                        setAnnouncement(message);
                    }
                }}
                onDragCancel={(event) => {
                    setAnnouncement(
                        announcements.onDragCancel({
                            active: event.active,
                            over: event.over,
                        }) ?? "",
                    );
                    if (activeId) {
                        finishDrag(activeId);
                    }
                }}
                onDragEnd={(event) => {
                    setAnnouncement(
                        announcements.onDragEnd({
                            active: event.active,
                            over: event.over,
                        }) ?? "",
                    );
                    handleDragEnd(event);
                }}
            >
                <SortableContext
                    id={contextId}
                    items={props.itemIds}
                    strategy={
                        props.orientation === "vertical"
                            ? verticalListSortingStrategy
                            : horizontalListSortingStrategy
                    }
                >
                    {props.children}
                </SortableContext>
            </DndContext>
            {/* Library status nodes would collide with transfer and agent status alerts. */}
            <div ref={setLibraryContainer} hidden aria-hidden="true" />
            <div
                aria-live="assertive"
                aria-atomic="true"
                aria-label={`${props.label} reorder announcement`}
                className="sr-only"
            >
                {announcement}
            </div>
        </SortableListContext.Provider>
    );
}

/** Adapts library activators to the shared button's React event contract. */
function bindListener(
    listeners: ReturnType<typeof useSortable>["listeners"],
    name: "onKeyDown" | "onMouseDown" | "onTouchStart",
) {
    const handler = listeners?.[name];
    if (!handler) {
        return undefined;
    }
    return (event: React.SyntheticEvent) => {
        handler(event);
    };
}

/** Exposes only grip activation so the row's ordinary controls remain independent. */
function activatorFromSortable(
    itemId: string,
    sortable: ReturnType<typeof useSortable>,
): ActivatorBindings {
    return {
        itemId,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
        attributes: sortable.attributes,
        onKeyDown: bindListener(sortable.listeners, "onKeyDown"),
        onMouseDown: bindListener(sortable.listeners, "onMouseDown"),
        onTouchStart: bindListener(sortable.listeners, "onTouchStart"),
    };
}

/**
 * Connects an existing row to sortable measurement without taking over its markup.
 * The render callback keeps links and buttons outside the grip.
 */
export function SortableItem(props: {
    id: string;
    children: (item: SortableItemState) => React.ReactNode;
}) {
    const reducedMotion = usePrefersReducedMotion();
    const sortable = useSortable({
        id: props.id,
        transition: reducedMotion ? null : undefined,
    });
    const activator = activatorFromSortable(props.id, sortable);
    const item: SortableItemState = {
        setNodeRef: sortable.setNodeRef,
        style: sortableStyle(
            sortable.transform,
            sortable.transition,
            sortable.isDragging,
        ),
        isDragging: sortable.isDragging,
        isOver: sortable.isOver,
    };
    return (
        <SortableActivatorContext.Provider value={activator}>
            {props.children(item)}
        </SortableActivatorContext.Provider>
    );
}

/**
 * Starts sorting only from the grip so links and remove buttons keep their own clicks.
 * Hidden below two items so a lone row does not advertise a move it cannot make.
 */
export function SortableDragHandle(props: { label: string }) {
    const list = React.useContext(SortableListContext);
    const activator = React.useContext(SortableActivatorContext);
    if (!list || !activator || !list.canReorder) {
        return null;
    }
    return (
        <IconButton
            ref={(element) => {
                activator.setActivatorNodeRef(element);
                list.registerHandle(activator.itemId, element);
            }}
            type="button"
            label={props.label}
            tooltip={reorderTooltip[list.orientation]}
            className="min-h-8 min-w-8 shrink-0 touch-none rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
            {...activator.attributes}
            onKeyDown={(event) => {
                if (shouldIgnoreKeyboardShortcut(event.nativeEvent)) {
                    return;
                }
                activator.onKeyDown?.(event);
            }}
            onMouseDown={(event) => {
                activator.onMouseDown?.(event);
            }}
            onTouchStart={(event) => {
                activator.onTouchStart?.(event);
            }}
        >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
    );
}
