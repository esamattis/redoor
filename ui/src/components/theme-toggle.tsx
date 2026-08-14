import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Tooltip } from "#ui/components/tooltip";
import { useUserState } from "#ui/user-state";

const themeOptions = [
    { value: "system", label: "System", icon: Monitor },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "light", label: "Light", icon: Sun },
] as const;

/** Applies the saved preference while keeping the system option responsive to OS changes. */
export function ThemeManager() {
    const [userState] = useUserState();

    React.useLayoutEffect(() => {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

        /** Updates browser chrome and the root selector from one resolved theme. */
        const applyTheme = () => {
            const resolvedTheme =
                userState.theme === "system"
                    ? mediaQuery.matches
                        ? "dark"
                        : "light"
                    : userState.theme;
            const root = document.documentElement;
            root.classList.toggle("dark", resolvedTheme === "dark");
            root.classList.toggle("light", resolvedTheme === "light");
            root.dataset.theme = resolvedTheme;
            document
                .querySelector('meta[name="theme-color"]')
                ?.setAttribute(
                    "content",
                    resolvedTheme === "dark" ? "#0b0d12" : "#f8fafc",
                );
        };

        applyTheme();
        mediaQuery.addEventListener("change", applyTheme);
        return () => mediaQuery.removeEventListener("change", applyTheme);
    }, [userState.theme]);

    return null;
}

/** Cycles theme preferences from one compact control at the edge of the app chrome. */
export function ThemeToggle() {
    const [userState, setUserState] = useUserState();
    const selectedIndex = Math.max(
        0,
        themeOptions.findIndex((option) => option.value === userState.theme),
    );
    const selectedOption = themeOptions[selectedIndex] ?? themeOptions[0];
    const nextOption =
        themeOptions[(selectedIndex + 1) % themeOptions.length] ??
        themeOptions[0];
    const SelectedIcon = selectedOption.icon;

    /** Advances and persists the preference in the order shown to the user. */
    const toggleTheme = () => {
        setUserState((current) => ({
            ...current,
            theme: nextOption.value,
        }));
    };

    return (
        <Tooltip content={`Click to ${nextOption.label.toLowerCase()} theme`}>
            <button
                type="button"
                aria-label={`Color theme: ${selectedOption.label}`}
                onClick={toggleTheme}
                className="inline-flex items-center rounded-md p-2 text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
            >
                <SelectedIcon className="h-4 w-4" aria-hidden="true" />
            </button>
        </Tooltip>
    );
}
