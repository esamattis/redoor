import * as React from "react";

/** Lets the control that owns a chooser open it, since the input itself is not visible. */
export type FileInputHandle = {
    open: () => void;
};

/**
 * A visually hidden native file chooser, opened from a menu item or button. Keeping the raw
 * `<input type="file">` here means no feature reaches for one directly, the chooser always has
 * an accessible label, and its value is cleared after each pick so choosing the same file
 * again still fires a change.
 */
export function FileInput(props: {
    ref?: React.Ref<FileInputHandle>;
    label: string;
    /** Picks a whole directory instead of individual files. */
    directory?: boolean;
    onSelect: (files: File[]) => void;
}) {
    const { ref } = props;
    const inputId = React.useId();
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    React.useImperativeHandle(
        ref,
        () => ({ open: () => inputRef.current?.click() }),
        [],
    );

    return (
        <>
            <label htmlFor={inputId} className="sr-only">
                {props.label}
            </label>
            <input
                ref={(element) => {
                    inputRef.current = element;

                    if (props.directory === true) {
                        // React has no typed attribute for directory selection.
                        element?.setAttribute("webkitdirectory", "");
                    }
                }}
                id={inputId}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";

                    if (files.length > 0) {
                        props.onSelect(files);
                    }
                }}
            />
        </>
    );
}
