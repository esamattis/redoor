import { describe, expect, test } from "vitest";
import {
    syntaxLanguageFromFileName,
    syntaxLanguageFromName,
} from "#ui/utils/syntax-language";

describe("editor language detection", () => {
    test.each([
        ["#!/bin/sh", "shell"],
        ["#!/usr/bin/env -S python3 -u", "python"],
        ["#!/usr/bin/env ruby", "ruby"],
        ["#!/usr/bin/node", "javascript"],
        ["#!/usr/bin/env ts-node", "typescript"],
    ])("detects %s for an extensionless file", (hashBang, language) => {
        const detected = syntaxLanguageFromFileName(
            "script",
            `${hashBang}
print('hello')`,
        );

        // Every supported interpreter must pick the grammar of its language.
        expect(detected).toBe(language);
    });

    test("does not use a hash bang to override an extension", () => {
        const withHashBang = syntaxLanguageFromFileName(
            "script.py",
            "#!/usr/bin/env node",
        );

        // File extensions remain authoritative when both signals are available.
        expect(withHashBang).toBe("python");
    });

    test("leaves an unknown extensionless file unhighlighted", () => {
        const detected = syntaxLanguageFromFileName("README", "plain text");

        // Unknown text remains editable without installing an incorrect parser.
        expect(detected).toBeUndefined();
    });

    test.each(["nginx.conf.j2", "page.jinja", "page.JINJA2"])(
        "highlights %s as a Jinja template",
        (fileName) => {
            // Templates are named by their Jinja extension, whatever they render to.
            expect(syntaxLanguageFromFileName(fileName)).toBe("jinja");
        },
    );

    test.each(["notes.md", "notes.markdown"])(
        "highlights %s as markdown",
        (fileName) => {
            // Markdown files need the markdown grammar, not an unknown-text fallback.
            expect(syntaxLanguageFromFileName(fileName)).toBe("markdown");
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
