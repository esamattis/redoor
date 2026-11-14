import * as React from "react";
import { InputControl } from "#ui/components/input-control";

/** Keeps form controls visually and accessibly consistent without hiding labels. */
export function TextField(props: {
    label: string;
    /** Overrides the accessible name when the visible label is only a short prompt. */
    ariaLabel?: string;
    /** Lets a caller place the caret, such as selecting a filename's stem on open. */
    inputRef?: React.Ref<HTMLInputElement>;
    value: string;
    placeholder: string;
    description: string;
    required?: boolean;
    autoFocus?: boolean;
    autoComplete?: string;
    /** Passes through to the input for literal text such as paths and file names. */
    codeMode?: boolean;
    type?: React.HTMLInputTypeAttribute;
    min?: number;
    max?: number;
    className?: string;
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    const inputId = React.useId();
    const descriptionId = React.useId();

    return (
        <div className={props.className}>
            <div className="flex items-baseline justify-between gap-3">
                <label
                    htmlFor={inputId}
                    className="text-sm font-medium text-slate-300"
                >
                    {props.label}
                </label>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {props.required ? "Required" : "Optional"}
                </span>
            </div>
            <InputControl
                ref={props.inputRef}
                id={inputId}
                aria-label={props.ariaLabel}
                value={props.value}
                placeholder={props.placeholder}
                required={props.required}
                aria-required={props.required || undefined}
                aria-describedby={descriptionId}
                autoFocus={props.autoFocus}
                codeMode={props.codeMode}
                autoComplete={props.autoComplete}
                type={props.type}
                min={props.min}
                max={props.max}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.value)}
                className="mt-2 w-full placeholder:text-slate-600 disabled:opacity-60"
            />
            <p id={descriptionId} className="mt-1.5 text-xs text-slate-500">
                {props.description}
            </p>
        </div>
    );
}
