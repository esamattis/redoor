import React from "react";

/**
 * Keeps dialog action spacing and responsive ordering consistent without owning controls.
 */
export function DialogActions(props: {
    children: React.ReactNode;
    stackOnMobile?: boolean;
}) {
    return (
        <div
            className={
                props.stackOnMobile
                    ? "mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"
                    : "mt-6 flex justify-end gap-3"
            }
        >
            {props.children}
        </div>
    );
}
