import { z } from "zod";
// The self-contained build defines a global and loads nothing else, so a frame without
// module or network access can run it from one script tag.
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url";

/** The Mermaid themes that match redoor's light and dark appearance. */
export type MermaidTheme = "light" | "dark";

/** A diagram drawn by the renderer frame, ready to show as an image. */
export type RenderedMermaidDiagram = {
    svg: string;
    /** The drawing's natural size, so the image can scale down without guessing a box. */
    width: number;
    height: number;
    /** The diagram's `accTitle`, which describes it better than a generic alt text. */
    title: string | null;
};

/**
 * Runs inside the renderer frame. Requests and drawings travel over the port the parent
 * hands over once Mermaid is ready, so only this document ever receives diagram sources.
 * It renders one request at a time, because Mermaid's
 * configuration is global and a theme set for one diagram must not leak into another. The
 * drawing is reparsed and serialized as XML so it is valid inside a `data:` image, and its
 * size is read from the viewBox, since Mermaid sizes the root to its container instead.
 */
const FRAME_BOOTSTRAP = `
const post = (message) => parent.postMessage(message, "*");

if (typeof mermaid === "undefined") {
    post({ type: "failed" });
} else {
    let queue = Promise.resolve();
    let count = 0;
    let port = null;

    const draw = async (request) => {
        try {
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                theme: request.theme === "dark" ? "dark" : "default",
                suppressErrorRendering: true,
            });
            count += 1;
            const result = await mermaid.render("diagram-" + count, request.source);
            const host = document.createElement("div");
            host.innerHTML = result.svg;
            const root = host.querySelector("svg");

            if (root === null) {
                throw new Error("Mermaid produced no drawing");
            }

            const box = root.viewBox.baseVal;
            const width = Math.ceil(box === null ? 0 : box.width);
            const height = Math.ceil(box === null ? 0 : box.height);
            root.setAttribute("width", String(width));
            root.setAttribute("height", String(height));
            root.style.removeProperty("max-width");
            const title = root.querySelector(":scope > title");

            port.postMessage({
                type: "rendered",
                id: request.id,
                svg: new XMLSerializer().serializeToString(root),
                width,
                height,
                title: title === null ? null : title.textContent,
            });
        } catch (error) {
            port.postMessage({
                type: "error",
                id: request.id,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    addEventListener("message", (event) => {
        if (
            port !== null ||
            event.source !== parent ||
            event.data?.type !== "connect" ||
            event.ports.length !== 1
        ) {
            return;
        }

        port = event.ports[0];
        port.onmessage = (message) => {
            queue = queue.then(() => draw(message.data));
        };
    });

    post({ type: "ready" });
}
`;

/**
 * The policy of the renderer frame. Only the two scripts carrying the nonce run, so markup
 * that slips through Mermaid's sanitizer cannot run inline handlers, and nothing may load
 * from the network or redoor. CSP does not cover navigation or WebRTC; see `MermaidRenderer`.
 */
export function mermaidFrameContentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        // Mermaid puts each drawing's theme in a style element inside the SVG.
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "form-action 'none'",
        "base-uri 'none'",
    ].join("; ");
}

/**
 * Builds the renderer frame's document. The diagram sources never appear in it; they arrive
 * by message, so a source cannot end a script or inject markup into the page around Mermaid.
 */
export function mermaidFrameDocument(options: {
    nonce: string;
    scriptUrl: string;
}): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${mermaidFrameContentSecurityPolicy(options.nonce)}">
</head>
<body>
<script nonce="${options.nonce}" src="${options.scriptUrl}"></script>
<script nonce="${options.nonce}">${FRAME_BOOTSTRAP}</script>
</body>
</html>`;
}

/**
 * What the renderer frame may say. It is checked because a compromised frame could send
 * anything. The frame announces itself on the window; drawings arrive on its port.
 */
const frameStatusSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("failed") }),
]);

const renderReplySchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("rendered"),
        id: z.number(),
        svg: z.string(),
        width: z.number(),
        height: z.number(),
        title: z.string().nullable(),
    }),
    z.object({ type: z.literal("error"), id: z.number(), message: z.string() }),
]);

/** A render request waiting for the frame's answer. */
type PendingRender = {
    resolve: (diagram: RenderedMermaidDiagram) => void;
    reject: (error: Error) => void;
};

/** A started renderer frame and the promise of its port being ready for requests. */
type RendererFrame = {
    element: HTMLIFrameElement;
    ready: Promise<MessagePort>;
    /** The private channel to the frame's own document, once Mermaid has loaded in it. */
    port: MessagePort | null;
    /** Settles `ready`, kept so the frame's messages can resolve its start. */
    resolveReady: (port: MessagePort) => void;
    rejectReady: (error: Error) => void;
    /** The window listener for this frame's announcements, removed when the frame is dropped. */
    onMessage: (event: MessageEvent) => void;
};

/**
 * Draws Mermaid diagrams of markdown previews, the way GitHub does: in a sandboxed frame
 * with an opaque origin, because the diagram text is untrusted and Mermaid has had
 * sanitizer bypasses. The drawings come back as SVG text that the preview shows as images,
 * which never run scripts or load anything. One hidden frame serves the whole app and is
 * only started by the first diagram, so the large Mermaid bundle loads only when needed.
 *
 * The sandbox cannot stop the frame from navigating itself, which CSP does not cover
 * either. Sources therefore go over a `MessagePort` that only the original document holds,
 * and a frame that loads anything after it is dropped, so a page it navigated to never
 * receives a diagram. WebRTC is also outside CSP, so a renderer compromised by one diagram
 * could still leak the sources it is later given; that needs a Mermaid sanitizer bypass.
 */
export class MermaidRenderer {
    #frame: RendererFrame | null = null;
    #pending = new Map<number, PendingRender>();
    #nextId = 0;

    /** Renders one diagram source, rejecting with Mermaid's message when it does not parse. */
    async render(options: {
        source: string;
        theme: MermaidTheme;
    }): Promise<RenderedMermaidDiagram> {
        const port = await this.#startFrame().ready;
        this.#nextId += 1;
        const id = this.#nextId;

        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            port.postMessage({
                type: "render",
                id,
                source: options.source,
                theme: options.theme,
            });
        });
    }

    /** Starts the frame once and reuses it, since loading Mermaid takes a while. */
    #startFrame(): RendererFrame {
        if (this.#frame !== null) {
            return this.#frame;
        }

        const element = document.createElement("iframe");
        const nonce = randomNonce();
        element.sandbox.add("allow-scripts");
        element.title = "Mermaid renderer";
        element.ariaHidden = "true";
        element.tabIndex = -1;
        // Mermaid measures text while drawing, so the frame needs a real layout, just off screen.
        element.style.cssText =
            "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;";
        element.srcdoc = mermaidFrameDocument({
            nonce,
            scriptUrl: new URL(mermaidScriptUrl, window.location.href).href,
        });

        let resolveReady: (port: MessagePort) => void = () => {};

        let rejectReady: (error: Error) => void = () => {};

        const ready = new Promise<MessagePort>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        const frame: RendererFrame = {
            element,
            ready,
            port: null,
            resolveReady,
            rejectReady,
            onMessage: (event) => {
                this.#handleStatus(frame, event);
            },
        };

        let loads = 0;

        // The first load is the renderer itself; any later one means the frame navigated away.
        element.addEventListener("load", () => {
            loads += 1;

            if (loads > 1) {
                this.#dropFrame(frame, "The Mermaid renderer navigated away");
            }
        });

        window.addEventListener("message", frame.onMessage);
        this.#frame = frame;
        document.body.append(element);

        return frame;
    }

    /** Connects the frame once Mermaid loaded in it, or drops it when Mermaid did not. */
    #handleStatus(frame: RendererFrame, event: MessageEvent) {
        const frameWindow = frame.element.contentWindow;

        if (frameWindow === null || event.source !== frameWindow) {
            return;
        }

        const parsed = frameStatusSchema.safeParse(event.data);

        if (!parsed.success) {
            return;
        }

        if (parsed.data.type === "failed") {
            this.#dropFrame(frame, "The Mermaid renderer did not load");

            return;
        }

        if (frame.port !== null) {
            return;
        }

        const channel = new MessageChannel();
        frame.port = channel.port1;
        channel.port1.onmessage = (reply) => this.#handleReply(reply);
        // The frame's origin is opaque, so no target origin other than `*` reaches it. Only
        // this one message goes to the window; everything after it uses the port.
        frameWindow.postMessage({ type: "connect" }, "*", [channel.port2]);
        frame.resolveReady(channel.port1);
    }

    /** Settles the request a drawing or error from the frame answers. */
    #handleReply(event: MessageEvent) {
        const parsed = renderReplySchema.safeParse(event.data);

        if (!parsed.success) {
            return;
        }

        const message = parsed.data;
        const pending = this.#pending.get(message.id);

        if (pending === undefined) {
            return;
        }

        this.#pending.delete(message.id);

        if (message.type === "error") {
            pending.reject(new Error(message.message));

            return;
        }

        pending.resolve({
            svg: message.svg,
            width: message.width,
            height: message.height,
            title: message.title,
        });
    }

    /**
     * Removes a frame that failed or navigated and fails what waited on it. A later diagram
     * starts a fresh frame, so a passing network hiccup does not stick.
     */
    #dropFrame(frame: RendererFrame, reason: string) {
        if (this.#frame !== frame) {
            return;
        }

        const error = new Error(reason);
        window.removeEventListener("message", frame.onMessage);
        frame.port?.close();
        frame.element.remove();
        frame.rejectReady(error);
        this.#frame = null;

        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();
    }
}

/** A fresh nonce per frame, so nothing written into a page ahead of time can carry it. */
function randomNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}
