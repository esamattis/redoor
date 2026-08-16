import { Bookmark, BookmarkCheck } from "lucide-react";

import { ActionMenuButton } from "#ui/components/action-menu";
import {
    isPathBookmarked,
    toggleBookmark,
    useUserState,
    type Bookmark as BookmarkEntry,
} from "#ui/user-state";

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
