import React from "react";

/**
 * Owns the details/sync panel chrome so those views cannot drift in width or surface.
 */
export function DetailCard(props: { children: React.ReactNode }) {
    return (
        <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]">
            {props.children}
        </article>
    );
}
