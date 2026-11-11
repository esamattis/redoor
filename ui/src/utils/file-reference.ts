/**
 * Formats lines of a file as a fenced block headed by `path#Lline`, which AI agents resolve
 * back to the file and line the snippet came from. The editor and the diff view both copy this
 * form, so a reference pasted into a prompt reads the same wherever it was taken.
 */
export function formatFileReference(
    path: string,
    startLine: number,
    text: string,
): string {
    return `\`\`\`${path}#L${String(startLine)}
${text}
\`\`\``;
}
