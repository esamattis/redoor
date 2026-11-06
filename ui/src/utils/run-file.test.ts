import { describe, expect, it } from "vitest";
import { buildRunFileCommand } from "#ui/utils/run-file";

describe("buildRunFileCommand", () => {
    it("runs plain names as typed", () => {
        // A plain name needs no quotes, so the terminal shows the familiar `./run.sh`.
        expect(buildRunFileCommand("run.sh")).toBe("./run.sh");
        // The `./` prefix keeps a leading dash from being read as an option.
        expect(buildRunFileCommand("-x")).toBe("./-x");
    });

    it("quotes names the shell would split or expand", () => {
        // A space would otherwise split the name into two words.
        expect(buildRunFileCommand("my script.sh")).toBe("./'my script.sh'");
        // Shell syntax must stay literal so the name cannot run a second command.
        expect(buildRunFileCommand("a;rm -rf $HOME")).toBe(
            "./'a;rm -rf $HOME'",
        );
        // An embedded single quote is closed, escaped and reopened.
        expect(buildRunFileCommand("it's.sh")).toBe(`./'it'"'"'s.sh'`);
    });

    it("refuses names that would act as terminal input", () => {
        // A newline would submit the command early, whatever the quoting.
        expect(buildRunFileCommand("run\nme")).toBeNull();
        // An escape byte could drive the terminal instead of naming the file.
        expect(buildRunFileCommand("run\u001bme")).toBeNull();
        // A path, not a name, would not be relative to the terminal's directory.
        expect(buildRunFileCommand("dir/run.sh")).toBeNull();
        expect(buildRunFileCommand("")).toBeNull();
    });
});
