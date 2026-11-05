import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { InputControl } from "#ui/components/input-control";
import { Tooltip } from "#ui/components/tooltip";

/**
 * Password field with an inline reveal toggle so users can verify what they typed
 * without leaving the form or relying on browser autofill previews.
 */
export function Password(props: {
    label: string;
    value: string;
    disabled?: boolean;
    autoComplete?: string;
    placeholder?: string;
    description?: string;
    required?: boolean;
    className?: string;
    /**
     * Keeps 1Password from offering to save the value. Set it on passwords that are used
     * once and never stored: the save prompt is pointless there, and it cannot be dismissed
     * while a modal dialog such as the vault unlock makes the rest of the page inert.
     */
    ignoreIn1Password?: boolean;
    onChange: (value: string) => void;
}) {
    const inputId = React.useId();
    const descriptionId = React.useId();
    const [isVisible, setIsVisible] = React.useState(false);
    const toggleLabel = isVisible ? "Hide characters" : "Show characters";

    return (
        <div className={props.className}>
            <div className="flex items-baseline justify-between gap-3">
                <label
                    htmlFor={inputId}
                    className="text-sm font-medium text-slate-300"
                >
                    {props.label}
                </label>
                {props.required !== undefined ? (
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        {props.required ? "Required" : "Optional"}
                    </span>
                ) : null}
            </div>
            <div className="relative mt-2">
                <InputControl
                    id={inputId}
                    type={isVisible ? "text" : "password"}
                    autoComplete={props.autoComplete}
                    data-1p-ignore={props.ignoreIn1Password || undefined}
                    value={props.value}
                    placeholder={props.placeholder}
                    required={props.required}
                    aria-required={props.required || undefined}
                    aria-describedby={
                        props.description ? descriptionId : undefined
                    }
                    disabled={props.disabled}
                    onChange={(event) => props.onChange(event.target.value)}
                    className="w-full pr-10 placeholder:text-slate-600 disabled:opacity-60"
                />
                <Tooltip
                    content={toggleLabel}
                    className="absolute inset-y-0 right-0"
                >
                    <button
                        type="button"
                        aria-label={toggleLabel}
                        aria-pressed={isVisible}
                        disabled={props.disabled}
                        onClick={() => setIsVisible((visible) => !visible)}
                        className="flex h-full items-center px-3 text-slate-400 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isVisible ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </Tooltip>
            </div>
            {props.description ? (
                <p id={descriptionId} className="mt-1.5 text-xs text-slate-500">
                    {props.description}
                </p>
            ) : null}
        </div>
    );
}
