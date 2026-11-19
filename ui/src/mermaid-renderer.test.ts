import { expect, test } from "vitest";
import {
    mermaidFrameContentSecurityPolicy,
    mermaidFrameDocument,
} from "./mermaid-renderer";

test("only the frame's own nonce-carrying scripts may run", () => {
    const policy = mermaidFrameContentSecurityPolicy("abc123");

    // A nonce instead of 'unsafe-inline' keeps inline handlers in a drawing from running.
    expect(policy).toContain("script-src 'nonce-abc123'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    // Resource types without their own directive fall back to 'none', so they are all denied.
    expect(policy).toContain("default-src 'none'");
});

test("puts the policy before the scripts and keeps diagram sources out", () => {
    const document = mermaidFrameDocument({
        nonce: "abc123",
        scriptUrl: "https://redoor.test/assets/mermaid.min-hash.js",
    });

    // A meta policy only covers what the parser meets after it, so it must precede the scripts.
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
        document.indexOf("<script"),
    );
    // Both scripts carry the nonce, otherwise the policy would block Mermaid or its bootstrap.
    expect(document).toContain(
        '<script nonce="abc123" src="https://redoor.test/assets/mermaid.min-hash.js"></script>',
    );
    expect(document.match(/<script nonce="abc123"/g)).toHaveLength(2);
});
