import React from "react";
import { Braces, ShieldCheck } from "lucide-react";
import { ToggleButton } from "#ui/components/toggle-button";
import {
    HistoryEntryStore,
    useHistoryEntryState,
} from "#ui/history-entry-state";
import {
    buildPreviewDocument,
    previewSandboxTokens,
    type SandboxedPreviewKind,
} from "#ui/utils/sandboxed-preview-document";

/** Names each kind the way readers know the format, for the region and the frame title. */
const kindLabels = {
    html: "HTML",
    svg: "SVG",
} satisfies Record<SandboxedPreviewKind, string>;

/**
 * Whether the reader let the previewed file's scripts run. It is kept per history entry and
 * file, so Back returns to the preview as it was left, while every other file and every new
 * visit starts with scripts off.
 */
const scriptsEnabledStore = new HistoryEntryStore<boolean>();

/**
 * Renders an untrusted HTML page or SVG drawing from the editor buffer. The browser has to
 * render these itself, so the document goes into a sandboxed frame with an opaque origin and
 * a policy that blocks every network load; see `sandboxed-preview-document.ts` for what is
 * allowed. Scripts are off until the reader turns them on. Turning them on still keeps the
 * document away from redoor, but not fully off the network: CSP does not cover WebRTC, so the
 * labels say so instead of promising isolation the browser cannot enforce.
 */
export function SandboxedPreview(props: {
    kind: SandboxedPreviewKind;
    content: string;
    /** Identifies the file, so the scripts choice of one file never carries over to another. */
    scope: string;
    /** Controls placed at the end of the preview's bar, such as the way back to the editor. */
    actions: React.ReactNode;
}) {
    const [scripts, updateScripts] = useHistoryEntryState<boolean>({
        store: scriptsEnabledStore,
        scope: props.scope,
        initial: () => false,
    });

    const label = kindLabels[props.kind];

    const srcDoc = React.useMemo(
        () =>
            buildPreviewDocument({
                kind: props.kind,
                content: props.content,
                scripts,
            }),
        [props.kind, props.content, scripts],
    );

    return (
        <section
            role="region"
            aria-label={`${label} preview`}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-2 py-1">
                <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-slate-400">
                    <ShieldCheck
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                    <span className="truncate">
                        {scripts
                            ? "Sandboxed, scripts may reach the network"
                            : "Sandboxed, no network access"}
                    </span>
                </p>
                <ToggleButton
                    pressed={scripts}
                    label="Enable JavaScript"
                    variant="subtle"
                    size="sm"
                    className="shrink-0 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300"
                    tooltip={
                        scripts
                            ? "Stop running the file's scripts"
                            : "Run the file's scripts. They stay isolated from redoor, but can still send data out, for example over WebRTC."
                    }
                    onClick={() => updateScripts((previous) => !previous)}
                >
                    <Braces className="h-4 w-4" aria-hidden="true" />
                    JavaScript
                </ToggleButton>
                {props.actions}
            </div>
            <iframe
                // The sandbox of a loaded frame cannot change, so a new choice needs a new frame.
                key={String(scripts)}
                title={`${label} preview frame`}
                sandbox={previewSandboxTokens(scripts)}
                srcDoc={srcDoc}
                referrerPolicy="no-referrer"
                // Pages assume a light canvas, whatever theme redoor uses around them.
                className="min-h-0 w-full flex-1 border-0 bg-white"
            />
        </section>
    );
}
