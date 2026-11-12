import * as React from "react";
import { useRouter } from "@tanstack/react-router";
import { FileText, Folder } from "lucide-react";

import { browserRoute } from "#ui/browser-route";
import { Button } from "#ui/components/button";
import { Toast } from "#ui/components/toast";
import type { OpenPathEvent } from "#ui/refresh-listener";
import { useAgents } from "#ui/use-agents";

/**
 * Carries out `rd-open` requests from terminals. Every window receives them, so the one the
 * person is using (the focused one, where the terminal usually is) opens the path at once,
 * and every other window only offers to, which also covers a command that ran while no
 * window had focus, such as `sleep 5; rd-open notes.md`. Returns the handler for the event
 * listener and the offer toast for the shell to render. `onBeforeOpen` lets the shell move
 * whatever covers the page, such as a full-window terminal, out of the way of the path.
 */
export function useOpenPathRequests(onBeforeOpen: () => void) {
    const router = useRouter();
    const agents = useAgents();

    const [offer, setOffer] = React.useState<{
        id: number;
        event: OpenPathEvent;
    } | null>(null);

    // A new request restarts the toast and its dismiss timer, even for the same path.
    const nextOfferId = React.useRef(0);

    /** Shows the path in the file browser, which opens files in their viewer or editor. */
    const open = (event: OpenPathEvent) => {
        // The window may not list a device that connected moments ago, and the URL only
        // needs its name.
        const device = agents.find((agent) => agent.id === event.agent_id) ?? {
            id: event.agent_id,
            name: event.device_name,
        };

        onBeforeOpen();
        void router.navigate({
            ...browserRoute(device, event.path),
            // The path on disk, not the Git revision this window may be browsing.
            search: { rev: undefined },
        });
    };

    const onOpenPath = (event: OpenPathEvent) => {
        if (document.hasFocus()) {
            setOffer(null);
            open(event);

            return;
        }

        nextOfferId.current += 1;
        setOffer({ id: nextOfferId.current, event });
    };

    const toast =
        offer === null ? null : (
            <OpenPathToast
                key={offer.id}
                event={offer.event}
                onOpen={() => {
                    setOffer(null);
                    open(offer.event);
                }}
                onDismiss={() => setOffer(null)}
            />
        );

    return { onOpenPath, toast };
}

/** Offers to open a path that a terminal asked for while this window had no focus. */
function OpenPathToast(props: {
    event: OpenPathEvent;
    onOpen: () => void;
    onDismiss: () => void;
}) {
    const Icon = props.event.kind === "directory" ? Folder : FileText;

    return (
        <Toast
            tone="info"
            icon={<Icon className="h-4 w-4" />}
            action={
                <Button
                    size="sm"
                    onClick={props.onOpen}
                    tooltip={`Show this ${props.event.kind} in this window`}
                >
                    Open
                </Button>
            }
            dismissAriaLabel="Dismiss open request"
            onDismiss={props.onDismiss}
        >
            {/* Paths have no spaces to wrap at, so they break anywhere on a phone. */}
            Open <span className="break-all font-mono">{props.event.path}</span>{" "}
            on {props.event.device_name}?
        </Toast>
    );
}
