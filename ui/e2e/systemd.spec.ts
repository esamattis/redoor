import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { $ } from "zx";

import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";
import { ApiClient } from "#ui/api-client";

/**
 * The account the Playwright agents run as. The user manager reads unit files from the
 * account's real home, not from `$HOME`, so the unit file goes there.
 */
const account = os.userInfo();

const unitDirectory = path.join(account.homedir, ".config/systemd/user");

/** Where the user manager keeps `Persistent=` timers' last-run stamps, named `stamp-<timer>`. */
const timerStampDirectory = path.join(
    account.homedir,
    ".local/share/systemd/timers",
);

/** Escapes a path for a URL pattern, since unit names and paths contain dots. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the Systemd view of a file opened from a user's units, which is where every unit's
 * status lives. The link names the user's manager, so the view asks that manager about the file.
 */
function systemdViewUrl(agentName: string, filePath: string): RegExp {
    return new RegExp(
        `/agents/${escapeRegExp(agentName)}/browser${escapeRegExp(filePath)}\\?view=systemd&systemdScope=${escapeRegExp(encodeURIComponent(`user/${account.username}`))}$`,
    );
}

/** Whether this machine has a reachable user manager; CI containers and macOS do not. */
async function userManagerReachable(): Promise<boolean> {
    const result = await $`systemctl --user show-environment`.quiet().nothrow();

    return result.exitCode === 0;
}

/** Whether the agent the specs drive reported systemd support to the server. */
async function agentReportsSystemd(agentName: string): Promise<boolean> {
    const api = new ApiClient(WEB_BASE_URL);
    await api.login("test-user", "test-password");
    const agents = await api.listAgents();

    return (
        agents.find((agent) => agent.name === agentName)?.systemd?.status ===
        "available"
    );
}

test.describe("Systemd units", () => {
    let context: TestContext;
    let unitName: string;
    let unitPath: string;
    /** Set by tests that add a timer for the unit, so `afterEach` removes it as well. */
    let timerName: string | undefined;

    test.beforeAll(async () => {
        context = await setupTestDir("systemd");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test.beforeEach(async () => {
        test.skip(
            !(await userManagerReachable()),
            "systemctl --user is not reachable on this machine",
        );
        test.skip(
            !(await agentReportsSystemd(context.agentName)),
            "The agent does not report systemd support",
        );

        timerName = undefined;

        // A random name keeps parallel and aborted runs from sharing a unit.
        unitName = `redoor-e2e-${randomBytes(4).toString("hex")}.service`;
        unitPath = path.join(unitDirectory, unitName);

        await fs.mkdir(unitDirectory, { recursive: true });
        await fs.writeFile(
            unitPath,
            `[Unit]
Description=Redoor e2e test unit

[Service]
ExecStart=/bin/sh -c 'echo redoor-e2e-ready; exec sleep infinity'
`,
        );
        await $`systemctl --user daemon-reload`;
    });

    test.afterEach(async () => {
        // Each step tolerates a setup that stopped half way, such as a skipped test.
        if (unitPath === undefined) {
            return;
        }

        if (timerName !== undefined) {
            // The timer goes first so it cannot start the service again while that stops.
            await $`systemctl --user stop -- ${timerName}`.quiet().nothrow();
            await fs.rm(path.join(unitDirectory, timerName), { force: true });
            await fs.rm(path.join(timerStampDirectory, `stamp-${timerName}`), {
                force: true,
            });
        }

        await $`systemctl --user stop -- ${unitName}`.quiet().nothrow();
        await $`systemctl --user reset-failed -- ${unitName}`.quiet().nothrow();
        await fs.rm(unitPath, { force: true });
        await $`systemctl --user daemon-reload`.quiet().nothrow();
    });

    test("starts a user unit, follows its journal and stops it", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentName}`);

        await page
            .getByLabel("Device view")
            .getByRole("link", { name: "Systemd", exact: true })
            .click();

        // A non-root agent opens its own user's manager, the one it can manage.
        await expect(page).toHaveURL(
            new RegExp(
                `/agents/${context.agentName}/systemd/user/${account.username}$`,
            ),
        );
        await expect(
            page.getByRole("heading", { name: `Units of ${account.username}` }),
        ).toBeVisible();

        await page.getByLabel("Filter units").fill(unitName);

        const unitList = page.getByRole("list", {
            name: `Units of ${account.username}`,
        });

        // The filter keeps only the test unit, which the list found among the unit files.
        await expect(unitList.getByRole("listitem")).toHaveCount(1);
        await unitList
            .getByRole("link", { name: unitName, exact: true })
            .click();

        // The unit's status lives in the Systemd tab of its unit file.
        await expect(page).toHaveURL(
            systemdViewUrl(context.agentName, unitPath),
        );
        await expect(
            page.getByRole("heading", { name: unitName, exact: true }),
        ).toBeVisible();
        // The tab strip must show which view of the file is open.
        await expect(
            page
                .getByLabel("File view")
                .getByRole("link", { name: "Systemd", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        const status = page.getByLabel("Unit status");

        // The unit was never started, so the page must show it inactive first.
        await expect(status).toContainText("inactive");

        const journal = page.getByRole("log", { name: `${unitName} journal` });

        await page
            .getByRole("group", { name: "Unit actions" })
            .getByRole("button", { name: "Start", exact: true })
            .click();

        // The action answers with the status after systemd's job finished.
        await expect(status).toContainText("active (running)");
        // The line the unit writes on start must arrive through the live journal.
        await expect(journal).toContainText("redoor-e2e-ready");

        await page
            .getByRole("group", { name: "Unit actions" })
            .getByRole("button", { name: "Stop", exact: true })
            .click();

        const confirmation = page.getByRole("dialog", {
            name: `Stop ${unitName}?`,
        });

        // Stopping asks first, since it terminates the unit's processes.
        await confirmation
            .getByRole("button", { name: "Stop", exact: true })
            .click();
        await expect(confirmation).toHaveCount(0);
        await expect(status).toContainText("inactive (dead)");

        // The device must agree with the page, not just the cached status.
        await expect
            .poll(async () =>
                (
                    await $`systemctl --user is-active -- ${unitName}`
                        .quiet()
                        .nothrow()
                ).stdout.trim(),
            )
            .toBe("inactive");
    });

    test("lists a timer's schedule and links it with the service it starts", async ({
        page,
    }) => {
        const timer = unitName.replace(/\.service$/, ".timer");
        timerName = timer;

        // The calendar rule lies far in the future, so the 1h monotonic rule is the next run
        // and neither fires while the test runs.
        await fs.writeFile(
            path.join(unitDirectory, timer),
            `[Unit]
Description=Redoor e2e test timer

[Timer]
OnCalendar=2099-01-01 00:00:00
OnActiveSec=1h
Persistent=true
`,
        );
        await $`systemctl --user daemon-reload`;
        await $`systemctl --user start -- ${timer}`;

        await page.goto(
            `${WEB_BASE_URL}/agents/${context.agentName}/systemd/user/${account.username}`,
        );
        await expect(
            page.getByRole("heading", { name: `Units of ${account.username}` }),
        ).toBeVisible();

        await page.getByLabel("Unit type").selectOption("timer");
        await page.getByLabel("Filter units").fill(timer);

        const unitList = page.getByRole("list", {
            name: `Units of ${account.username}`,
        });

        const timerRow = unitList.getByRole("listitem", {
            name: `Unit ${timer}`,
        });

        // The timer view must show the countdown to the 1h rule, not the 2099 calendar rule.
        await expect(timerRow).toContainText(/in \d+m/);
        // The timer has not elapsed yet, so the last run reads as never.
        await expect(timerRow).toContainText("Never");
        // The row must link the service the timer activates.
        await expect(
            timerRow.getByRole("link", { name: unitName, exact: true }),
        ).toBeVisible();

        await timerRow.getByRole("link", { name: timer, exact: true }).click();

        // The timer opens in the Systemd view of its own file.
        await expect(page).toHaveURL(
            systemdViewUrl(context.agentName, path.join(unitDirectory, timer)),
        );
        await expect(
            page.getByRole("heading", { name: timer, exact: true }),
        ).toBeVisible();

        const schedule = page.getByRole("region", { name: "Timer schedule" });

        // The rules from the unit file must be shown as systemd reports them.
        await expect(schedule).toContainText("OnActiveSec=1h");
        await expect(schedule).toContainText("OnCalendar=2099-01-01 00:00:00");
        await expect(schedule).toContainText("Never");

        await schedule
            .getByRole("link", { name: unitName, exact: true })
            .click();

        // "Activates" resolves the service's name to its file through the unit list.
        await expect(page).toHaveURL(
            systemdViewUrl(context.agentName, unitPath),
        );
        await expect(
            page.getByRole("heading", { name: unitName, exact: true }),
        ).toBeVisible();

        const status = page.getByLabel("Unit status");

        // The service page must say which timer starts it and lead back to that timer.
        await expect(status).toContainText("Triggered by");
        await status.getByRole("link", { name: timer, exact: true }).click();
        await expect(page).toHaveURL(
            systemdViewUrl(context.agentName, path.join(unitDirectory, timer)),
        );
        await expect(
            page.getByRole("heading", { name: timer, exact: true }),
        ).toBeVisible();
    });

    test("offers the Systemd tab only for files a manager loads", async ({
        page,
    }) => {
        // A unit file outside every unit directory is no unit to systemd.
        const strayUnit = path.join(context.testDirPath, unitName);
        await fs.writeFile(
            strayUnit,
            `[Service]
ExecStart=/bin/true
`,
        );
        const textFile = path.join(context.testDirPath, "file1.txt");
        const tabs = page.getByLabel("File view");

        await page.goto(deviceBrowserUrl(context.agentName, textFile));
        await expect(
            tabs.getByRole("link", { name: "Details", exact: true }),
        ).toBeVisible();
        // A file that is no unit file never gets the tab (nor asks the device).
        await expect(
            tabs.getByRole("link", { name: "Systemd", exact: true }),
        ).toHaveCount(0);

        await page.goto(
            `${deviceBrowserUrl(context.agentName, strayUnit)}?view=systemd`,
        );

        // The loader asked systemd before rendering and found no manager, so the view falls
        // back to the file's default view, like the Git view of a file outside a repository.
        await expect(page).toHaveURL(new RegExp(`${escapeRegExp(strayUnit)}$`));
        await expect(
            tabs.getByRole("link", { name: "Details", exact: true }),
        ).toBeVisible();
        // The answer is cached from the loader, so the tab is hidden from the first render.
        await expect(
            tabs.getByRole("link", { name: "Systemd", exact: true }),
        ).toHaveCount(0);

        await page.goto(deviceBrowserUrl(context.agentName, unitPath));

        // The same kind of file inside the user's unit directory does get the tab.
        await expect(
            tabs.getByRole("link", { name: "Systemd", exact: true }),
        ).toBeVisible();
    });
});
