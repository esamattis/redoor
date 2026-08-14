#!/usr/bin/env node
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "zx";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDirectory = join(rootDirectory, "ui", "public");
const source = join(publicDirectory, "logo-dark.svg");
const backgroundColor = "#01070b";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "redoor-logo-assets-"));
const rasterSource = join(temporaryDirectory, "logo-dark.svg");
const logo192 = join(temporaryDirectory, "logo192.png");
const logo512 = join(temporaryDirectory, "logo512.png");
const favicon = join(temporaryDirectory, "favicon.ico");
const faviconSizes = [16, 32, 48, 64];
const faviconFrames = faviconSizes.map((size) =>
    join(temporaryDirectory, `favicon-${size}.png`),
);

try {
    const sourceSvg = await readFile(source, "utf8");
    // GM renders the SVG filters and canvas gradients as bands, so it owns those raster-only details.
    await writeFile(
        rasterSource,
        sourceSvg
            .replace(/\sfilter="url\(#[^)]+\)"/g, "")
            .replace(
                /\s*<rect width="620" height="620" fill="url\(#background\)" \/>/,
                "",
            )
            .replace(
                /\s*<rect width="620" height="620" fill="transparent"[^>]*\/>/,
                "",
            ),
    );
    await Promise.all([
        $`gm convert -background ${backgroundColor} ${rasterSource} -flatten -resize 192x192! -depth 8 -strip ${logo192}`,
        $`gm convert -background ${backgroundColor} ${rasterSource} -flatten -resize 512x512! -depth 8 -strip ${logo512}`,
        ...faviconSizes.map(
            (size, index) =>
                $`gm convert -background ${backgroundColor} ${rasterSource} -flatten -resize ${`${size}x${size}!`} -depth 8 -strip ${faviconFrames[index]}`,
        ),
    ]);

    const frameBuffers = await Promise.all(
        faviconFrames.map((frame) => readFile(frame)),
    );
    const headerSize = 6;
    const entrySize = 16;
    const directory = Buffer.alloc(
        headerSize + entrySize * faviconFrames.length,
    );
    directory.writeUInt16LE(0, 0);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(faviconFrames.length, 4);

    // ICO supports embedded PNG frames, avoiding reliance on an optional GM ICO encoder.
    let frameOffset = directory.length;
    for (const [index, frame] of frameBuffers.entries()) {
        const size = faviconSizes[index];
        if (size === undefined) {
            throw new Error(`Missing favicon size for frame ${index}`);
        }
        const entryOffset = headerSize + index * entrySize;
        directory.writeUInt8(size, entryOffset);
        directory.writeUInt8(size, entryOffset + 1);
        directory.writeUInt8(0, entryOffset + 2);
        directory.writeUInt8(0, entryOffset + 3);
        directory.writeUInt16LE(1, entryOffset + 4);
        directory.writeUInt16LE(32, entryOffset + 6);
        directory.writeUInt32LE(frame.length, entryOffset + 8);
        directory.writeUInt32LE(frameOffset, entryOffset + 12);
        frameOffset += frame.length;
    }
    await writeFile(favicon, Buffer.concat([directory, ...frameBuffers]));
    await Promise.all([
        copyFile(logo192, join(publicDirectory, "logo192.png")),
        copyFile(logo512, join(publicDirectory, "logo512.png")),
        copyFile(favicon, join(publicDirectory, "favicon.ico")),
    ]);
    console.log("Generated manifest and favicon assets from logo-dark.svg");
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}
