import type { ITheme } from "ghostty-web";

/**
 * Dark matches the app canvas so the terminal does not reintroduce a cool cast.
 */
const darkTerminalTheme: ITheme = {
    background: "#0a0a0a",
    foreground: "#e5e5e5",
    cursor: "#f5f5f5",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#404040",
    selectionForeground: "#fafafa",
};

/**
 * Light uses darker ANSI colors because Ghostty's default palette is built
 * for dark backgrounds and would wash out on the app canvas.
 */
const lightTerminalTheme: ITheme = {
    background: "#ffffff",
    foreground: "#262626",
    cursor: "#171717",
    cursorAccent: "#ffffff",
    selectionBackground: "#d4d4d4",
    selectionForeground: "#0a0a0a",
    black: "#262626",
    red: "#b91c1c",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#1d4ed8",
    magenta: "#7e22ce",
    cyan: "#0e7490",
    white: "#737373",
    brightBlack: "#525252",
    brightRed: "#dc2626",
    brightGreen: "#16a34a",
    brightYellow: "#ca8a04",
    brightBlue: "#2563eb",
    brightMagenta: "#9333ea",
    brightCyan: "#0891b2",
    brightWhite: "#171717",
};

/** Picks the Ghostty palette that matches ThemeManager's resolved document theme. */
export function getTerminalTheme(mode: "dark" | "light"): ITheme {
    return mode === "light" ? lightTerminalTheme : darkTerminalTheme;
}
