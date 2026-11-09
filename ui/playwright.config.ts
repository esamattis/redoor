import { defineConfig, devices } from "@playwright/test";
import { testPorts } from "#test-ports";

/**
 * Specs in `e2e/serial/` change state every other spec shares: the one server process and
 * its agents, the device list, or the single user's server-side settings document
 * (`PUT /api/v1/user/state` replaces the whole document from the page's cached copy, so one
 * spec's write also clobbers keys another spec just set). They run one at a time after all
 * other specs, each with a comment at its top saying why it is serial.
 *
 * Every other spec runs in parallel, so it may only touch its own `setupTestDir` directory
 * and uniquely named files. Editing a file auto-pins it and deleting a path unpins it; those
 * incidental settings writes are fine because no parallel spec asserts on pins. Parallel
 * specs that count requests use `ignoreServerEvents`, since other specs' uploads and edits
 * make every open page refetch. To keep most of a file parallel, move only its shared-state
 * tests to a spec in `e2e/serial/`.
 */
const serialSpecPattern = /\/e2e\/serial\//;

// Server log history is a 500-line window; this file must run before the rest of the
// suite evicts the startup fixtures.
const earlyLogSpecPattern = /\/server-logs\.spec\.ts$/;

// Keeps the developer's own git config out of the spec repos: settings such as
// `tag.gpgsign` turn a plain `git tag` into a signed tag that needs a message. Set on
// `process.env` because every worker loads this file and the web server inherits it.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

process.env.GIT_CONFIG_NOSYSTEM = "1";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
    testDir: "./e2e",
    globalSetup: "./e2e/global-setup.ts",
    // Files run in parallel, but the tests of one file stay in one worker in order: many
    // files share a `beforeAll`/`beforeEach` test directory between their tests.
    fullyParallel: false,
    /* Fail the build on CI if you accidentally left test.only in the source code. */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    // Each worker drives its own Chromium against the one shared server. `pn test` runs this
    // suite next to the vitest integration suite on an 8-core / 8 GB machine, and more
    // workers mostly add memory pressure and timing flakiness there, while most specs finish
    // in under two seconds so three workers already keep the CPU busy.
    workers: 3,
    /* Reporter to use. See https://playwright.dev/docs/test-reporters */
    reporter: "html",
    /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
    use: {
        /* Base URL to use in actions like `await page.goto('')`. */
        // baseURL: 'http://localhost:3000',

        /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
        trace: "on-first-retry",
        // No shared signed-in state: `e2e/fixtures.ts` signs every test in with a session of
        // its own, because the server rotates session cookies and treats one cookie used by
        // two browsers as a stolen copy.
    },

    // The projects run one after another: early logs, then everything isolated in parallel,
    // then the shared-state specs one at a time so they never overlap with anything. The
    // chain also means a failure in an earlier project skips the later ones.
    projects: [
        {
            name: "chromium-early-logs",
            use: { ...devices["Desktop Chrome"] },
            testMatch: earlyLogSpecPattern,
            workers: 1,
        },
        {
            name: "chromium-parallel",
            use: { ...devices["Desktop Chrome"] },
            testIgnore: [earlyLogSpecPattern, serialSpecPattern],
            dependencies: ["chromium-early-logs"],
        },
        {
            name: "chromium-serial",
            use: { ...devices["Desktop Chrome"] },
            testDir: "./e2e/serial",
            // Runs after the parallel project so restarts and settings changes cannot race it.
            dependencies: ["chromium-parallel"],
            workers: 1,
        },
    ],

    /* Run your local dev server before starting the tests */
    webServer: {
        command: "node ../scripts/test/playwright-dev.mts",
        url: `http://localhost:${testPorts.playwright}/`,
        reuseExistingServer: false,
        env: {
            // The server and its agents inherit this to avoid flashing the developer's desktop.
            REDOOR_AGENT_NOTIFICATION: "off",
            // Agents reconnect after a fixed short delay instead of the production 2-5 s
            // jitter, so restart.spec.ts and other reconnects do not stall the suite.
            REDOOR_RECONNECT_DELAY: "200ms",
        },
    },
});
