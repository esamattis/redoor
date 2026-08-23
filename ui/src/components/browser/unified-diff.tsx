import React from "react";
import { html as renderDiffHtml } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import "diff2html/bundles/css/diff2html.min.css";

/** Turns trusted server-generated unified diff text into the shared accessible table. */
export function UnifiedDiff(props: {
    unifiedDiff: string;
    emptyMessage?: string;
}) {
    const rendered = React.useMemo(
        () =>
            renderDiffHtml(props.unifiedDiff, {
                drawFileList: false,
                matching: "lines",
                outputFormat: "line-by-line",
                colorScheme: ColorSchemeType.AUTO,
            }),
        [props.unifiedDiff],
    );

    if (props.unifiedDiff === "") {
        return (
            <p className="text-sm text-slate-400">
                {props.emptyMessage ?? "The files are identical."}
            </p>
        );
    }

    return (
        <div
            className="file-diff-html min-w-max"
            dangerouslySetInnerHTML={{ __html: rendered }}
        />
    );
}
