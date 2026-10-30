import { atom } from "jotai";

/**
 * The theme ThemeManager resolved from the saved preference and the OS setting. Editors and
 * terminals that paint their own colours read it, so only ThemeManager resolves "system".
 * Dark until ThemeManager first applies the preference, matching the unstyled document.
 */
export const resolvedThemeAtom = atom<"dark" | "light">("dark");
