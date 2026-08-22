import * as React from "react";
import { Info } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { Tooltip } from "#ui/components/tooltip";

/** Groups native radios without replacing their browser keyboard and form semantics. */
export function RadioCardGroup(props: {
    legend: React.ReactNode;
    description?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    legendClassName?: string;
    optionsClassName?: string;
    children: React.ReactNode;
}) {
    return (
        <fieldset
            disabled={props.disabled}
            className={twMerge("grid gap-3", props.className)}
        >
            <legend className={props.legendClassName}>{props.legend}</legend>
            {props.description ? props.description : null}
            <div className={twMerge("grid gap-3", props.optionsClassName)}>
                {props.children}
            </div>
        </fieldset>
    );
}

/** Makes a native radio's label and help content read as one selectable card. */
export function RadioCardOption(props: {
    name: string;
    value: string;
    label: string;
    description: React.ReactNode;
    checked: boolean;
    disabled?: boolean;
    layout: "compact" | "descriptive";
    helpAriaLabel?: string;
    className?: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
}) {
    const inputId = React.useId();
    const inputRef = React.useRef<HTMLInputElement>(null);
    const cardClassName = twMerge(
        "cursor-pointer rounded-lg border px-4 py-3 transition has-[:disabled]:cursor-default",
        props.checked
            ? props.layout === "compact"
                ? "border-slate-400 bg-slate-900 text-slate-200"
                : "border-slate-400 bg-slate-900"
            : props.layout === "compact"
              ? "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-600 has-[:disabled]:hover:border-slate-700"
              : "border-slate-700 bg-slate-950/50 hover:border-slate-600 has-[:disabled]:hover:border-slate-700",
        props.className,
    );
    const input = (
        <input
            ref={inputRef}
            id={inputId}
            type="radio"
            name={props.name}
            value={props.value}
            checked={props.checked}
            disabled={props.disabled}
            onChange={props.onChange}
            className={twMerge(
                "h-4 w-4 accent-slate-100",
                props.layout === "descriptive" && "mt-0.5",
            )}
        />
    );

    /** Extends the native label target across compact card padding without capturing help interactions. */
    const selectFromCard = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (
            !(target instanceof Element) ||
            target.closest("label, [data-radio-card-help]") ||
            inputRef.current?.matches(":disabled")
        ) {
            return;
        }

        inputRef.current?.click();
    };

    if (props.layout === "compact") {
        return (
            <div
                onClick={selectFromCard}
                className={twMerge(
                    "flex items-center justify-between gap-3",
                    cardClassName,
                )}
            >
                <label
                    htmlFor={inputId}
                    className="flex min-w-0 cursor-inherit items-center gap-3 text-sm font-medium"
                >
                    {input}
                    {props.label}
                </label>
                <span data-radio-card-help className="inline-flex">
                    <Tooltip content={props.description}>
                        <Info
                            aria-label={
                                props.helpAriaLabel ?? `${props.label} help`
                            }
                            className="h-4 w-4 shrink-0 text-slate-400"
                        />
                    </Tooltip>
                </span>
            </div>
        );
    }

    return (
        <label className={twMerge("flex gap-3", cardClassName)}>
            {input}
            <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-100">
                    {props.label}
                </span>
                <span className="mt-1 block min-w-0 text-xs leading-5 text-slate-400">
                    {props.description}
                </span>
            </span>
        </label>
    );
}
