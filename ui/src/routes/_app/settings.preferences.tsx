import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FileClock, Keyboard, SlidersHorizontal } from "lucide-react";

import { Checkbox } from "#ui/components/checkbox";
import { parseVimConfig } from "#ui/editor/vim-config";
import { TextareaControl } from "#ui/components/textarea-control";
import { Select } from "#ui/components/select";
import { useUserState } from "#ui/user-state";

export const Route = createFileRoute("/_app/settings/preferences")({
    component: PreferencesPage,
});

/**
 * Delays offered for closing untouched open files. A native select gives phones their own
 * picker, and fixed steps avoid half-typed numbers being saved as a delay.
 */
const AUTO_CLOSE_HOUR_CHOICES = [1, 4, 8, 12, 24, 48, 72, 168, 336, 720];

/** Spells an hour count the way people say it, so 168 reads as "7 days". */
function formatHours(hours: number) {
    if (hours % 24 === 0) {
        const days = hours / 24;

        return days === 1 ? "1 day" : `${String(days)} days`;
    }

    return hours === 1 ? "1 hour" : `${String(hours)} hours`;
}

/**
 * Collects the personal preferences that otherwise hide in the menus where they act, so they
 * can be found and changed in one place. They are stored in the user state, so they follow
 * the user to every browser.
 */
function PreferencesPage() {
    const [userState, setUserState] = useUserState();
    const afterHours = userState.autoCloseOpenFilesAfterHours;

    // A delay set outside these steps, such as by an older choice list, stays selectable.
    const hourChoices = AUTO_CLOSE_HOUR_CHOICES.includes(afterHours)
        ? AUTO_CLOSE_HOUR_CHOICES
        : [...AUTO_CLOSE_HOUR_CHOICES, afterHours].sort((a, b) => a - b);

    const delayId = React.useId();
    const vimConfigId = React.useId();
    const vimConfigHelpId = React.useId();
    const vimConfigErrors = parseVimConfig(userState.vimConfig).errors;

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <div className="mx-auto grid max-w-3xl gap-6">
                <header className="flex items-start gap-4 rounded-xl border border-slate-800 bg-surface bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 @xl:px-8">
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 text-blue-300">
                        <SlidersHorizontal
                            className="h-6 w-6"
                            aria-hidden="true"
                        />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-slate-100">
                            Preferences
                        </h1>
                        <p className="mt-1 text-sm text-slate-400">
                            Your personal settings. They are saved for your user
                            and apply in every browser you sign in from.
                        </p>
                    </div>
                </header>
                <PreferenceSection
                    title="Open files"
                    icon={<FileClock className="h-5 w-5" aria-hidden="true" />}
                >
                    <Checkbox
                        checked={userState.autoCloseOpenFiles}
                        title={false}
                        className="w-full px-2 py-2 text-left"
                        onCheckedChange={(checked) => {
                            setUserState((current) => ({
                                ...current,
                                autoCloseOpenFiles: checked,
                            }));
                        }}
                    >
                        Close open files automatically
                    </Checkbox>
                    <p className="px-2 text-xs text-slate-500">
                        Files without unsaved changes are closed when they have
                        not been opened, viewed or edited for the chosen time.
                        The file on screen is never closed.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 px-2 @xl:flex-row @xl:items-center @xl:gap-3">
                        <label
                            htmlFor={delayId}
                            className="text-sm text-slate-300"
                        >
                            Close after
                        </label>
                        <Select
                            id={delayId}
                            value={String(afterHours)}
                            disabled={!userState.autoCloseOpenFiles}
                            containerClassName="w-full @xl:w-48"
                            onChange={(event) => {
                                const hours = Number(event.target.value);

                                setUserState((current) => ({
                                    ...current,
                                    autoCloseOpenFilesAfterHours: hours,
                                }));
                            }}
                        >
                            {hourChoices.map((hours) => (
                                <option key={hours} value={String(hours)}>
                                    {formatHours(hours)}
                                </option>
                            ))}
                        </Select>
                    </div>
                </PreferenceSection>
                <PreferenceSection
                    title="Editor"
                    icon={<Keyboard className="h-5 w-5" aria-hidden="true" />}
                >
                    <Checkbox
                        checked={userState.vimMode}
                        title={false}
                        className="w-full px-2 py-2 text-left"
                        onCheckedChange={(checked) => {
                            setUserState((current) => ({
                                ...current,
                                vimMode: checked,
                            }));
                        }}
                    >
                        Vim mode
                    </Checkbox>
                    <p className="px-2 text-xs text-slate-500">
                        Edit files with Vim keybindings. Also available in the
                        editor&apos;s options menu.
                    </p>
                    <label
                        htmlFor={vimConfigId}
                        className="mt-4 px-2 text-sm font-medium text-slate-300"
                    >
                        Vim configuration
                    </label>
                    <TextareaControl
                        id={vimConfigId}
                        value={userState.vimConfig}
                        rows={10}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        aria-describedby={vimConfigHelpId}
                        aria-invalid={vimConfigErrors.length > 0}
                        className="mt-2 w-full font-mono text-sm"
                        placeholder={`" Exit insert mode with jj
inoremap jj <Esc>
map ö ^`}
                        onChange={(event) => {
                            const vimConfig = event.target.value;
                            setUserState((current) => ({
                                ...current,
                                vimConfig,
                            }));
                        }}
                    />
                    <p
                        id={vimConfigHelpId}
                        className="mt-1 px-2 text-xs text-slate-500"
                    >
                        Saved automatically. Applies when Vim mode is enabled.
                        Supports map, nmap, vmap, imap, noremap, nnoremap,
                        vnoremap and inoremap with two key sequences. Use
                        &lt;Space&gt; for spaces and &lt;Esc&gt; for Escape.
                        Lines starting with &quot; are comments. Other Vimscript
                        and mapping options are unsupported. Invalid lines are
                        skipped.
                    </p>
                    {vimConfigErrors.length > 0 ? (
                        <ul
                            className="mt-2 px-2 text-sm text-amber-300"
                            aria-label="Vim configuration errors"
                        >
                            {vimConfigErrors.map((error) => (
                                <li key={error.line}>
                                    Line {error.line}: {error.message}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </PreferenceSection>
            </div>
        </div>
    );
}

/** One titled card of related preferences, so the page scans by topic. */
function PreferenceSection(props: {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section
            aria-label={props.title}
            className="rounded-xl border border-slate-800 bg-surface p-4 @xl:p-6"
        >
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-slate-100">
                <span className="text-blue-300">{props.icon}</span>
                {props.title}
            </h2>
            <div className="flex flex-col gap-1">{props.children}</div>
        </section>
    );
}
