/**
 * Browsers, most specific first: Edge and Opera also send "Chrome", and Chrome also sends
 * "Safari", so the first match is the real one.
 */
const browsers: ReadonlyArray<[RegExp, string]> = [
    [/\bEdgA?\//, "Edge"],
    [/\bOPR\//, "Opera"],
    [/\b(Firefox|FxiOS)\//, "Firefox"],
    [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
    [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

/** Operating systems, most specific first: Android also sends "Linux". */
const systems: ReadonlyArray<[RegExp, string]> = [
    [/\bAndroid\b/, "Android"],
    [/\b(iPhone|iPad|iPod)\b/, "iOS"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bWindows\b/, "Windows"],
    [/\bLinux\b/, "Linux"],
];

/**
 * Names the browser and system of a `User-Agent` for the session list, e.g. "Firefox on
 * Linux", because the raw header is too long to recognise a device at a glance. Falls back
 * to the first product token, so a script such as curl is still named.
 */
export function describeUserAgent(userAgent: string | null): string {
    if (userAgent === null || userAgent.trim() === "") return "Unknown browser";

    const browser = browsers.find(([pattern]) => pattern.test(userAgent))?.[1];
    const system = systems.find(([pattern]) => pattern.test(userAgent))?.[1];

    if (browser && system) return `${browser} on ${system}`;

    if (browser) return browser;

    const product = userAgent.trim().split(/[\s/]/, 1)[0] ?? userAgent;

    return system ? `${product} on ${system}` : product;
}
