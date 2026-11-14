import * as React from "react";
import { X } from "lucide-react";

import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";

/**
 * Gives filter-style inputs a one-click reset, because clearing a short query by selecting
 * and deleting it is slow on touch screens. The clear button only appears when there is
 * something to clear, and it returns focus to the input so typing can continue.
 */
export function ClearableInput(props: {
    /** Names the input for assistive technology since filter fields have no visible label. */
    label: string;
    /** Names the clear action; it defaults to a generic phrase when one is enough. */
    clearLabel?: string;
    value: string;
    placeholder: string;
    className?: string;
    onChange: (value: string) => void;
}) {
    const inputRef = React.useRef<HTMLInputElement>(null);

    return (
        <div className={props.className}>
            {/* The inner flex box matches the input exactly, so caller padding and the inline
                input's baseline gap cannot shift the clear button off center. */}
            <div className="relative flex items-center">
                <InputControl
                    ref={inputRef}
                    type="text"
                    aria-label={props.label}
                    value={props.value}
                    placeholder={props.placeholder}
                    codeMode
                    onChange={(event) => props.onChange(event.target.value)}
                    className="w-full py-1.5 pr-8 text-sm placeholder:text-slate-600"
                />
                {props.value !== "" ? (
                    <IconButton
                        type="button"
                        label={props.clearLabel ?? "Clear"}
                        onClick={() => {
                            props.onChange("");
                            inputRef.current?.focus();
                        }}
                        variant="quiet"
                        size="xs"
                        // The tooltip wraps the button, so the wrapper is what must be positioned.
                        tooltipClassName="absolute right-1"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </IconButton>
                ) : null}
            </div>
        </div>
    );
}
