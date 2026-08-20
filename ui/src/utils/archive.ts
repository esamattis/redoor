/** Names the archive formats whose command-line extractors are supported by the file list. */
export type ArchiveFormat =
    "zip" | "tar" | "tar-gzip" | "tar-bzip2" | "tar-xz" | "rar" | "7z";

/** Describes the format and destination name derived from one recognized archive filename. */
export type ArchiveInfo = {
    format: ArchiveFormat;
    suffix: string;
    directoryName: string;
};

/** Names the extraction location policy selected in the unarchive dialog. */
export type UnarchiveDestination = "current" | "subdirectory" | "custom";

/** Longest suffixes come first so compound tar extensions retain their compression format. */
const archiveSuffixes: ReadonlyArray<{
    suffix: string;
    format: ArchiveFormat;
}> = [
    { suffix: ".tar.bz2", format: "tar-bzip2" },
    { suffix: ".tar.gz", format: "tar-gzip" },
    { suffix: ".tar.xz", format: "tar-xz" },
    { suffix: ".tbz2", format: "tar-bzip2" },
    { suffix: ".tgz", format: "tar-gzip" },
    { suffix: ".tbz", format: "tar-bzip2" },
    { suffix: ".txz", format: "tar-xz" },
    { suffix: ".zip", format: "zip" },
    { suffix: ".tar", format: "tar" },
    { suffix: ".rar", format: "rar" },
    { suffix: ".7z", format: "7z" },
];

/** Avoids sending terminal control bytes that bypass shell argument quoting. */
function isTerminalSafeFileName(fileName: string): boolean {
    return !Array.from(fileName).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
}

/** Keeps unusual suffix-only archive names away from the current and parent directories. */
function getArchiveDirectoryName(stem: string): string {
    return stem === "" || stem === "." || stem === ".." ? "archive" : stem;
}

/** Recognizes archive suffixes without changing the filename's original casing. */
export function getArchiveInfo(fileName: string): ArchiveInfo | null {
    if (!isTerminalSafeFileName(fileName)) {
        return null;
    }
    const lowerName = fileName.toLocaleLowerCase("en-US");
    const match = archiveSuffixes.find((entry) =>
        lowerName.endsWith(entry.suffix),
    );
    if (!match) {
        return null;
    }
    return {
        format: match.format,
        suffix: fileName.slice(fileName.length - match.suffix.length),
        directoryName: getArchiveDirectoryName(
            fileName.slice(0, fileName.length - match.suffix.length),
        ),
    };
}

/** Uses POSIX single-quote escaping so every filename remains one literal shell argument. */
export function quoteShellArgument(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Prefixes row-local paths so leading dashes cannot be interpreted as command options. */
function quoteLocalPath(name: string, trailingSlash = false): string {
    return quoteShellArgument(`./${name}${trailingSlash ? "/" : ""}`);
}

/** Explains why a custom target cannot be used as one safe child directory. */
export function getCustomArchiveDirectoryError(value: string): string | null {
    if (!isTerminalSafeFileName(value)) {
        return "Directory name cannot contain terminal control characters";
    }
    const name = value.trim();
    if (name === "") {
        return "Directory name is required";
    }
    if (name === "." || name === "..") {
        return "Directory name must not be . or ..";
    }
    if (name.includes("/") || name.includes("\\")) {
        return "Directory name must be a single path component without path separators";
    }
    return null;
}

/** Chooses extraction flags explicitly so compressed tar aliases do not depend on inference. */
function getTarCommand(format: ArchiveFormat, archive: string): string {
    if (format === "tar-gzip") return `tar -xzf ${archive}`;
    if (format === "tar-bzip2") return `tar -xjf ${archive}`;
    if (format === "tar-xz") return `tar -xJf ${archive}`;
    return `tar -xf ${archive}`;
}

/** Builds the one-shot command run by a fresh terminal for the selected destination policy. */
export function buildUnarchiveCommand(
    fileName: string,
    destination: UnarchiveDestination,
    customDirectoryName = "",
): string | null {
    const archive = getArchiveInfo(fileName);
    if (!archive) {
        return null;
    }
    const archivePath = quoteLocalPath(fileName);
    if (destination === "current") {
        if (archive.format === "zip") return `unzip ${archivePath}`;
        if (archive.format.startsWith("tar")) {
            return getTarCommand(archive.format, archivePath);
        }
        if (archive.format === "rar") return `unrar x ${archivePath}`;
        return `7z x ${archivePath}`;
    }

    const directoryName =
        destination === "custom"
            ? customDirectoryName.trim()
            : archive.directoryName;
    if (
        destination === "custom" &&
        getCustomArchiveDirectoryError(customDirectoryName)
    ) {
        return null;
    }
    const destinationPath = quoteLocalPath(directoryName);
    const mkdir = `mkdir -- ${destinationPath}`;
    if (archive.format === "zip") {
        return `${mkdir} && unzip ${archivePath} -d ${destinationPath}`;
    }
    if (archive.format.startsWith("tar")) {
        return `${mkdir} && ${getTarCommand(archive.format, archivePath)} -C ${destinationPath}`;
    }
    if (archive.format === "rar") {
        return `${mkdir} && unrar x ${archivePath} ${quoteLocalPath(directoryName, true)}`;
    }
    return `${mkdir} && 7z x ${archivePath} ${quoteShellArgument(`-o./${directoryName}`)}`;
}
