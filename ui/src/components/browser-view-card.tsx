import React from "react";

/** Keeps full-width browser views on one consistent panel surface. */
export function BrowserViewCard(props: { children: React.ReactNode }) {
    return (
        <article className="w-full min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
            {props.children}
        </article>
    );
}
