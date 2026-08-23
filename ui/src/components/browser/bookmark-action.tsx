import { Bookmark, BookmarkCheck } from "lucide-react";

import { ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { Tooltip } from "#ui/components/tooltip";
import {
    isPathBookmarked,
    toggleBookmark,
    useUserState,
    type Bookmark as BookmarkEntry,
} from "#ui/user-state";

/** Keeps direct bookmark controls consistent with bookmark actions in menus. */
export function BookmarkButton(props: { bookmark: BookmarkEntry }) {
    const [userState, setUserState] = useUserState();
    const isBookmarked = isPathBookmarked(userState.bookmarks, props.bookmark);
    const label = isBookmarked ? "Remove bookmark" : "Bookmark";

    return (
        <Tooltip content={label}>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={label}
                onClick={() => {
                    setUserState((current) => ({
                        ...current,
                        bookmarks: toggleBookmark(
                            current.bookmarks,
                            props.bookmark,
                        ),
                    }));
                }}
                className="h-9 w-9 rounded-md p-0 font-semibold sm:w-auto sm:px-3.5"
            >
                {isBookmarked ? (
                    <BookmarkCheck className="h-4 w-4" aria-hidden="true" />
                ) : (
                    <Bookmark className="h-4 w-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{label}</span>
            </Button>
        </Tooltip>
    );
}

/** Lets every path menu persist the same bookmark document through user state. */
export function BookmarkMenuButton(props: {
    bookmark: BookmarkEntry;
    close: () => void;
}) {
    const [userState, setUserState] = useUserState();
    const isBookmarked = isPathBookmarked(userState.bookmarks, props.bookmark);

    return (
        <ActionMenuButton
            onClick={() => {
                props.close();
                setUserState((current) => ({
                    ...current,
                    bookmarks: toggleBookmark(
                        current.bookmarks,
                        props.bookmark,
                    ),
                }));
            }}
        >
            {isBookmarked ? (
                <BookmarkCheck className="h-4 w-4 text-slate-400" />
            ) : (
                <Bookmark className="h-4 w-4 text-slate-400" />
            )}
            {isBookmarked ? "Remove bookmark" : "Bookmark"}
        </ActionMenuButton>
    );
}
