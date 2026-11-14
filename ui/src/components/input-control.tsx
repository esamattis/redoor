import * as React from "react";
import { cn } from "#ui/utils/cn";

/**
 * Provides the shared visual baseline without obscuring native input behavior or attributes.
 * `ref` is an ordinary prop in React 19, so the input receives it through the spread.
 */
export function InputControl(
    props: React.ComponentPropsWithRef<"input"> & {
        /**
         * Takes literal text such as a path, file name or query. Phone keyboards would
         * otherwise capitalize, autocorrect or spell check it and silently break the match.
         */
        codeMode?: boolean;
    },
) {
    // codeMode is not a DOM attribute, so it must not reach the input element.
    const inputProps = { ...props };
    delete inputProps.codeMode;

    /** Applies a code mode default unless the caller set the attribute itself. */
    const codeDefault = <T,>(value: T | undefined, fallback: T) =>
        value ?? (props.codeMode === true ? fallback : undefined);

    return (
        <input
            {...inputProps}
            // Wrappers such as TextField forward unset attributes as undefined, so the
            // defaults are resolved per attribute instead of spread before the props.
            autoCapitalize={codeDefault(props.autoCapitalize, "off")}
            autoCorrect={codeDefault(props.autoCorrect, "off")}
            autoComplete={codeDefault(props.autoComplete, "off")}
            spellCheck={codeDefault(props.spellCheck, false)}
            // The URL keyboard puts "/" and "." on the main layer, which paths and file
            // names need, and keyboards treat it as literal text.
            inputMode={codeDefault(props.inputMode, "url")}
            className={cn(
                "rounded-md border border-slate-700 bg-canvas px-3 py-2 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20",
                props.className,
            )}
        />
    );
}
