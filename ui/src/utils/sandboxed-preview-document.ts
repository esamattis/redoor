import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import { stripVaultSuffix } from "#ui/vault/vault-path";

/**
 * The representations the editor can swap its source for. Markdown is rendered by React,
 * while HTML and SVG are documents the browser itself has to render, so those two go through
 * the sandboxed frame instead.
 */
export type FilePreviewKind = "markdown" | "html" | "svg";

/** The preview kinds whose content runs as a document in the sandboxed frame. */
export type SandboxedPreviewKind = Exclude<FilePreviewKind, "markdown">;

/**
 * Picks the preview a file gets from its name, the same way the editor picks its language,
 * so an encrypted `page.html.redoorencrypted` previews like the page it holds. SVG shares
 * the XML highlighting with other XML files, so it is recognised by its extension.
 */
export function filePreviewKind(fileName: string): FilePreviewKind | null {
    const language = syntaxLanguageFromFileName(fileName);

    if (language === "markdown" || language === "html") {
        return language;
    }

    const baseName = stripVaultSuffix(fileName.split("/").pop() ?? fileName);

    return baseName.toLowerCase().endsWith(".svg") ? "svg" : null;
}

/**
 * The sandbox tokens of the preview frame. `allow-same-origin` is never among them: without
 * it the document gets an opaque origin, so even with scripts on it cannot reach the parent
 * page, its cookies or storage, or the authenticated API. Top navigation, popups, forms and
 * modals stay blocked in every mode, and scripts only run when the reader opted in.
 */
export function previewSandboxTokens(scripts: boolean): string {
    return scripts ? "allow-scripts" : "";
}

/**
 * The policy injected into every previewed document. Everything defaults to `'none'`, so
 * nothing in the file can load from the network or the redoor server (no fetches, frames,
 * workers, external styles, images or fonts), while inline styles and embedded `data:`
 * resources still render. Inline scripts are only allowed when the reader enabled them, and
 * `eval` never is.
 */
export function previewContentSecurityPolicy(scripts: boolean): string {
    const directives = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data:",
        "form-action 'none'",
        "base-uri 'none'",
    ];

    if (scripts) {
        directives.push("script-src 'unsafe-inline'");
    }

    return directives.join("; ");
}

/**
 * A meta policy only governs what the parser meets after it, so it has to be the first
 * element of the document. The policy text contains no double quotes, so it cannot end the
 * attribute early.
 */
function contentSecurityPolicyMeta(scripts: boolean) {
    return `<meta http-equiv="Content-Security-Policy" content="${previewContentSecurityPolicy(scripts)}">`;
}

/**
 * A doctype the file starts with. It must stay in front of the policy, because a doctype
 * after any element is ignored and the page would render in quirks mode. The tokenizer ends
 * a doctype at its first `>` even inside quotes, so this match ends exactly where the
 * browser's does and no markup of the file can come before the policy.
 */
const LEADING_DOCTYPE = /^﻿?\s*(<!doctype[^>]*>)/i;

/**
 * Centres an SVG in the frame and scales it down to fit, since a drawing has no page layout
 * of its own and may be far larger than a phone-narrow column.
 */
const SVG_FRAME_STYLE = `<style>
html, body { height: 100%; margin: 0; }
body { display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 16px; }
body > img, body > svg { max-width: 100%; max-height: 100%; }
body > img { object-fit: contain; }
</style>`;

/** Puts the policy in front of an HTML page while keeping its doctype first. */
function htmlPreviewDocument(content: string, scripts: boolean) {
    const doctype = LEADING_DOCTYPE.exec(content);
    const meta = contentSecurityPolicyMeta(scripts);

    if (doctype === null) {
        return `${meta}${content}`;
    }

    return `${doctype[1]}${meta}${content.slice(doctype[0].length)}`;
}

/**
 * Without scripts the drawing is shown through an image, where browsers never run SVG
 * scripts or load anything it references, so the policy is a second fence there. With
 * scripts the markup is inlined into the page instead, because that is the only way its
 * scripts can run; the sandbox and the policy then are what contain it.
 */
function svgPreviewDocument(content: string, scripts: boolean) {
    const head = `<!DOCTYPE html>${contentSecurityPolicyMeta(scripts)}${SVG_FRAME_STYLE}`;

    if (scripts) {
        return `${head}${content}`;
    }

    // encodeURIComponent escapes quotes and angle brackets, so the drawing cannot leave the attribute.
    return `${head}<img alt="SVG drawing" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}">`;
}

/**
 * Builds the `srcdoc` of the preview frame from the editor's text. The text is untrusted, so
 * it never reaches the frame without the network-blocking policy in front of it.
 */
export function buildPreviewDocument(options: {
    kind: SandboxedPreviewKind;
    content: string;
    scripts: boolean;
}): string {
    return options.kind === "svg"
        ? svgPreviewDocument(options.content, options.scripts)
        : htmlPreviewDocument(options.content, options.scripts);
}
