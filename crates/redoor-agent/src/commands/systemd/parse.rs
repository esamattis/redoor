//! Parsers for the text the systemd tools print.
//!
//! The agent reads `--plain --no-legend --full` tables and `show` key=value lines rather
//! than `-o json`, which needs systemd 246 while Ubuntu 20.04 ships 245. The formats are
//! whitespace tables and `Key=value` lines that have not changed in many releases.

use super::scope::{unit_type, validate_unit_name};
use redoor_protocol::api::systemd::{
    SystemdJournalEntry, SystemdTimerInfo, SystemdTimerSummary, SystemdUnitSummary,
};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Most units one list returns. The list is one control frame, and even a large host has a
/// few thousand units, so the cap only stops pathological hosts.
pub(super) const MAX_LISTED_UNITS: usize = 10_000;

/// One row of `systemctl list-units --all`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LoadedUnit {
    pub(super) name: String,
    pub(super) load_state: String,
    pub(super) active_state: String,
    pub(super) sub_state: String,
    pub(super) description: String,
}

/// Parses `systemctl list-units --all --plain --no-legend --full`: name, load, active and
/// sub state, then the description, which may contain spaces.
pub(super) fn parse_list_units(text: &str) -> Vec<LoadedUnit> {
    text.lines()
        .filter_map(|line| {
            // Some versions still mark failed units with a bullet, even with `--plain`.
            let line = line
                .trim_start()
                .trim_start_matches(['●', '*'])
                .trim_start();
            let mut rest = line;
            let mut columns = [""; 4];
            for column in &mut columns {
                let (value, tail) = split_column(rest)?;
                *column = value;
                rest = tail;
            }
            let [name, load_state, active_state, sub_state] = columns;
            validate_unit_name(name).ok()?;
            Some(LoadedUnit {
                name: name.to_string(),
                load_state: load_state.to_string(),
                active_state: active_state.to_string(),
                sub_state: sub_state.to_string(),
                description: rest.trim().to_string(),
            })
        })
        .collect()
}

/// Splits one whitespace-separated column off the front of `text`.
fn split_column(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    if text.is_empty() {
        return None;
    }
    Some(text.split_once(char::is_whitespace).unwrap_or((text, "")))
}

/// Parses `systemctl list-unit-files --plain --no-legend --full` into unit name and file
/// state; the preset column of newer versions is ignored.
pub(super) fn parse_list_unit_files(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (name, rest) = split_column(line)?;
            let (state, _) = split_column(rest)?;
            validate_unit_name(name).ok()?;
            Some((name.to_string(), state.to_string()))
        })
        .collect()
}

/// Merges loaded units with installed unit files by name, so a disabled unit that is not
/// loaded still appears, sorted by name and cut at [`MAX_LISTED_UNITS`].
pub(super) fn merge_units(
    loaded: Vec<LoadedUnit>,
    files: Vec<(String, String)>,
) -> (Vec<SystemdUnitSummary>, bool) {
    let mut units: BTreeMap<String, SystemdUnitSummary> = BTreeMap::new();
    for unit in loaded {
        units.insert(
            unit.name.clone(),
            SystemdUnitSummary {
                unit_type: unit_type(&unit.name).to_string(),
                name: unit.name,
                description: non_empty(unit.description),
                load_state: Some(unit.load_state),
                active_state: Some(unit.active_state),
                sub_state: Some(unit.sub_state),
                unit_file_state: None,
                fragment_path: None,
                timer: None,
            },
        );
    }
    for (name, state) in files {
        let entry = units
            .entry(name.clone())
            .or_insert_with(|| SystemdUnitSummary {
                unit_type: unit_type(&name).to_string(),
                name,
                description: None,
                load_state: None,
                active_state: None,
                sub_state: None,
                unit_file_state: None,
                fragment_path: None,
                timer: None,
            });
        entry.unit_file_state = Some(state);
    }
    let truncated = units.len() > MAX_LISTED_UNITS;
    (
        units.into_values().take(MAX_LISTED_UNITS).collect(),
        truncated,
    )
}

/// Whether the batched `show` of a unit list asks systemd about this unit.
///
/// Devices and scopes never come from a unit file (scopes only exist through the bus API),
/// units systemd could not find have no file, and masked units point at `/dev/null`; leaving
/// them out keeps the one `show` run short on hosts with many devices and sessions.
pub(super) fn needs_unit_properties(unit: &SystemdUnitSummary) -> bool {
    let Some(load_state) = unit.load_state.as_deref() else {
        return false;
    };
    !matches!(load_state, "not-found" | "masked")
        && !matches!(unit.unit_type.as_str(), "device" | "scope")
}

/// Whether an installed but unloaded unit file is worth looking up in the search path:
/// masked unit files are links to `/dev/null`, not files anyone opens.
pub(super) fn needs_search_path_lookup(unit: &SystemdUnitSummary) -> bool {
    unit.load_state.is_none()
        && unit.fragment_path.is_none()
        && !unit
            .unit_file_state
            .as_deref()
            .is_some_and(|state| state.starts_with("masked"))
}

/// The unit file a list links to, or `None` for a transient unit.
///
/// systemd writes the files of transient units (`systemd-run`, session scopes) into a
/// `systemd/transient` directory itself and removes them when the unit goes away, so they
/// are no file a user edits and linking them would lead to a file that soon disappears.
pub(super) fn editable_fragment(path: Option<String>) -> Option<String> {
    let path = path?;
    let directory = Path::new(&path).parent()?;
    let is_transient = directory
        .file_name()
        .is_some_and(|name| name == "transient")
        && directory
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "systemd");
    (!is_transient && path.starts_with('/')).then_some(path)
}

/// Turns the empty strings systemd prints for unset values into `None`.
fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

/// The `Key=value` lines of `systemctl show -p ...`.
///
/// Keeps every line of a key, because array properties such as `TimersCalendar` print one
/// line per entry under the same key.
#[derive(Debug, Default)]
pub(super) struct UnitProperties(HashMap<String, Vec<String>>);

impl UnitProperties {
    /// Parses `show` output; a value may itself contain `=`.
    pub(super) fn parse(text: &str) -> Self {
        let mut properties: HashMap<String, Vec<String>> = HashMap::new();
        for (key, value) in text.lines().filter_map(|line| line.split_once('=')) {
            properties
                .entry(key.to_string())
                .or_default()
                .push(value.to_string());
        }
        Self(properties)
    }

    /// Parses the output of one `show` run for several units, which separates the units'
    /// blocks with an empty line, so a whole list of timers costs one process.
    pub(super) fn parse_units(text: &str) -> Vec<Self> {
        let mut units = Vec::new();
        let mut block = String::new();
        for line in text.lines() {
            if line.is_empty() {
                if !block.is_empty() {
                    units.push(Self::parse(&block));
                    block.clear();
                }
            } else {
                block.push_str(line);
                block.push('\n');
            }
        }
        if !block.is_empty() {
            units.push(Self::parse(&block));
        }
        units
    }

    /// A property's value, or `None` when it is missing, empty or `[not set]`.
    pub(super) fn text(&self, key: &str) -> Option<String> {
        self.values(key)
            .last()
            .filter(|value| !value.is_empty() && value.as_str() != "[not set]")
            .cloned()
    }

    /// Every line of a property that prints one line per array entry.
    fn values(&self, key: &str) -> &[String] {
        self.0.get(key).map_or(&[], Vec::as_slice)
    }

    /// A `yes`/`no` property.
    pub(super) fn flag(&self, key: &str) -> bool {
        self.text(key).is_some_and(|value| value == "yes")
    }

    /// A numeric property, `None` for unset values and for `u64::MAX`, which older systemd
    /// versions print for "not set".
    pub(super) fn number(&self, key: &str) -> Option<u64> {
        self.text(key)?
            .parse::<u64>()
            .ok()
            .filter(|value| *value != u64::MAX)
    }

    /// A PID property; 0 means "no process".
    pub(super) fn pid(&self, key: &str) -> Option<u32> {
        self.number(key)
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid != 0)
    }

    /// A signed property such as an exit status.
    pub(super) fn signed(&self, key: &str) -> Option<i32> {
        self.text(key)?.parse().ok()
    }

    /// A space-separated list property such as `DropInPaths`.
    pub(super) fn list(&self, key: &str) -> Vec<String> {
        self.text(key)
            .map(|value| value.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// A timestamp property in Unix milliseconds. The tools run with `TZ=UTC` and
    /// `LC_ALL=C`, so systemd prints `Fri 2026-11-06 11:13:54 UTC`.
    pub(super) fn timestamp_ms(&self, key: &str) -> Option<u64> {
        let text = self.text(key)?;
        let local = text.strip_suffix(" UTC")?;
        let time = jiff::civil::DateTime::strptime("%a %Y-%m-%d %H:%M:%S", local).ok()?;
        let zoned = time.to_zoned(jiff::tz::TimeZone::UTC).ok()?;
        u64::try_from(zoned.timestamp().as_millisecond()).ok()
    }

    /// A `CLOCK_MONOTONIC` point such as `NextElapseUSecMonotonic` in microseconds.
    ///
    /// `show` prints these as time spans since boot (`5month 2w 4d 10h 59min 4.344391s`),
    /// not as numbers, so they are parsed back. `0` and `infinity` mean "none".
    pub(super) fn monotonic_us(&self, key: &str) -> Option<u64> {
        parse_timespan_us(&self.text(key)?).filter(|value| *value != 0)
    }

    /// The next elapse of a timer in Unix milliseconds: the earlier of its calendar elapse
    /// and its monotonic one moved onto the wall clock, like `systemctl list-timers` does.
    pub(super) fn next_elapse_ms(&self, clocks: Clocks) -> Option<u64> {
        let realtime = self.timestamp_ms("NextElapseUSecRealtime");
        let monotonic = self
            .monotonic_us("NextElapseUSecMonotonic")
            .map(|monotonic| clocks.realtime_ms(monotonic));
        match (realtime, monotonic) {
            (Some(realtime), Some(monotonic)) => Some(realtime.min(monotonic)),
            (realtime, monotonic) => realtime.or(monotonic),
        }
    }

    /// The rules of a timer as unit file lines, calendar rules first.
    ///
    /// `show` prints each rule as `{ OnCalendar=*-*-* 03:00:00 ; next_elapse=... }` or
    /// `{ OnUnitActiveUSec=1d ; next_elapse=... }`. The per-rule next elapse is dropped (the
    /// timer's own next elapse already is the earliest), and the bus spelling `...USec` of
    /// monotonic rules becomes the `...Sec` users write in unit files.
    pub(super) fn timer_schedules(&self) -> Vec<String> {
        self.values("TimersCalendar")
            .iter()
            .chain(self.values("TimersMonotonic"))
            .filter_map(|entry| timer_rule(entry))
            .collect()
    }

    /// The status page's view of a timer unit.
    pub(super) fn timer_info(&self, clocks: Clocks) -> SystemdTimerInfo {
        SystemdTimerInfo {
            triggers: self.list("Triggers"),
            next_elapse_ms: self.next_elapse_ms(clocks),
            last_trigger_ms: self.timestamp_ms("LastTriggerUSec"),
            schedules: self.timer_schedules(),
            persistent: self.flag("Persistent"),
        }
    }

    /// The unit list's view of a timer unit.
    pub(super) fn timer_summary(&self, clocks: Clocks) -> SystemdTimerSummary {
        SystemdTimerSummary {
            next_elapse_ms: self.next_elapse_ms(clocks),
            last_trigger_ms: self.timestamp_ms("LastTriggerUSec"),
            triggers: self.list("Triggers"),
        }
    }
}

/// One timer rule from a `TimersCalendar` or `TimersMonotonic` line, as a unit file line.
///
/// Splits at the last `; next_elapse=` so a rule value is never cut, and accepts a line
/// without braces or without the next elapse part in case a version prints it differently.
fn timer_rule(entry: &str) -> Option<String> {
    let entry = entry.trim();
    let entry = entry.strip_prefix('{').unwrap_or(entry);
    let entry = entry.strip_suffix('}').unwrap_or(entry).trim();
    let rule = entry
        .rsplit_once("; next_elapse=")
        .map_or(entry, |(rule, _)| rule)
        .trim();
    let (base, value) = rule.split_once('=')?;
    let base = base.trim();
    if base.is_empty() {
        return None;
    }
    let base = match base.strip_suffix("USec") {
        Some(stem) if base.starts_with("On") => format!("{stem}Sec"),
        _ => base.to_string(),
    };
    Some(format!("{base}={}", value.trim()))
}

/// Parses a time span as systemd formats it (`1d 2h 3min 4.5s`, `500ms`, `0`) into
/// microseconds; `None` for `infinity` and anything unrecognized.
///
/// The unit lengths are systemd's own: a month is 30.44 days and a year 365.25 days.
pub(super) fn parse_timespan_us(text: &str) -> Option<u64> {
    const SECOND: u128 = 1_000_000;
    let text = text.trim();
    if text == "0" {
        return Some(0);
    }
    let mut total: u128 = 0;
    let mut tokens = 0;
    for token in text.split_whitespace() {
        let split = token
            .find(|character: char| !(character.is_ascii_digit() || character == '.'))
            .unwrap_or(token.len());
        let (number, suffix) = token.split_at(split);
        let unit: u128 = match suffix {
            "y" | "year" | "years" => 31_557_600 * SECOND,
            "M" | "month" | "months" => 2_629_800 * SECOND,
            "w" | "week" | "weeks" => 604_800 * SECOND,
            "d" | "day" | "days" => 86_400 * SECOND,
            "h" | "hr" | "hour" | "hours" => 3_600 * SECOND,
            "m" | "min" | "minute" | "minutes" => 60 * SECOND,
            "s" | "sec" | "second" | "seconds" => SECOND,
            "ms" | "msec" => 1_000,
            "us" | "usec" | "µs" | "μs" => 1,
            _ => return None,
        };
        let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
        if whole.is_empty() || fraction.len() > 9 {
            return None;
        }
        let whole: u128 = whole.parse().ok()?;
        let fraction_value: u128 = if fraction.is_empty() {
            0
        } else {
            fraction.parse().ok()?
        };
        let scale = 10u128.pow(u32::try_from(fraction.len()).ok()?);
        total = total.checked_add(whole.checked_mul(unit)? + fraction_value * unit / scale)?;
        tokens += 1;
    }
    if tokens == 0 {
        return None;
    }
    u64::try_from(total).ok()
}

/// The device's wall clock and `CLOCK_MONOTONIC` read at one moment.
///
/// systemd reports monotonic timer elapses relative to `CLOCK_MONOTONIC`, which only this
/// device knows, so the agent converts them to Unix time with the current offset between
/// the two clocks, as `systemctl list-timers` does. The UI then gets plain timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Clocks {
    /// `CLOCK_REALTIME` in microseconds since the Unix epoch.
    pub(super) realtime_us: u64,
    /// `CLOCK_MONOTONIC` in microseconds, the clock systemd's monotonic properties use.
    pub(super) monotonic_us: u64,
}

impl Clocks {
    /// Reads both clocks back to back. Falls back to zero for a clock that cannot be read,
    /// which only skews the conversion instead of failing the request.
    pub(super) fn now() -> Self {
        let read = |clock| {
            nix::time::clock_gettime(clock).map_or(0, |time| {
                let micros =
                    i128::from(time.tv_sec()) * 1_000_000 + i128::from(time.tv_nsec()) / 1_000;
                u64::try_from(micros).unwrap_or(0)
            })
        };
        Self {
            realtime_us: read(nix::time::ClockId::CLOCK_REALTIME),
            monotonic_us: read(nix::time::ClockId::CLOCK_MONOTONIC),
        }
    }

    /// Moves a `CLOCK_MONOTONIC` point onto the wall clock, in Unix milliseconds. Points in
    /// the past (a timer that is overdue) convert the same way.
    pub(super) fn realtime_ms(self, monotonic_us: u64) -> u64 {
        let realtime_us =
            i128::from(self.realtime_us) + i128::from(monotonic_us) - i128::from(self.monotonic_us);
        u64::try_from(realtime_us.max(0) / 1_000).unwrap_or(u64::MAX)
    }
}

/// Parses `systemd-analyze unit-paths`: one directory per line.
pub(super) fn parse_unit_paths(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .collect()
}

/// The unit a process runs in, from its cgroup path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CgroupUnit {
    /// UID of the user manager that owns the unit; `None` for the system manager.
    pub(super) user_uid: Option<u32>,
    pub(super) unit: String,
}

/// Finds the service or scope a process runs in from `/proc/<pid>/cgroup`.
///
/// Uses the unified hierarchy line (`0::/...`) and falls back to the legacy `name=systemd`
/// one. A path below `user@<uid>.service` belongs to that user's manager. Only the last path
/// component counts, and only when it is a service or scope, because those are what stopping
/// would take the agent down with.
pub(super) fn parse_cgroup(text: &str) -> Option<CgroupUnit> {
    let path = text
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .or_else(|| {
            text.lines()
                .find_map(|line| line.split_once(":name=systemd:").map(|(_, path)| path))
        })?;
    let components: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let unit = *components.last()?;
    if !(unit.ends_with(".service") || unit.ends_with(".scope")) {
        return None;
    }
    let user_uid = components.iter().find_map(|component| {
        component
            .strip_prefix("user@")?
            .strip_suffix(".service")?
            .parse()
            .ok()
    });
    if unit == "init.scope" || unit.starts_with("user@") {
        // A manager process itself (PID 1 or a user's `systemd --user`), not a unit anyone
        // would stop.
        return None;
    }
    validate_unit_name(unit).ok()?;
    Some(CgroupUnit {
        user_uid,
        unit: unit.to_string(),
    })
}

/// Parses one `journalctl -o json` line into an entry, or `None` for a line that is not a
/// JSON object.
///
/// Fields that hold invalid UTF-8 arrive as arrays of bytes and are decoded lossily; fields
/// that appear several times in one entry arrive as arrays of values, of which the first is
/// shown.
pub(super) fn parse_journal_line(line: &[u8]) -> Option<SystemdJournalEntry> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let fields = value.as_object()?;
    let field = |name: &str| fields.get(name).and_then(journal_field_text);
    Some(SystemdJournalEntry {
        timestamp_us: field("__REALTIME_TIMESTAMP").and_then(|text| text.parse().ok()),
        priority: field("PRIORITY").and_then(|text| text.parse().ok()),
        pid: field("_PID").and_then(|text| text.parse().ok()),
        identifier: field("SYSLOG_IDENTIFIER"),
        message: field("MESSAGE").unwrap_or_default(),
    })
}

/// The text of one journal field value: a string, a byte array, or the first of several
/// values. `null` (a field journalctl left out) has none.
fn journal_field_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(items) if items.iter().all(serde_json::Value::is_u64) => {
            let bytes: Vec<u8> = items
                .iter()
                .filter_map(|item| item.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect();
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        serde_json::Value::Array(items) => items.first().and_then(journal_field_text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies list-units rows keep descriptions with spaces and skip junk lines.
    #[test]
    fn parses_list_units() {
        let text = "\
proc-sys-fs-binfmt_misc.automount  loaded    inactive dead      Arbitrary Executable File Formats File System Automount Point
homebrew.toxiproxy.service         loaded    failed   failed    Homebrew generated unit for toxiproxy
● broken.service                   not-found inactive dead      broken.service
-.mount                            loaded    active   mounted   Root Mount

garbage
";
        let units = parse_list_units(text);
        // Junk and empty lines are dropped instead of becoming bogus units.
        assert_eq!(units.len(), 4);
        // The description keeps its inner spaces.
        assert_eq!(
            units[0].description,
            "Arbitrary Executable File Formats File System Automount Point"
        );
        assert_eq!(units[1].active_state, "failed");
        // A leading bullet from older versions is not part of the name.
        assert_eq!(units[2].name, "broken.service");
        assert_eq!(units[2].load_state, "not-found");
        // The root mount, whose name starts with '-', is listed.
        assert_eq!(units[3].name, "-.mount");
    }

    /// Verifies list-unit-files rows with and without the preset column.
    #[test]
    fn parses_list_unit_files() {
        let text = "\
dev-hugepages.mount                          static          -
getty@.service                               enabled         enabled
old.service                                  disabled
";
        // The preset column of newer versions is ignored and older two-column rows work.
        assert_eq!(
            parse_list_unit_files(text),
            [
                ("dev-hugepages.mount".to_string(), "static".to_string()),
                ("getty@.service".to_string(), "enabled".to_string()),
                ("old.service".to_string(), "disabled".to_string()),
            ]
        );
    }

    /// Verifies loaded units and unit files merge into one sorted list.
    #[test]
    fn merges_loaded_units_with_unit_files() {
        let loaded = parse_list_units(
            "b.service loaded active running B service
c.mount loaded active mounted C
",
        );
        let files = vec![
            ("a.service".to_string(), "disabled".to_string()),
            ("b.service".to_string(), "enabled".to_string()),
        ];
        let (units, truncated) = merge_units(loaded, files);
        let names: Vec<_> = units.iter().map(|unit| unit.name.as_str()).collect();
        // Every unit appears once, sorted by name.
        assert_eq!(names, ["a.service", "b.service", "c.mount"]);
        // A disabled unit that is not loaded still appears, without runtime state.
        assert_eq!(units[0].unit_file_state.as_deref(), Some("disabled"));
        assert_eq!(units[0].active_state, None);
        // A loaded unit with a file gets both.
        assert_eq!(units[1].active_state.as_deref(), Some("active"));
        assert_eq!(units[1].unit_file_state.as_deref(), Some("enabled"));
        // Loaded units without a file have no file state.
        assert_eq!(units[2].unit_file_state, None);
        assert_eq!(units[2].unit_type, "mount");
        // A short list is complete.
        assert!(!truncated);
    }

    /// Verifies the list is cut at its limit and says so.
    #[test]
    fn merged_list_is_bounded() {
        let files = (0..MAX_LISTED_UNITS + 5)
            .map(|index| (format!("u{index}.service"), "static".to_string()))
            .collect();
        let (units, truncated) = merge_units(Vec::new(), files);
        // The response is one control frame, so it must stay bounded.
        assert_eq!(units.len(), MAX_LISTED_UNITS);
        assert!(truncated);
    }

    /// Verifies which unit files a list links to.
    #[test]
    fn keeps_only_editable_fragments() {
        // Unit files users write or install are linked.
        assert_eq!(
            editable_fragment(Some("/etc/systemd/system/a.service".to_string())).as_deref(),
            Some("/etc/systemd/system/a.service")
        );
        // Transient units of the system and of a user manager have generated files that
        // vanish with the unit.
        assert_eq!(
            editable_fragment(Some("/run/systemd/transient/run-u1.service".to_string())),
            None
        );
        assert_eq!(
            editable_fragment(Some(
                "/run/user/1000/systemd/transient/app-x.scope".to_string()
            )),
            None
        );
        // Unset and relative values are no file.
        assert_eq!(editable_fragment(None), None);
        assert_eq!(editable_fragment(Some("a.service".to_string())), None);
    }

    /// Verifies the batched show only names units that can have a unit file.
    #[test]
    fn asks_systemd_only_about_units_with_files() {
        let (units, _) = merge_units(
            parse_list_units(
                "a.service loaded active running A
dev-sda.device loaded active plugged Disk
session-1.scope loaded active running Session
gone.service not-found inactive dead gone.service
off.service masked inactive dead off.service
bad.service bad-setting inactive dead Bad
",
            ),
            vec![("file-only.service".to_string(), "disabled".to_string())],
        );
        let asked: Vec<&str> = units
            .iter()
            .filter(|unit| needs_unit_properties(unit))
            .map(|unit| unit.name.as_str())
            .collect();
        // Devices, scopes, units without a file and masked units are left out; a unit
        // whose file has an error is the one most worth opening.
        assert_eq!(asked, ["a.service", "bad.service"]);
        let looked_up: Vec<&str> = units
            .iter()
            .filter(|unit| needs_search_path_lookup(unit))
            .map(|unit| unit.name.as_str())
            .collect();
        // Only unit files systemd has not loaded are looked up in the search path.
        assert_eq!(looked_up, ["file-only.service"]);
    }

    /// Verifies show properties, unset markers and timestamps.
    #[test]
    fn parses_show_properties() {
        let properties = UnitProperties::parse(
            "\
MainPID=0
ExecMainStatus=-1
MemoryCurrent=[not set]
CPUUsageNSec=18446744073709551615
TasksCurrent=22
Description=Has = signs
DropInPaths=/etc/systemd/system/a.service.d/a.conf /run/systemd/system/a.service.d/b.conf
NeedDaemonReload=yes
ActiveEnterTimestamp=Fri 2026-11-06 11:13:54 UTC
InactiveEnterTimestamp=
FragmentPath=
",
        );
        // PID 0 means no process.
        assert_eq!(properties.pid("MainPID"), None);
        assert_eq!(properties.signed("ExecMainStatus"), Some(-1));
        // Both spellings of "not set" become absent values.
        assert_eq!(properties.number("MemoryCurrent"), None);
        assert_eq!(properties.number("CPUUsageNSec"), None);
        assert_eq!(properties.number("TasksCurrent"), Some(22));
        // Values may contain '='.
        assert_eq!(
            properties.text("Description").as_deref(),
            Some("Has = signs")
        );
        assert_eq!(properties.list("DropInPaths").len(), 2);
        assert!(properties.flag("NeedDaemonReload"));
        // UTC timestamps become Unix milliseconds the UI can format.
        assert_eq!(
            properties.timestamp_ms("ActiveEnterTimestamp"),
            Some(1_793_963_634_000)
        );
        // Empty values are absent.
        assert_eq!(properties.timestamp_ms("InactiveEnterTimestamp"), None);
        assert_eq!(properties.text("FragmentPath"), None);
    }

    /// Verifies systemd's time span format, including the units of monotonic timestamps.
    #[test]
    fn parses_timespans() {
        // A boot-relative timestamp as `show` prints NextElapseUSecMonotonic, with systemd's
        // month (30.44 days) and microseconds after the dot.
        assert_eq!(
            parse_timespan_us("5month 2w 4d 10h 59min 4.344391s"),
            Some(
                5 * 2_629_800_000_000
                    + 2 * 604_800_000_000
                    + 4 * 86_400_000_000
                    + 10 * 3_600_000_000
                    + 59 * 60_000_000
                    + 4_344_391
            )
        );
        // Short fractions and sub-second units keep their exact value.
        assert_eq!(parse_timespan_us("1.5s"), Some(1_500_000));
        assert_eq!(
            parse_timespan_us("1y 500ms 3us"),
            Some(31_557_600_000_000 + 500_003)
        );
        // Zero is a value of its own, which callers read as "none".
        assert_eq!(parse_timespan_us("0"), Some(0));
        // The "never" sentinel, unset values and unknown units are not times.
        assert_eq!(parse_timespan_us("infinity"), None);
        assert_eq!(parse_timespan_us(""), None);
        assert_eq!(parse_timespan_us("n/a"), None);
        assert_eq!(parse_timespan_us("5 parsecs"), None);
        assert_eq!(parse_timespan_us("12"), None);
    }

    /// Verifies monotonic points move onto the wall clock with the clocks' current offset.
    #[test]
    fn converts_monotonic_points_to_wall_clock() {
        let clocks = Clocks {
            realtime_us: 1_793_963_634_000_000,
            monotonic_us: 1_000_000_000,
        };
        // A point one hour after the current monotonic time is one hour after now.
        assert_eq!(
            clocks.realtime_ms(1_000_000_000 + 3_600_000_000),
            1_793_963_634_000 + 3_600_000
        );
        // An overdue point lies in the past instead of wrapping around.
        assert_eq!(clocks.realtime_ms(400_000_000), 1_793_963_634_000 - 600_000);
        // A point before the epoch (nonsense clocks) is clamped, not wrapped.
        assert_eq!(
            Clocks {
                realtime_us: 0,
                monotonic_us: 10_000_000
            }
            .realtime_ms(0),
            0
        );
        // The real clocks are readable, so conversions are not all anchored at zero.
        let now = Clocks::now();
        assert!(now.realtime_us > 1_700_000_000_000_000);
        assert!(now.monotonic_us > 0);
    }

    /// Verifies a timer with calendar and monotonic rules, as `show` prints it on 255.
    #[test]
    fn parses_timer_properties() {
        let clocks = Clocks {
            realtime_us: 1_793_963_634_000_000,
            monotonic_us: 2_000_000_000,
        };
        let properties = UnitProperties::parse(
            "\
Triggers=backup.service
TimersCalendar={ OnCalendar=*-*-* 06,18:00:00 ; next_elapse=Fri 2026-11-06 18:00:00 UTC }
TimersCalendar={ OnCalendar=Mon..Fri *-*-* 03:00:00 Europe/Helsinki ; next_elapse=Mon 2026-11-09 01:00:00 UTC }
TimersMonotonic={ OnUnitActiveUSec=1d ; next_elapse=1d 33s }
TimersMonotonic={ OnBootUSec=15min ; next_elapse=15min }
NextElapseUSecRealtime=Fri 2026-11-06 18:00:00 UTC
NextElapseUSecMonotonic=1h 33min 20s
LastTriggerUSec=Fri 2026-11-06 11:13:54 UTC
Persistent=yes
",
        );
        let info = properties.timer_info(clocks);
        // Every rule of both kinds is kept, calendar first, written as in a unit file.
        assert_eq!(
            info.schedules,
            [
                "OnCalendar=*-*-* 06,18:00:00",
                "OnCalendar=Mon..Fri *-*-* 03:00:00 Europe/Helsinki",
                "OnUnitActiveSec=1d",
                "OnBootSec=15min",
            ]
        );
        assert_eq!(info.triggers, ["backup.service"]);
        // The monotonic elapse, an hour from now, is earlier than the calendar one at 18:00,
        // so it is the next run.
        assert_eq!(info.next_elapse_ms, Some(1_793_963_634_000 + 3_600_000));
        assert_eq!(info.last_trigger_ms, Some(1_793_963_634_000));
        assert!(info.persistent);
    }

    /// Verifies timers without a schedule, as `show` prints a finished or idle timer.
    #[test]
    fn parses_unscheduled_timers() {
        let clocks = Clocks::now();
        for text in [
            // systemd 255: no realtime elapse is empty and no monotonic one is 0.
            "NextElapseUSecRealtime=
NextElapseUSecMonotonic=0
LastTriggerUSec=
Persistent=no
Triggers=
",
            // A timer systemd does not know prints infinity; older versions print n/a.
            "NextElapseUSecRealtime=n/a
NextElapseUSecMonotonic=infinity
LastTriggerUSec=n/a
",
            // Nothing printed at all.
            "",
        ] {
            let info = properties_timer(text, clocks);
            // Unset values are absent, not the epoch or the far future.
            assert_eq!(info.next_elapse_ms, None, "{text}");
            assert_eq!(info.last_trigger_ms, None, "{text}");
            // A timer without rules or targets has empty lists.
            assert!(info.schedules.is_empty(), "{text}");
            assert!(info.triggers.is_empty(), "{text}");
            assert!(!info.persistent, "{text}");
        }
        let calendar_only = properties_timer(
            "NextElapseUSecRealtime=Fri 2026-11-06 18:00:00 UTC
NextElapseUSecMonotonic=0
",
            clocks,
        );
        // A calendar-only timer runs at its calendar elapse.
        assert_eq!(calendar_only.next_elapse_ms, Some(1_793_988_000_000));
    }

    /// Parses `text` as one unit's properties and reads it as a timer.
    fn properties_timer(text: &str, clocks: Clocks) -> SystemdTimerInfo {
        UnitProperties::parse(text).timer_info(clocks)
    }

    /// Verifies timer rule lines that differ from the usual format.
    #[test]
    fn parses_unusual_timer_rules() {
        // A rule without the next elapse part is still a rule.
        assert_eq!(
            timer_rule("{ OnActiveUSec=1h }").as_deref(),
            Some("OnActiveSec=1h")
        );
        // Only the last next_elapse part is cut off.
        assert_eq!(
            timer_rule("{ OnCalendar=a ; next_elapse=b ; next_elapse=c }").as_deref(),
            Some("OnCalendar=a ; next_elapse=b")
        );
        // Lines without a rule are dropped.
        assert_eq!(timer_rule("{ }"), None);
        assert_eq!(timer_rule("garbage"), None);
    }

    /// Verifies trigger lists and the blocks of a multi-unit `show`.
    #[test]
    fn parses_trigger_lists_and_unit_blocks() {
        let units = UnitProperties::parse_units(
            "\
Id=a.timer
Triggers=a.service
NextElapseUSecMonotonic=0

Id=b.timer
Triggers=b.service other.target
LastTriggerUSec=Fri 2026-11-06 11:13:54 UTC

",
        );
        // Each unit's block is read on its own, in the order systemctl printed them.
        assert_eq!(units.len(), 2);
        assert_eq!(units[0].text("Id").as_deref(), Some("a.timer"));
        assert_eq!(units[0].list("Triggers"), ["a.service"]);
        // A timer may activate several units.
        assert_eq!(units[1].list("Triggers"), ["b.service", "other.target"]);
        // Properties never leak between blocks.
        assert_eq!(units[0].timestamp_ms("LastTriggerUSec"), None);
        assert_eq!(
            units[1].timer_summary(Clocks::now()).last_trigger_ms,
            Some(1_793_963_634_000)
        );
        let service = UnitProperties::parse(
            "TriggeredBy=a.timer a.socket
",
        );
        // Everything that activates a service is listed.
        assert_eq!(service.list("TriggeredBy"), ["a.timer", "a.socket"]);
        // An empty TriggeredBy means nothing activates the unit.
        assert!(
            UnitProperties::parse(
                "TriggeredBy=
"
            )
            .list("TriggeredBy")
            .is_empty()
        );
    }

    /// Verifies unit-paths output keeps only directories.
    #[test]
    fn parses_unit_paths() {
        // Blank and non-path lines are ignored.
        assert_eq!(
            parse_unit_paths(
                "/etc/systemd/system

/usr/lib/systemd/system
noise
"
            ),
            [
                PathBuf::from("/etc/systemd/system"),
                PathBuf::from("/usr/lib/systemd/system")
            ]
        );
    }

    /// Verifies the agent's own unit is found in system and user managers.
    #[test]
    fn parses_cgroups() {
        // A system service.
        assert_eq!(
            parse_cgroup("0::/system.slice/redoor.service"),
            Some(CgroupUnit {
                user_uid: None,
                unit: "redoor.service".to_string()
            })
        );
        // A user service belongs to the user manager of that UID.
        assert_eq!(
            parse_cgroup(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/redoor-dev.service"
            ),
            Some(CgroupUnit {
                user_uid: Some(1000),
                unit: "redoor-dev.service".to_string()
            })
        );
        // A login session scope is a system unit.
        assert_eq!(
            parse_cgroup("0::/user.slice/user-1000.slice/session-3.scope"),
            Some(CgroupUnit {
                user_uid: None,
                unit: "session-3.scope".to_string()
            })
        );
        // Legacy hierarchies use the name=systemd line.
        assert_eq!(
            parse_cgroup(
                "12:cpu:/
1:name=systemd:/system.slice/redoor.service
"
            )
            .map(|unit| unit.unit),
            Some("redoor.service".to_string())
        );
        // A process outside any service or scope (containers, init) has no unit.
        assert_eq!(parse_cgroup("0::/"), None);
        // A user manager's own process is not a unit of that manager.
        assert_eq!(
            parse_cgroup("0::/user.slice/user-1000.slice/user@1000.service/init.scope"),
            None
        );
    }

    /// Verifies journal JSON lines, including byte-array and repeated fields.
    #[test]
    fn parses_journal_lines() {
        let entry = parse_journal_line(
            br#"{"__REALTIME_TIMESTAMP":"1793968302203655","PRIORITY":"6","_PID":"42","SYSLOG_IDENTIFIER":"redoor","MESSAGE":"hello","__CURSOR":"s=1"}"#,
        )
        .unwrap();
        // Every shown field is decoded from journald's string encoding.
        assert_eq!(
            entry,
            SystemdJournalEntry {
                timestamp_us: Some(1_793_968_302_203_655),
                priority: Some(6),
                pid: Some(42),
                identifier: Some("redoor".to_string()),
                message: "hello".to_string(),
            }
        );
        let binary = parse_journal_line(br#"{"MESSAGE":[104,105,255]}"#).unwrap();
        // Invalid UTF-8 arrives as bytes and is shown lossily instead of being dropped.
        assert_eq!(binary.message, "hi\u{fffd}");
        let repeated = parse_journal_line(br#"{"MESSAGE":["first","second"]}"#).unwrap();
        // A field written twice shows its first value.
        assert_eq!(repeated.message, "first");
        let missing = parse_journal_line(br#"{"MESSAGE":null,"PRIORITY":"x"}"#).unwrap();
        // Values journalctl left out, or that do not parse, are absent.
        assert_eq!(missing.message, "");
        assert_eq!(missing.priority, None);
        // Lines that are not JSON objects are skipped.
        assert_eq!(parse_journal_line(b"not json"), None);
        assert_eq!(parse_journal_line(b"[1]"), None);
    }
}
