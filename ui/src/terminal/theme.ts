import type { ITheme } from "ghostty-web";

/**
 * Dark keeps the existing canvas colors so a theme-aware terminal does not
 * change the look operators already have in dark mode.
 */
const darkTerminalTheme: ITheme = {
    background: "#0b0d12",
    foreground: "#cbd5e1",
    cursor: "#60a5fa",
    cursorAccent: "#0b0d12",
    selectionBackground: "#334155",
    selectionForeground: "#f8fafc",
};

/**
 * Light uses darker ANSI colors because Ghostty's default palette is built
 * for dark backgrounds and would wash out on the app canvas.
 */
const lightTerminalTheme: ITheme = {
    background: "#f8fafc",
    foreground: "#334155",
    cursor: "#2563eb",
    cursorAccent: "#f8fafc",
    selectionBackground: "#cbd5e1",
    selectionForeground: "#0f172a",
    black: "#1e293b",
    red: "#b91c1c",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#1d4ed8",
    magenta: "#7e22ce",
    cyan: "#0e7490",
    white: "#64748b",
    brightBlack: "#475569",
    brightRed: "#dc2626",
    brightGreen: "#16a34a",
    brightYellow: "#ca8a04",
    brightBlue: "#2563eb",
    brightMagenta: "#9333ea",
    brightCyan: "#0891b2",
    brightWhite: "#0f172a",
};

/** Picks the Ghostty palette that matches ThemeManager's resolved document theme. */
export function getTerminalTheme(mode: "dark" | "light"): ITheme {
    return mode === "light" ? lightTerminalTheme : darkTerminalTheme;
}
