import type * as React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Maximize2 } from "lucide-react";
import { Dialog } from "#ui/components/dialog";
import { IconButton } from "#ui/components/icon-button";
import { ZoomPanView } from "#ui/components/zoom-pan-view";
import { resolvedThemeAtom } from "#ui/theme-state";

const rootRouteApi = getRouteApi("__root__");

/**
 * Shows a ` ```mermaid ` fence as the diagram it describes, like GitHub does. The drawing is
 * made in the app's sandboxed renderer frame and shown as an image, so nothing the diagram
 * contains can run or load. The fence's code shows while the diagram is drawn and under a
 * parse error, so the author still sees what they wrote and what to fix.
 */
export function MermaidDiagram(props: {
    source: string;
    /** The fence rendered as code, shown until the drawing is ready or when it fails. */
    code: React.ReactNode;
}) {
    const { mermaid } = rootRouteApi.useRouteContext();
    const [isFullWindow, setFullWindow] = useState(false);
    const theme = useAtomValue(resolvedThemeAtom);

    // Cached by source and theme, so switching between the editor and the preview, or
    // editing another part of the file, does not redraw every diagram.
    const diagram = useQuery({
        queryKey: ["mermaid-diagram", theme, props.source],
        queryFn: () => mermaid.render({ source: props.source, theme }),
        staleTime: Infinity,
        // A parse error stays one until the source changes, so retrying only delays it.
        retry: false,
    });

    if (diagram.isError) {
        return (
            <>
                {props.code}
                <p
                    role="alert"
                    className="not-prose -mt-3 mb-5 whitespace-pre-wrap break-words rounded-md border border-red-500/40 bg-red-950/30 px-3 py-2 font-mono text-xs text-red-300"
                >
                    {`Mermaid diagram failed: ${diagram.error.message}`}
                </p>
            </>
        );
    }

    if (diagram.data === undefined) {
        return props.code;
    }

    const drawing = diagram.data;
    const name = drawing.title ?? "Mermaid diagram";
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawing.svg)}`;

    return (
        // Side padding keeps a wide diagram clear of the button in the corner.
        <div className="not-prose relative my-5 flex justify-center overflow-hidden rounded-md border border-slate-700 bg-slate-900 px-12 py-4">
            <img
                src={src}
                alt={name}
                width={drawing.width > 0 ? drawing.width : undefined}
                height={drawing.height > 0 ? drawing.height : undefined}
                // Scales a wide diagram down to the column, so phones see all of it.
                className="h-auto max-w-full"
            />
            <div className="absolute right-1 top-1">
                <IconButton
                    type="button"
                    size="sm"
                    label="View diagram in full window"
                    onClick={() => setFullWindow(true)}
                    className="rounded-md border border-slate-700 bg-slate-900 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
                >
                    <Maximize2 className="size-4" aria-hidden="true" />
                </IconButton>
            </div>
            <Dialog
                isOpen={isFullWindow}
                title={name}
                closeAriaLabel="Close full window diagram"
                size="fullscreen"
                onClose={() => setFullWindow(false)}
            >
                {/* The drawing is vector, so it stays sharp at any zoom, and a diagram too
                    large to read in the column can be explored up close. */}
                <div className="mt-4 flex min-h-0 flex-1 flex-col">
                    <ZoomPanView label={`${name}, zoomable`}>
                        <img
                            src={src}
                            alt={name}
                            // Dragging pans the view, not the browser's image drag-and-drop.
                            draggable={false}
                            className="h-full w-full object-contain"
                        />
                    </ZoomPanView>
                </div>
            </Dialog>
        </div>
    );
}
