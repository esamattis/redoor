// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
    buildPreviewDocument,
    filePreviewKind,
    previewContentSecurityPolicy,
    previewSandboxTokens,
} from "./sandboxed-preview-document";

/** Parses a preview the way the frame does, so tests see what the browser would build. */
function parse(srcdoc: string) {
    return new DOMParser().parseFromString(srcdoc, "text/html");
}

/** The policy elements of a parsed preview, in document order. */
function policyMetas(document: Document) {
    return [
        ...document.querySelectorAll(
            'meta[http-equiv="Content-Security-Policy"]',
        ),
    ];
}

describe("filePreviewKind", () => {
    test("recognises the previewable formats by name", () => {
        // Each format needs its own renderer, so the kind must follow the extension.
        expect(filePreviewKind("README.md")).toBe("markdown");
        expect(filePreviewKind("index.html")).toBe("html");
        expect(filePreviewKind("legacy.HTM")).toBe("html");
        expect(filePreviewKind("/icons/logo.svg")).toBe("svg");
        // Encrypted files preview like the file they hold.
        expect(filePreviewKind("page.html.redoorencrypted")).toBe("html");
        expect(filePreviewKind("logo.svg.redoorencrypted")).toBe("svg");
    });

    test("leaves other files in the editor", () => {
        // Plain XML shares SVG's highlighting but has nothing to render.
        expect(filePreviewKind("pom.xml")).toBeNull();
        expect(filePreviewKind("notes.txt")).toBeNull();
        expect(filePreviewKind("svg")).toBeNull();
    });
});

describe("previewSandboxTokens", () => {
    test("never grants the redoor origin or escapes from the frame", () => {
        for (const scripts of [false, true]) {
            const tokens = previewSandboxTokens(scripts).split(/\s+/);

            // The same origin would give scripts the session cookie and the authenticated API.
            expect(tokens).not.toContain("allow-same-origin");

            // The document must not leave the frame, open windows, submit forms or block the UI.
            for (const token of [
                "allow-top-navigation",
                "allow-top-navigation-by-user-activation",
                "allow-popups",
                "allow-forms",
                "allow-modals",
            ]) {
                expect(tokens).not.toContain(token);
            }
        }
    });

    test("allows scripts only when enabled", () => {
        // An empty sandbox applies every restriction, which is the default.
        expect(previewSandboxTokens(false)).toBe("");
        expect(previewSandboxTokens(true)).toBe("allow-scripts");
    });
});

describe("previewContentSecurityPolicy", () => {
    test("blocks the network in every mode", () => {
        for (const scripts of [false, true]) {
            const policy = previewContentSecurityPolicy(scripts);

            // Everything not listed falls back to none, which covers fetches, frames and workers.
            expect(policy).toContain("default-src 'none'");
            // Only embedded data can be loaded, never a URL on a server.
            expect(policy).not.toMatch(/https?:|\*|'self'/);
            expect(policy).not.toContain("connect-src");
        }
    });

    test("allows inline scripts only when enabled", () => {
        // Without the opt-in the default policy also refuses scripts.
        expect(previewContentSecurityPolicy(false)).not.toContain("script-src");
        expect(previewContentSecurityPolicy(true)).toContain(
            "script-src 'unsafe-inline'",
        );
        // Evaluating strings is never needed for a preview.
        expect(previewContentSecurityPolicy(true)).not.toContain("unsafe-eval");
    });
});

describe("buildPreviewDocument", () => {
    test("puts the policy in front of all HTML content", () => {
        const srcdoc = buildPreviewDocument({
            kind: "html",
            content: `<script>document.title = "ran"</script><p>Hello</p>`,
            scripts: false,
        });

        // A meta policy only applies to what follows it, so nothing of the file may precede it.
        expect(
            srcdoc.startsWith('<meta http-equiv="Content-Security-Policy"'),
        ).toBe(true);

        const document = parse(srcdoc);
        const metas = policyMetas(document);

        // The parser has to place the policy first in the head, where browsers honour it.
        expect(document.head.firstElementChild).toBe(metas[0]);
        expect(metas[0]?.getAttribute("content")).toBe(
            previewContentSecurityPolicy(false),
        );
    });

    test("keeps the policy first when the page has its own head", () => {
        const document = parse(
            buildPreviewDocument({
                kind: "html",
                content: `<!DOCTYPE html>
<html lang="en">
<head><meta http-equiv="Content-Security-Policy" content="script-src *"><title>Page</title></head>
<body><p>Hello</p></body>
</html>`,
                scripts: true,
            }),
        );

        // The page's doctype must survive so it renders in standards mode, not quirks mode.
        expect(document.compatMode).toBe("CSS1Compat");
        // The page's html and head merge into the ones the policy opened.
        expect(document.documentElement.getAttribute("lang")).toBe("en");
        expect(document.title).toBe("Page");
        // A policy of the page itself can only add restrictions after ours, never come before it.
        expect(document.head.firstElementChild).toBe(policyMetas(document)[0]);
        expect(policyMetas(document)[0]?.getAttribute("content")).toBe(
            previewContentSecurityPolicy(true),
        );
    });

    test("does not let a fake doctype smuggle markup before the policy", () => {
        const srcdoc = buildPreviewDocument({
            kind: "html",
            content: `<!DOCTYPE html "><script>alert(1)</script>"><p>Hi</p>`,
            scripts: false,
        });

        // The doctype ends at its first angle bracket, as the browser's tokenizer ends it.
        expect(srcdoc.startsWith('<!DOCTYPE html "><meta')).toBe(true);
        const document = parse(srcdoc);
        expect(document.head.firstElementChild).toBe(policyMetas(document)[0]);
    });

    test("shows SVG through an image without scripts", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert("x")</script><text>"&<></text></svg>`;

        const document = parse(
            buildPreviewDocument({ kind: "svg", content: svg, scripts: false }),
        );

        // An image never runs SVG scripts, so the drawing must not be in the page as markup.
        expect(document.querySelector("svg")).toBeNull();
        expect(document.querySelector("script")).toBeNull();

        const image = document.querySelector("img");
        const source = image?.getAttribute("src") ?? "";
        const prefix = "data:image/svg+xml;charset=utf-8,";

        // The whole drawing travels in the data URL, unchanged by the attribute it sits in.
        expect(source.startsWith(prefix)).toBe(true);
        expect(decodeURIComponent(source.slice(prefix.length))).toBe(svg);
        // The policy still comes first and allows the data URL the image loads.
        expect(document.head.firstElementChild).toBe(policyMetas(document)[0]);
        expect(previewContentSecurityPolicy(false)).toContain("img-src data:");
    });

    test("inlines SVG so its scripts can run when enabled", () => {
        const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "ran"</script></svg>`;

        const document = parse(
            buildPreviewDocument({ kind: "svg", content: svg, scripts: true }),
        );

        // Scripts in an SVG only run when its markup is part of the page.
        expect(document.querySelector("body > svg script")).not.toBeNull();
        expect(document.querySelector("img")).toBeNull();
        // The policy precedes the drawing and allows exactly the inline scripts.
        expect(document.head.firstElementChild).toBe(policyMetas(document)[0]);
        expect(policyMetas(document)[0]?.getAttribute("content")).toBe(
            previewContentSecurityPolicy(true),
        );
    });
});
