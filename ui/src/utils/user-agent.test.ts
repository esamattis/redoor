import { describe, expect, it } from "vitest";

import { describeUserAgent } from "#ui/utils/user-agent";

describe("describeUserAgent", () => {
    it("names common browsers and their systems", () => {
        // Chrome sends "Safari" too, so the more specific browser must win.
        expect(
            describeUserAgent(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            ),
        ).toBe("Chrome on Linux");
        // Android sends "Linux" too, so the more specific system must win.
        expect(
            describeUserAgent(
                "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
            ),
        ).toBe("Firefox on Android");
        // Safari is recognised only by its Version token, which Chrome does not send.
        expect(
            describeUserAgent(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
            ),
        ).toBe("Safari on iOS");
        // Edge sends "Chrome" too, so it must be named by its own token.
        expect(
            describeUserAgent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
            ),
        ).toBe("Edge on Windows");
    });

    it("falls back to the product token and a placeholder", () => {
        // Scripts are still named, so an unexpected client stands out in the list.
        expect(describeUserAgent("curl/8.5.0")).toBe("curl");
        // A client without the header is shown as unknown rather than blank.
        expect(describeUserAgent(null)).toBe("Unknown browser");
    });
});
