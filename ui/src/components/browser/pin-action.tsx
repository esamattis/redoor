import * as React from "react";
import { Pin } from "lucide-react";

import { Button } from "#ui/components/button";
import { Tooltip } from "#ui/components/tooltip";
import {
    isFilePinned,
    pinFile,
    unpinFile,
    useUserState,
    type PinnedFile,
} from "#ui/user-state";

/** Pins once per edit so a later keystroke cannot restore a pin the operator removed. */
export function usePinOnFirstEdit(props: { file: PinnedFile }) {
    const [, setUserState] = useUserState();
    const file = props.file;

    return React.useCallback(() => {
        setUserState((current) => {
            const pinnedFiles = pinFile(current.pinnedFiles, file);
            if (pinnedFiles === current.pinnedFiles) {
                return current;
            }
            return { ...current, pinnedFiles };
        });
    }, [file, setUserState]);
}

/** Pins the open file from the editor so it can be reopened from the left menu. */
export function PinButton(props: { file: PinnedFile }) {
    const [userState, setUserState] = useUserState();
    const isPinned = isFilePinned(userState.pinnedFiles, props.file);
    const label = isPinned ? "Unpin file" : "Pin file";
    // The button still toggles membership; the tooltip is where auto-pin is explained.
    const tooltip = `${label}. A file is pinned automatically the first time it is edited.`;

    return (
        <Tooltip content={tooltip}>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={label}
                onClick={() => {
                    setUserState((current) => ({
                        ...current,
                        pinnedFiles: isPinned
                            ? unpinFile(current.pinnedFiles, props.file)
                            : pinFile(current.pinnedFiles, props.file),
                    }));
                }}
                className="h-9 w-9 rounded-md p-0 font-semibold"
            >
                <Pin
                    className={`h-4 w-4 ${isPinned ? "fill-current text-blue-300" : ""}`}
                    aria-hidden="true"
                />
            </Button>
        </Tooltip>
    );
}
