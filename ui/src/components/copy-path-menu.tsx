import { Check, Copy } from "lucide-react";

import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { useCopyFeedback } from "#ui/components/copyable-code-row";
import { cn } from "#ui/utils/cn";

/**
 * Reads a path relative to its repository, or null outside one and for the repository root
 * itself, where the relative form would be empty.
 */
export function repositoryRelativePath(
    path: string,
    repositoryRoot: string | null,
): string | null {
    if (repositoryRoot === null) {
        return null;
    }

    const rootPrefix = repositoryRoot.endsWith("/")
        ? repositoryRoot
        : `${repositoryRoot}/`;

    return path.startsWith(rootPrefix) && path !== rootPrefix
        ? path.slice(rootPrefix.length)
        : null;
}

/**
 * Lists the forms of a path worth copying: the bare name for a search, the repository path
 * for Git commands and reviews, and the absolute path for a shell on the device.
 */
function copyPathOptions(args: {
    path: string;
    repositoryPath: string | null;
    nameLabel: string;
}) {
    const name = args.path
        .split("/")
        .filter((part) => part !== "")
        .at(-1);

    return [
        { label: args.nameLabel, value: name ?? "/" },
        ...(args.repositoryPath === null
            ? []
            : [{ label: "Copy repository path", value: args.repositoryPath }]),
        { label: "Copy absolute path", value: args.path },
    ];
}

/**
 * Copies a path in the form the next step needs. The menu closes on a pick, so the trigger
 * itself shows that the copy landed. Each option shows its value so the reader knows which
 * form it copies, except on phones, where the long paths would crowd the narrow menu and the
 * labels alone are enough.
 */
export function CopyPathMenu(props: {
    /** The absolute path. */
    path: string;
    /** The path relative to its repository, or null outside one. */
    repositoryPath: string | null;
    /** Names the copy of the last segment; "file name" only fits a known file. */
    nameLabel?: string;
    triggerAriaLabel: string;
    tooltip: string;
    className?: string;
    iconClassName?: string;
}) {
    const { isCopied, copy } = useCopyFeedback(props.path);

    const options = copyPathOptions({
        path: props.path,
        repositoryPath: props.repositoryPath,
        nameLabel: props.nameLabel ?? "Copy file name",
    });

    const iconClassName = cn("h-4 w-4", props.iconClassName);

    return (
        <ActionMenu
            variant="icon"
            label="Copy path"
            triggerAriaLabel={isCopied ? "Copied!" : props.triggerAriaLabel}
            closeAriaLabel="Close copy path menu"
            tooltip={isCopied ? "Copied!" : props.tooltip}
            icon={
                isCopied ? (
                    <Check className={iconClassName} aria-hidden="true" />
                ) : (
                    <Copy className={iconClassName} aria-hidden="true" />
                )
            }
            // Desktops fit a long path on one line; the menu still never outgrows the screen.
            panelClassName="sm:w-max sm:max-w-[min(48rem,calc(100vw-1rem))]"
            className={cn(props.className, isCopied && "text-emerald-300")}
        >
            {(close) =>
                options.map((option) => (
                    <ActionMenuButton
                        key={option.label}
                        onClick={() => {
                            close();
                            void copy(option.value);
                        }}
                    >
                        <span className="flex min-w-0 flex-col">
                            <span>{option.label}</span>
                            <span className="hidden break-all font-mono text-xs font-normal text-slate-500 sm:block">
                                {option.value}
                            </span>
                        </span>
                    </ActionMenuButton>
                ))
            }
        </ActionMenu>
    );
}
