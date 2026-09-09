/** Names the CSS variables consumed by the wterm DOM renderer. */
export type TerminalTheme = Record<`--term-${string}`, string>;

/** Preserves the established dark terminal colors with an explicit ANSI palette. */
const darkTerminalTheme: TerminalTheme = {
    "--term-bg": "#0b0d12",
    "--term-fg": "#cbd5e1",
    "--term-cursor": "#60a5fa",
    "--term-selection-bg": "#334155",
    "--term-selection-fg": "#f8fafc",
    "--term-color-0": "#1e1e1e",
    "--term-color-1": "#f44747",
    "--term-color-2": "#6a9955",
    "--term-color-3": "#d7ba7d",
    "--term-color-4": "#569cd6",
    "--term-color-5": "#c586c0",
    "--term-color-6": "#4ec9b0",
    "--term-color-7": "#d4d4d4",
    "--term-color-8": "#808080",
    "--term-color-9": "#f44747",
    "--term-color-10": "#6a9955",
    "--term-color-11": "#d7ba7d",
    "--term-color-12": "#569cd6",
    "--term-color-13": "#c586c0",
    "--term-color-14": "#4ec9b0",
    "--term-color-15": "#ffffff",
};

/** Keeps ANSI output legible against the application light canvas. */
const lightTerminalTheme: TerminalTheme = {
    "--term-bg": "#f8fafc",
    "--term-fg": "#334155",
    "--term-cursor": "#2563eb",
    "--term-selection-bg": "#cbd5e1",
    "--term-selection-fg": "#0f172a",
    "--term-color-0": "#1e293b",
    "--term-color-1": "#b91c1c",
    "--term-color-2": "#15803d",
    "--term-color-3": "#a16207",
    "--term-color-4": "#1d4ed8",
    "--term-color-5": "#7e22ce",
    "--term-color-6": "#0e7490",
    "--term-color-7": "#64748b",
    "--term-color-8": "#475569",
    "--term-color-9": "#dc2626",
    "--term-color-10": "#16a34a",
    "--term-color-11": "#ca8a04",
    "--term-color-12": "#2563eb",
    "--term-color-13": "#9333ea",
    "--term-color-14": "#0891b2",
    "--term-color-15": "#0f172a",
};

/** Applies a resolved app theme without rebuilding the emulator or its socket. */
export function applyTerminalTheme(
    host: HTMLElement,
    mode: "dark" | "light",
): void {
    const theme = mode === "light" ? lightTerminalTheme : darkTerminalTheme;
    for (const [property, value] of Object.entries(theme)) {
        host.style.setProperty(property, value);
    }
}
