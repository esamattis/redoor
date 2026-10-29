import {
    FoldVertical,
    Rows2,
    UnfoldVertical,
    WholeWord,
    WrapText,
} from "lucide-react";
import { SegmentedControl } from "#ui/components/segmented-control";
import { ToggleButton } from "#ui/components/toggle-button";

/**
 * Picks between inline changes and separate removed and added lines for one file's diff. It
 * sits in every diff card's header, so each file can be read the way its edits read best, and
 * shows only its icons so it fits beside the file's name.
 */
export function DiffLayoutSwitch(props: {
    label: string;
    inline: boolean;
    onChange: (inline: boolean) => void;
}) {
    return (
        <SegmentedControl
            label={props.label}
            iconOnly
            value={props.inline ? "inline" : "separate"}
            onChange={(value) => props.onChange(value === "inline")}
            options={[
                {
                    value: "inline",
                    label: "Inline changes",
                    icon: WholeWord,
                    tooltip:
                        "Inline changes: show an edited line as one row that marks the changed words",
                },
                {
                    value: "separate",
                    label: "Separate lines",
                    icon: Rows2,
                    tooltip:
                        "Separate lines: show every removed and added line as its own row",
                },
            ]}
        />
    );
}

/**
 * Switches one file's diff between wrapping and sideways-scrolling long lines, so only the
 * file with long lines has to wrap while the others keep their columns aligned. It is sized
 * to match the icon-only layout switch beside it in the card header.
 */
export function WrapDiffLinesToggle(props: {
    label: string;
    wrap: boolean;
    onChange: (wrap: boolean) => void;
}) {
    return (
        <ToggleButton
            label={props.label}
            pressed={props.wrap}
            tooltip={
                props.wrap
                    ? "Scroll long lines sideways instead of wrapping them"
                    : "Wrap long lines to fit the view"
            }
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => props.onChange(!props.wrap)}
        >
            <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
        </ToggleButton>
    );
}

/**
 * Switches one file's diff between its changes with a little context and the whole file with
 * the changes marked in it. It sits beside the file's name, since reading a file whole is a
 * choice for that file, and it never fetches, because the patch already carries the file.
 */
export function WholeFileToggle(props: {
    label: string;
    shown: boolean;
    onChange: (shown: boolean) => void;
}) {
    return (
        <ToggleButton
            label={props.label}
            pressed={props.shown}
            tooltip={
                props.shown
                    ? "Fold the unchanged lines around the changes again"
                    : "Show the whole file with its changes"
            }
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => props.onChange(!props.shown)}
        >
            {props.shown ? (
                <FoldVertical className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
                <UnfoldVertical className="h-3.5 w-3.5" aria-hidden="true" />
            )}
        </ToggleButton>
    );
}
