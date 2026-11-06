import { describe, expect, test } from "vitest";
import {
    languageFromFileName,
    syntaxLanguageFromFileName,
    syntaxLanguageFromName,
} from "#ui/utils/editor-language";

describe("editor language detection", () => {
    test.each([
        ["#!/bin/sh", "shell"],
        ["#!/usr/bin/env -S python3 -u", "Python"],
        ["#!/usr/bin/env ruby", "Ruby"],
        ["#!/usr/bin/node", "JavaScript"],
        ["#!/usr/bin/env ts-node", "TypeScript"],
    ])("detects %s for an extensionless file", (hashBang, language) => {
        const extension = languageFromFileName(
            "script",
            `${hashBang}
print('hello')`,
        );

        // Every supported interpreter must produce a CodeMirror language extension.
        expect(extension, language).toBeDefined();
    });

    test("does not use a hash bang to override an extension", () => {
        const fromName = languageFromFileName("script.py");

        const withHashBang = languageFromFileName(
            "script.py",
            "#!/usr/bin/env node",
        );

        // File extensions remain authoritative when both signals are available.
        expect(withHashBang?.constructor).toBe(fromName?.constructor);
    });

    test("leaves an unknown extensionless file unhighlighted", () => {
        const extension = languageFromFileName("README", "plain text");

        // Unknown text remains editable without installing an incorrect parser.
        expect(extension).toBeUndefined();
    });

    test.each(["notes.md", "notes.markdown"])(
        "highlights %s as markdown with fenced code languages",
        (fileName) => {
            const extension = languageFromFileName(fileName);

            // Markdown files need the nested fence parsers, not an unknown-text fallback.
            expect(extension).toBeDefined();
        },
    );

    test.each([
        "/etc/systemd/system/nginx.service",
        "redoor.socket",
        "backup.timer",
        "watch.path",
        "home.mount",
        "proc-sys-fs-binfmt_misc.automount",
        "multi-user.target",
        "user.slice",
        "-.slice",
        "dev-sda2.swap",
        "session-1.scope",
        "getty@.service",
        "/etc/systemd/system/nginx.service.d/override.conf",
        "/etc/systemd/system/getty@tty1.service.d/autologin.conf",
        "/run/systemd/transient/backup.timer.d/50-Description.conf",
        "/etc/systemd/system/nginx.service.d/override.conf.redoorencrypted",
    ])("detects %s as a systemd unit", (path) => {
        // Unit suffixes and drop-in directories are the only signals systemd files carry.
        expect(syntaxLanguageFromFileName(path)).toBe("systemd");
    });

    test.each([
        ["/etc/nginx/nginx.conf", "properties"],
        ["/etc/modprobe.d/blacklist.conf", "properties"],
        ["/etc/systemd/system.conf", "properties"],
        ["/etc/systemd/system/service.conf.d/x.conf", "properties"],
        ["override.conf", "properties"],
        [".service", undefined],
        ["service", undefined],
    ])("keeps %s out of systemd", (path, language) => {
        // Only units and their drop-ins are systemd, so other .conf files keep their highlighting.
        expect(syntaxLanguageFromFileName(path)).toBe(language);
    });

    test("resolves a systemd fence label", () => {
        // Markdown fences name the language rather than a unit suffix.
        expect(syntaxLanguageFromName("systemd")).toBe("systemd");
    });
});
