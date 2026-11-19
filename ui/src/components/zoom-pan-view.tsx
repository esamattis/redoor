import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";

/** A point in the view's own coordinates, so gestures do not depend on where the view sits. */
type Point = { x: number; y: number };

/** How the content is moved and scaled; the identity shows it fitted to the view. */
export type ZoomPanTransform = { x: number; y: number; scale: number };

/** The fitted view every zoom starts from and the reset returns to. */
export const IDENTITY_TRANSFORM: ZoomPanTransform = { x: 0, y: 0, scale: 1 };

/** Half the fitted size is enough to see the whole thing; beyond 20x drawings stop gaining detail. */
const MIN_SCALE = 0.5;

const MAX_SCALE = 20;

/** The step of the zoom buttons, large enough that a few taps reach any detail. */
const BUTTON_ZOOM_FACTOR = 1.5;

/**
 * Applies one gesture step: the content point under `from` moves to `to` while the scale
 * grows by `factor`. A pan is a step with factor 1, a wheel zoom keeps `from` and `to`
 * equal, and a pinch does both at once, so every input shares this one rule. The factor is
 * clamped first, so zooming past a limit does not drift the content.
 */
export function applyZoomPanGesture(options: {
    transform: ZoomPanTransform;
    from: Point;
    to: Point;
    factor: number;
}): ZoomPanTransform {
    const current = options.transform;

    const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * options.factor),
    );

    const applied = scale / current.scale;

    return {
        scale,
        x: options.to.x - (options.from.x - current.x) * applied,
        y: options.to.y - (options.from.y - current.y) * applied,
    };
}

/** The midpoint and spread of two touches, which drive a pinch. */
function pinchOf(first: Point, second: Point) {
    return {
        center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        distance: Math.hypot(first.x - second.x, first.y - second.y),
    };
}

/** Turns a wheel event into a scale factor, whatever unit the device reports its delta in. */
function wheelZoomFactor(event: WheelEvent) {
    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    // Trackpad pinches arrive as ctrl+wheel with small deltas, so they need a stronger response.
    const sensitivity = event.ctrlKey ? 0.01 : 0.0015;

    return Math.exp(-event.deltaY * pixels * sensitivity);
}

/**
 * Shows content, such as a diagram, that the reader can zoom with the mouse wheel or a
 * pinch and pan by dragging with a mouse or a finger. Buttons do the same for readers
 * without a wheel or touch screen, and show the zoom level. Panning is not bounded, so the
 * reset button is always the way back to the fitted view.
 */
export function ZoomPanView(props: {
    /** Names the zoomable area for assistive technology. */
    label: string;
    /** Fills the view; it is scaled as a whole, so it should fit the view at scale 1. */
    children: React.ReactNode;
}) {
    const viewRef = useRef<HTMLDivElement>(null);
    const [transform, setTransform] = useState(IDENTITY_TRANSFORM);
    // Pointer positions change on every move, so they live outside render state.
    const pointers = useRef(new Map<number, Point>());

    // React registers wheel listeners as passive, and only an active one can keep the
    // browser from scrolling or zooming the page instead of the content.
    useEffect(() => {
        const view = viewRef.current;

        if (view === null) {
            return;
        }

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const point = pointInView(view, event);

            setTransform((current) =>
                applyZoomPanGesture({
                    transform: current,
                    from: point,
                    to: point,
                    factor: wheelZoomFactor(event),
                }),
            );
        };

        view.addEventListener("wheel", onWheel, { passive: false });

        return () => view.removeEventListener("wheel", onWheel);
    }, []);

    /** Zooms around the middle of the view, where the button reader is looking. */
    const zoomAtCenter = (factor: number) => {
        const view = viewRef.current;

        if (view === null) {
            return;
        }

        const center = { x: view.clientWidth / 2, y: view.clientHeight / 2 };

        setTransform((current) =>
            applyZoomPanGesture({
                transform: current,
                from: center,
                to: center,
                factor,
            }),
        );
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const previous = pointers.current.get(event.pointerId);

        if (previous === undefined) {
            return;
        }

        const point = pointInView(event.currentTarget, event.nativeEvent);

        const others = [...pointers.current].filter(
            ([id]) => id !== event.pointerId,
        );

        pointers.current.set(event.pointerId, point);

        const partner = others[0]?.[1];

        if (partner === undefined) {
            setTransform((current) =>
                applyZoomPanGesture({
                    transform: current,
                    from: previous,
                    to: point,
                    factor: 1,
                }),
            );

            return;
        }

        const before = pinchOf(previous, partner);
        const after = pinchOf(point, partner);

        setTransform((current) =>
            applyZoomPanGesture({
                transform: current,
                from: before.center,
                to: after.center,
                factor:
                    before.distance > 0 ? after.distance / before.distance : 1,
            }),
        );
    };

    const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(event.pointerId);
    };

    const isFitted =
        transform.x === 0 && transform.y === 0 && transform.scale === 1;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-end gap-1">
                <span
                    className="mr-1 text-xs tabular-nums text-slate-400"
                    aria-live="polite"
                >
                    {`${Math.round(transform.scale * 100)}%`}
                </span>
                <IconButton
                    type="button"
                    size="lg"
                    variant="outline"
                    label="Zoom out"
                    disabled={transform.scale <= MIN_SCALE}
                    onClick={() => zoomAtCenter(1 / BUTTON_ZOOM_FACTOR)}
                >
                    <ZoomOut className="size-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                    type="button"
                    size="lg"
                    variant="outline"
                    label="Zoom in"
                    disabled={transform.scale >= MAX_SCALE}
                    onClick={() => zoomAtCenter(BUTTON_ZOOM_FACTOR)}
                >
                    <ZoomIn className="size-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                    type="button"
                    size="lg"
                    variant="outline"
                    label="Reset zoom and position"
                    disabled={isFitted}
                    onClick={() => setTransform(IDENTITY_TRANSFORM)}
                >
                    <RotateCcw className="size-4" aria-hidden="true" />
                </IconButton>
            </div>
            <div
                ref={viewRef}
                role="group"
                aria-label={props.label}
                // `touch-none` hands touches to the gestures instead of the browser's own scrolling.
                className="relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
                onPointerDown={(event) => {
                    // Captured, so a drag that leaves the view still moves the content.
                    event.currentTarget.setPointerCapture(event.pointerId);
                    pointers.current.set(
                        event.pointerId,
                        pointInView(event.currentTarget, event.nativeEvent),
                    );
                }}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
            >
                <div
                    className="h-full w-full origin-top-left"
                    style={{
                        transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                    }}
                >
                    {props.children}
                </div>
            </div>
        </div>
    );
}

/** The event's position relative to the view's top-left corner. */
function pointInView(view: HTMLElement, event: MouseEvent): Point {
    const box = view.getBoundingClientRect();

    return { x: event.clientX - box.left, y: event.clientY - box.top };
}
