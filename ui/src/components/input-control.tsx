import * as React from "react";
import { twMerge } from "tailwind-merge";

/**
 * Provides the shared visual baseline without obscuring native input behavior or attributes.
 */
export const InputControl = React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
>((props, ref) => (
    <input
        {...props}
        ref={ref}
        className={twMerge(
            "rounded-md border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20",
            props.className,
        )}
    />
));

InputControl.displayName = "InputControl";
