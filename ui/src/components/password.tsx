import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * Password field with an inline reveal toggle so users can verify what they typed
 * without leaving the form or relying on browser autofill previews.
 */
export function Password(props: {
    label: string;
    value: string;
    disabled?: boolean;
    autoComplete?: string;
    onChange: (value: string) => void;
}) {
    const inputId = React.useId();
    const [isVisible, setIsVisible] = React.useState(false);

    return (
        <div>
            <label
                htmlFor={inputId}
                className="block text-sm font-medium text-slate-300"
            >
                {props.label}
            </label>
            <div className="relative mt-2">
                <input
                    id={inputId}
                    type={isVisible ? "text" : "password"}
                    autoComplete={props.autoComplete}
                    value={props.value}
                    disabled={props.disabled}
                    onChange={(event) => props.onChange(event.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-[#0b0d12] py-2 pr-10 pl-3 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
                />
                <button
                    type="button"
                    aria-label={
                        isVisible ? "Hide characters" : "Show characters"
                    }
                    aria-pressed={isVisible}
                    disabled={props.disabled}
                    onClick={() => setIsVisible((visible) => !visible)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {isVisible ? (
                        <EyeOff className="h-4 w-4" />
                    ) : (
                        <Eye className="h-4 w-4" />
                    )}
                </button>
            </div>
        </div>
    );
}
