import { isTerminalSafeFileName, quoteShellArgument } from "#ui/utils/archive";

/** Names that every POSIX shell reads as one literal word, so they need no quotes. */
const PLAIN_SHELL_WORD = /^[A-Za-z0-9._+@%:,=-]+$/;

/**
 * Builds the command a fresh terminal in the file's directory types to run it. The `./`
 * prefix makes the shell run the file instead of searching PATH, and quoting keeps names with
 * spaces or shell syntax one word. Plain names stay unquoted so the command reads the way a
 * user would type it. Returns null for names with control characters, which quoting cannot
 * keep from acting as terminal input.
 */
export function buildRunFileCommand(fileName: string): string | null {
    if (
        fileName === "" ||
        fileName.includes("/") ||
        !isTerminalSafeFileName(fileName)
    ) {
        return null;
    }

    return PLAIN_SHELL_WORD.test(fileName)
        ? `./${fileName}`
        : `./${quoteShellArgument(fileName)}`;
}
