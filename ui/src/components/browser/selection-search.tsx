import React from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";
import { useAgentSearchNavigation } from "#ui/search-navigation";

/** Space between the selected text and the floating button. */
const BUTTON_GAP = 6;

/** Rough height of the button, to tell whether it still fits below the selection. */
const BUTTON_HEIGHT = 40;

/**
 * Where the floating button sits, in viewport pixels, and the text it searches for. Each
 * edge is optional so the button can hang off whichever side of the selection has room
 * without measuring itself first.
 */
interface SelectionSearchTarget {
    text: string;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
}

/**
 * Reads the document selection as a search query when it lies inside `container`. Only a
 * single line qualifies, because content search matches one line at a time and a query
 * spanning lines could never match. The button goes under the end of the selection, where
 * the pointer let go, and flips above or leftwards near the viewport's edges.
 */
function selectionSearchTarget(
    container: HTMLElement,
): SelectionSearchTarget | null {
    const selection = document.getSelection();

    if (
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0
    ) {
        return null;
    }

    const range = selection.getRangeAt(selection.rangeCount - 1);

    if (!container.contains(range.commonAncestorContainer)) {
        return null;
    }

    const text = selection.toString().trim();

    if (text === "" || text.includes("\n")) {
        return null;
    }

    const rects = range.getClientRects();
    const first = rects.item(0);
    const last = rects.item(rects.length - 1);

    if (first === null || last === null) {
        return null;
    }

    // A selection scrolled out of view has nothing for the button to point at.
    if (last.bottom < 0 || first.top > window.innerHeight) {
        return null;
    }

    const fitsBelow =
        last.bottom + BUTTON_GAP + BUTTON_HEIGHT <= window.innerHeight;

    const vertical = fitsBelow
        ? { top: last.bottom + BUTTON_GAP }
        : { bottom: window.innerHeight - first.top + BUTTON_GAP };

    const horizontal =
        last.right <= window.innerWidth / 2
            ? { left: Math.max(0, last.right) }
            : { right: Math.max(0, window.innerWidth - last.right) };

    return { text, ...vertical, ...horizontal };
}

/**
 * Offers a content search for text selected inside its children, as a button floating next
 * to the selection, so a name spotted in a diff can be looked up across the repository
 * without copying it into the search dialog by hand. The search starts from the Git
 * repository root, since a diff is always about a repository and the name is likely used
 * outside the directory being viewed.
 */
export function SelectionSearch(props: { children: React.ReactNode }) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const buttonRef = React.useRef<HTMLDivElement>(null);

    const [target, setTarget] = React.useState<SelectionSearchTarget | null>(
        null,
    );

    const { updateSearch } = useAgentSearchNavigation();

    // Follows the browser's selection, which React has no events for.
    React.useEffect(() => {
        // The button waits for a mouse drag to finish, so it never jumps around under the
        // pointer while the reader is still selecting. Touch selection is adjusted with
        // handles instead, so it shows the button as soon as there is something selected.
        let isSelectingWithMouse = false;

        const update = () => {
            const container = containerRef.current;

            setTarget(
                container === null || isSelectingWithMouse
                    ? null
                    : selectionSearchTarget(container),
            );
        };

        const pointerDown = (event: PointerEvent) => {
            if (
                event.pointerType !== "mouse" ||
                (event.target instanceof Node &&
                    buttonRef.current?.contains(event.target))
            ) {
                return;
            }

            isSelectingWithMouse = true;
            update();
        };

        const pointerUp = () => {
            if (!isSelectingWithMouse) {
                return;
            }

            isSelectingWithMouse = false;
            update();
        };

        document.addEventListener("selectionchange", update);
        document.addEventListener("pointerdown", pointerDown);
        document.addEventListener("pointerup", pointerUp);
        document.addEventListener("pointercancel", pointerUp);
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);

        return () => {
            document.removeEventListener("selectionchange", update);
            document.removeEventListener("pointerdown", pointerDown);
            document.removeEventListener("pointerup", pointerUp);
            document.removeEventListener("pointercancel", pointerUp);
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, []);

    return (
        <div ref={containerRef} className="contents">
            {props.children}
            {target === null
                ? null
                : createPortal(
                      <div
                          ref={buttonRef}
                          // The opaque background sits under the button, whose hover tint is translucent.
                          className="fixed z-[60] rounded-md bg-surface-raised shadow-lg shadow-black/30"
                          style={{
                              top: target.top,
                              bottom: target.bottom,
                              left: target.left,
                              right: target.right,
                          }}
                      >
                          <IconButton
                              type="button"
                              variant="outline"
                              size="sm"
                              label="Search selected text"
                              tooltip="Search the selected text in file contents from the Git repository root."
                              // Pressing a button would otherwise clear the selection it acts on.
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() =>
                                  void updateSearch({
                                      q: target.text,
                                      mode: "content",
                                      gitroot: true,
                                  })
                              }
                          >
                              <Search className="h-4 w-4" aria-hidden="true" />
                          </IconButton>
                      </div>,
                      document.body,
                  )}
        </div>
    );
}
