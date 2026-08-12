/** Focuses a mounted filename input and selects its replaceable stem. */
export function focusAndSelectFileNameStem(input: HTMLInputElement | null) {
    if (!input) {
        return;
    }

    const firstDotIndex = input.value.indexOf(".", 1);
    const selectionEnd =
        firstDotIndex === -1 ? input.value.length : firstDotIndex;
    input.focus();
    input.setSelectionRange(0, selectionEnd);
}
