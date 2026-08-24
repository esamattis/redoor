import * as React from "react";
import { ChevronDown } from "lucide-react";
import { twMerge } from "tailwind-merge";

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
    containerClassName?: string;
};

/** Preserves native selection semantics while sharing control styling and disclosure affordance. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
    (props, ref) => {
        const selectProps: SelectProps = { ...props };
        delete selectProps.containerClassName;
        return (
            <span
                className={twMerge(
                    "relative inline-block",
                    props.containerClassName,
                )}
            >
                <select
                    {...selectProps}
                    ref={ref}
                    className={twMerge(
                        "w-full appearance-none rounded-md border border-slate-700 bg-[#0b0d12] py-2 pr-9 pl-3 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60",
                        props.className,
                    )}
                />
                <ChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-slate-400"
                />
            </span>
        );
    },
);

Select.displayName = "Select";
