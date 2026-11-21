import React from "react";
import { Braces, Image as ImageIcon, ShieldCheck } from "lucide-react";
import { ToggleButton } from "#ui/components/toggle-button";
import { usePreviewApproval } from "#ui/user-state";
import {
    buildPreviewDocument,
    previewSandboxTokens,
} from "#ui/utils/sandboxed-preview-document";
import type { SandboxedPreviewKind } from "#ui/utils/sandboxed-preview-document";

/** Names each kind the way readers know the format, for the region and the frame title. */
const kindLabels = {
    html: "HTML",
    svg: "SVG",
} satisfies Record<SandboxedPreviewKind, string>;

/** Says what the frame may reach, so the reader sees the effect of the approvals given. */
function networkAccessLabel(scripts: boolean, images: boolean) {
    if (scripts) {
        return "Sandboxed, scripts may reach the network";
    }

    if (images) {
        return "Sandboxed, images load from the network";
    }

    return "Sandboxed, no network access";
}

/**
 * Renders an untrusted HTML page or SVG drawing from the editor buffer. The browser has to
 * render these itself, so the document goes into a sandboxed frame with an opaque origin and
 * a policy that blocks every network load; see `sandboxed-preview-document.ts` for what is
 * allowed. Scripts and remote images are off until the reader approves them for the file;
 * the approvals are remembered for a while and can be revoked with the same toggles. Scripts
 * still keep the document away from redoor, but not fully off the network: CSP does not
 * cover WebRTC, so the labels say so instead of promising isolation the browser cannot enforce.
 */
export function SandboxedPreview(props: {
    kind: SandboxedPreviewKind;
    content: string;
    /** With `filePath`, names the file the approvals belong to, so they never carry over. */
    agentId: string;
    filePath: string;
    /** Controls placed at the end of the preview's bar, such as the way back to the editor. */
    actions: React.ReactNode;
}) {
    const [scripts, setScripts] = usePreviewApproval({
        agentId: props.agentId,
        path: props.filePath,
        kind: "scripts",
    });

    const [approvedImages, setImages] = usePreviewApproval({
        agentId: props.agentId,
        path: props.filePath,
        kind: "images",
    });

    // An SVG without scripts is shown as an image, which never loads anything it references.
    const offersImages = props.kind === "html";
    const images = offersImages && approvedImages;

    const label = kindLabels[props.kind];

    const srcDoc = React.useMemo(
        () =>
            buildPreviewDocument({
                kind: props.kind,
                content: props.content,
                permissions: { scripts, images },
            }),
        [props.kind, props.content, scripts, images],
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
                        {networkAccessLabel(scripts, images)}
                    </span>
                </p>
                {offersImages ? (
                    <ToggleButton
                        pressed={images}
                        label="Show images"
                        variant="subtle"
                        size="sm"
                        className="shrink-0 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300"
                        tooltip={
                            images
                                ? "Stop loading this file's images from the network and forget the approval"
                                : "Load this file's images from the network, which lets their servers see that the file was opened. Remembered for 7 days."
                        }
                        onClick={() => setImages(!images)}
                    >
                        <ImageIcon className="h-4 w-4" aria-hidden="true" />
                        Images
                    </ToggleButton>
                ) : null}
                <ToggleButton
                    pressed={scripts}
                    label="Enable JavaScript"
                    variant="subtle"
                    size="sm"
                    className="shrink-0 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300"
                    tooltip={
                        scripts
                            ? "Stop running the file's scripts and forget the approval"
                            : "Run the file's scripts. They stay isolated from redoor, but can still send data out, for example over WebRTC. Remembered for 7 days."
                    }
                    onClick={() => setScripts(!scripts)}
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
