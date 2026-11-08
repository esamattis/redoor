import { expect, test } from "./fixtures";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "zx";
import { z } from "zod";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

/** The part of the path-status answer that tells whether this save left systemd behind. */
const pathStatusSchema = z.object({
    matches: z.array(z.object({ state: z.string() })),
});

/**
 * Saving a unit systemd already loaded leaves it running the old file until a daemon-reload.
 * The unit lives in the real user manager of the account running the tests (agent1_src runs
 * as that account with its real HOME), under a random name so parallel runs never collide.
 */
test.describe.serial("systemd reload offer in the editor", () => {
    let ctx: TestContext | undefined;
    let userManagerReachable = false;
    const unitName = `redoor-e2e-edit-${randomBytes(4).toString("hex")}.service`;

    const unitPath = path.join(
        os.homedir(),
        ".config",
        "systemd",
        "user",
        unitName,
    );

    /** Builds the unit text; only the description changes between the two versions. */
    function unitText(description: string): string {
        return `[Unit]
Description=${description}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
`;
    }

    /** Reads what the user manager reports for the unit, the ground truth of a reload. */
    async function needDaemonReload(): Promise<string> {
        const result =
            await $`systemctl --user show -p NeedDaemonReload --value -- ${unitName}`;

        return result.stdout.trim();
    }

    test.beforeAll(async () => {
        // macOS, Termux and CI runners without a user bus have no user manager to reload.
        userManagerReachable =
            (await $`systemctl --user show -p Version`.nothrow().quiet())
                .exitCode === 0;

        if (!userManagerReachable) {
            return;
        }

        ctx = await setupTestDir("systemd-editor-reload");
        await fs.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.writeFile(unitPath, unitText("redoor e2e before edit"));
        await $`systemctl --user daemon-reload`;
        // An active unit stays loaded; an inactive one may be unloaded and then read fresh
        // on demand, which would never need a reload.
        await $`systemctl --user start -- ${unitName}`;
    });

    test.afterAll(async () => {
        // Tolerates a setup that stopped half way: every step may have nothing to undo.
        if (userManagerReachable) {
            await $`systemctl --user stop -- ${unitName}`.nothrow().quiet();
            await fs.rm(unitPath, { force: true });
            await $`systemctl --user daemon-reload`.nothrow().quiet();
        }

        if (ctx !== undefined) {
            await teardownTestDir(ctx.testDirPath);
        }
    });

    test("offers a user daemon-reload after saving a loaded unit", async ({
        page,
    }) => {
        test.skip(
            !userManagerReachable,
            "systemctl --user cannot reach a user manager",
        );

        if (ctx === undefined) {
            throw new Error("expected the test directory to be set up");
        }

        // The precondition: systemd runs the file as written, so any reload need comes
        // from the edit below.
        expect(await needDaemonReload()).toBe("no");

        await page.goto(deviceBrowserUrl(ctx.agentName, unitPath));
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toContainText("redoor e2e before edit");
        // Opening a unit file asks systemd whether it loads it, for the Systemd tab. Waiting
        // for the tab keeps that answer from being taken for the check after a save below.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Systemd", exact: true }),
        ).toBeVisible();

        const saveButton = page.getByRole("button", { name: "Save file" });
        let edit = 0;

        // Any daemon-reload of this user manager (parallel specs, the systemd integration
        // tests) between the save and the editor's check makes systemd current again, so
        // there is honestly nothing to offer. Each attempt saves a new edit and reads the
        // editor's own check, instead of guessing whether the toast is merely late.
        await expect(async () => {
            edit += 1;

            const pathStatus = page.waitForResponse((response) =>
                response.url().includes("/systemd/path-status"),
            );

            await editor.click();
            await editor.fill(unitText(`redoor e2e after edit ${edit}`));
            await saveButton.click();

            const status = pathStatusSchema.parse(
                await (await pathStatus).json(),
            );

            // systemd still runs the previous version, which is what the offer is for.
            expect(
                status.matches.some((match) => match.state === "needs_reload"),
            ).toBe(true);
        }).toPass({ timeout: 30_000 });

        const offer = page.getByRole("status").filter({
            hasText: `systemd has not loaded the changes to ${unitName}`,
        });

        // The editor turns that answer into a reload offer naming the unit.
        await expect(offer).toBeVisible();

        // A user unit is reloaded in that user's manager, never the system one.
        await offer
            .getByRole("button", { name: "Reload user systemd" })
            .click();

        // The toast reports the reload the user asked for.
        await expect(
            page.getByRole("status").filter({
                hasText: `The user systemd of ${os.userInfo().username} reloaded its unit files`,
            }),
        ).toBeVisible();
        // systemd itself now runs the saved version. Nothing but a later edit could make
        // it stale again, so other suites' reloads cannot break this check.
        expect(await needDaemonReload()).toBe("no");
    });
});
