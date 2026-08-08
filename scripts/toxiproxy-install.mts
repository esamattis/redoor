#!/usr/bin/env node

import { $, chalk } from "zx";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const VERSION = "2.12.0";
const RELEASE_BASE_URL = `https://github.com/Shopify/toxiproxy/releases/download/v${VERSION}`;

if (process.platform !== "linux") {
    throw new Error("The Toxiproxy systemd user service installer only supports Linux.");
}

const releaseArchitecture = new Map<string, string>([
    ["x64", "amd64"],
    ["arm64", "arm64"],
]).get(process.arch);

if (releaseArchitecture === undefined) {
    throw new Error(`Unsupported architecture: ${process.arch}`);
}

const archiveName = `toxiproxy_${VERSION}_linux_${releaseArchitecture}.tar.gz`;
const homeDirectory = homedir();
const binDirectory = join(homeDirectory, ".local", "bin");
const systemdDirectory = join(homeDirectory, ".config", "systemd", "user");
const unitPath = join(systemdDirectory, "toxiproxy.service");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "toxiproxy-install-"));
const archivePath = join(temporaryDirectory, archiveName);
const checksumsPath = join(temporaryDirectory, "checksums.txt");

try {
    console.log(
        `Installing Toxiproxy v${VERSION} for linux/${releaseArchitecture}...`,
    );

    await $`mkdir -p ${binDirectory} ${systemdDirectory}`;
    await Promise.all([
        $`curl --fail --location --retry 3 --output ${archivePath} ${`${RELEASE_BASE_URL}/${archiveName}`}`,
        $`curl --fail --location --retry 3 --output ${checksumsPath} ${`${RELEASE_BASE_URL}/checksums.txt`}`,
    ]);

    const checksums = await readFile(checksumsPath, "utf8");
    const expectedChecksum = checksums
        .split("\n")
        .find((line) => line.trim().endsWith(archiveName))
        ?.trim()
        .split(/\s+/)[0];

    if (expectedChecksum === undefined) {
        throw new Error(`No published checksum found for ${archiveName}`);
    }

    const actualChecksum = (await $`sha256sum ${archivePath}`).stdout
        .trim()
        .split(/\s+/)[0];

    if (actualChecksum !== expectedChecksum) {
        throw new Error(
            `Checksum mismatch for ${archiveName}: expected ${expectedChecksum}, got ${actualChecksum}`,
        );
    }

    await $`tar -xzf ${archivePath} -C ${temporaryDirectory}`;

    // Replacing via rename avoids truncating an executable that an existing service is using.
    for (const binaryName of ["toxiproxy-server", "toxiproxy-cli"]) {
        const sourcePath = join(temporaryDirectory, binaryName);
        const destinationPath = join(binDirectory, binaryName);
        const stagedPath = `${destinationPath}.new`;
        await $`install -m 0755 ${sourcePath} ${stagedPath}`;
        await $`mv -f ${stagedPath} ${destinationPath}`;
    }

    // %h keeps the unit portable between users without embedding the installer's home path.
    await writeFile(
        unitPath,
        `[Unit]
Description=Toxiproxy server
Documentation=https://github.com/Shopify/toxiproxy
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/toxiproxy-server
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`,
    );

    await $`systemctl --user daemon-reload`;
    await $`systemctl --user enable toxiproxy.service`;
    await $`systemctl --user restart toxiproxy.service`;
    await $`systemctl --user is-active --quiet toxiproxy.service`;

    console.log(
        chalk.green(
            `Toxiproxy v${VERSION} is installed and running as toxiproxy.service.`,
        ),
    );
    console.log("Manage it with: systemctl --user start|stop|status toxiproxy");
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}
