//! Systemd unit management: unit lists and status, unit actions, daemon-reload, linger, the
//! managers a file belongs to, and unit journals.
//!
//! The agent runs `systemctl`, `journalctl`, `loginctl` and `systemd-analyze` instead of
//! speaking D-Bus: the tools are on every systemd host, add no dependency, and reaching
//! another user's manager as root needs only the user's UID and runtime directory, not the
//! bus policy of that user's session. Trust rules live in [`scope`], process handling in
//! [`process`], output parsing in [`parse`] and the journal stream in [`journal`].

mod journal;
mod parse;
mod process;
mod scope;

use super::search_stream::SearchStream;
use crate::commands::ctx::{OutputLane, Reply};
use parse::{Clocks, UnitProperties, merge_units, parse_list_unit_files, parse_list_units};
use process::SystemdTool;
use redoor_core::log;
use redoor_protocol::{
    api::systemd::{
        MAX_JOURNAL_LINES, SystemdAgentUnit, SystemdLingerResponse, SystemdOverviewResponse,
        SystemdPathMatch, SystemdPathStatusResponse, SystemdPathUnitState, SystemdScope,
        SystemdSupport, SystemdUnitAction, SystemdUnitDetailsResponse, SystemdUnitListResponse,
        SystemdUnitSummary, SystemdUserSummary,
    },
    wire::{
        command::CommandErrorKind,
        log::Level,
        request::{self, CommandError},
    },
};
use scope::{Access, Account, AgentAccount, Manager, is_template, unit_type, validate_unit_name};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// Properties `systemctl show` reads for a unit's status page. The timer properties are
/// only printed for `.timer` units, so asking for them always costs nothing elsewhere.
const DETAIL_PROPERTIES: &str = "Id,Description,LoadState,ActiveState,SubState,UnitFileState,UnitFilePreset,FragmentPath,DropInPaths,NeedDaemonReload,MainPID,ExecMainStatus,Result,ActiveEnterTimestamp,InactiveEnterTimestamp,MemoryCurrent,CPUUsageNSec,TasksCurrent,CanReload,TriggeredBy,Triggers,TimersCalendar,TimersMonotonic,NextElapseUSecRealtime,NextElapseUSecMonotonic,LastTriggerUSec,Persistent";
/// Properties one `systemctl show` reads for the loaded units of a unit list: every unit's
/// file, plus the schedule of timers. The timer properties are only printed for `.timer`
/// units, so the other units cost one line more each.
const UNIT_LIST_PROPERTIES: &str =
    "Id,FragmentPath,Triggers,NextElapseUSecRealtime,NextElapseUSecMonotonic,LastTriggerUSec";
/// Most units one `systemctl show` run of a unit list names, so even a pathological host
/// with thousands of units stays far below the kernel's argument size limit.
const UNITS_PER_SHOW: usize = 1000;
/// Lowest UID of regular accounts on Linux distributions (`UID_MIN`), which the root agent
/// lists as users even when their manager does not run.
const FIRST_REGULAR_UID: u32 = 1000;
/// `nobody`, which has a high UID but is no person.
const NOBODY_UID: u32 = 65534;
/// Most accounts in the overview's user list, which is one control frame.
const MAX_LISTED_USERS: usize = 1000;

/// Whether this host runs systemd, decided once at startup like the trash provider, and the
/// entry point of every systemd command.
#[derive(Debug, Clone)]
pub(crate) struct Systemd {
    support: SystemdSupport,
}

impl Systemd {
    /// Decides whether the host runs systemd with the check of `sd_booted()`: systemd creates
    /// `/run/systemd/system` when it boots as PID 1. Containers and other init systems lack
    /// it even when the tools are installed, and their `systemctl` could not talk to any
    /// manager.
    pub(crate) async fn detect() -> Self {
        let support = if cfg!(target_os = "macos") {
            unavailable("macOS uses launchd, not systemd")
        } else if cfg!(target_os = "android") {
            unavailable("Android (Termux) does not use systemd")
        } else if !cfg!(target_os = "linux") {
            unavailable("This operating system does not use systemd")
        } else if tokio::fs::metadata("/run/systemd/system")
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            SystemdSupport::Available
        } else {
            unavailable(
                "This device was not booted with systemd, for example a container or a host with another init system",
            )
        };
        if let SystemdSupport::Unavailable { reason } = &support {
            log!(Level::Info, "Systemd is not available: {reason}");
        }
        Self { support }
    }

    /// A host without systemd, for tests that build agent services without detection.
    #[cfg(test)]
    pub(crate) fn unsupported() -> Self {
        Self {
            support: unavailable("Systemd support was not detected"),
        }
    }

    /// What the agent reports in its `hello`.
    pub(crate) fn support(&self) -> &SystemdSupport {
        &self.support
    }

    /// Refuses every systemd command on a host without systemd with a typed error, so the
    /// UI explains it instead of showing a tool failure.
    fn require(&self) -> Result<(), CommandError> {
        match &self.support {
            SystemdSupport::Available => Ok(()),
            SystemdSupport::Unavailable { reason } => Err(CommandError::new(
                CommandErrorKind::SystemdUnsupported,
                format!("This device does not use systemd: {reason}"),
            )),
        }
    }

    /// The agent account, its own manager and unit, and (for root) the other accounts.
    pub(crate) async fn overview(&self) -> Result<SystemdOverviewResponse, CommandError> {
        self.require()?;
        let agent = AgentAccount::current().await?;
        let own = &agent.account;
        let (user_manager_running, linger, agent_unit) =
            tokio::join!(own.manager_running(), own.linger(), agent_unit());
        let (users, users_truncated) = if agent.is_root {
            list_users().await?
        } else {
            (Vec::new(), false)
        };
        Ok(SystemdOverviewResponse {
            username: own.name.clone(),
            uid: own.uid,
            is_root: agent.is_root,
            user_manager_running,
            linger,
            agent_unit,
            users,
            users_truncated,
        })
    }

    /// Every unit of one manager: loaded units merged with installed unit files.
    pub(crate) async fn list_units(
        &self,
        scope: &SystemdScope,
        cancel: &CancellationToken,
    ) -> Result<SystemdUnitListResponse, CommandError> {
        let (agent, manager) = self.manager(scope, Access::Read).await?;
        manager.require_running().await?;
        let list = SystemdTool::systemctl(&manager).args([
            "list-units",
            "--all",
            "--plain",
            "--no-legend",
            "--full",
        ]);
        let files = SystemdTool::systemctl(&manager).args([
            "list-unit-files",
            "--plain",
            "--no-legend",
            "--full",
        ]);
        // Each tool run is a large future; boxed, the three running side by side do not
        // multiply the size of the agent's command future, which debug builds copy around
        // on the worker's stack.
        let (loaded, files, search_path) = tokio::try_join!(
            Box::pin(list.run(cancel)),
            Box::pin(files.run(cancel)),
            Box::pin(unit_search_path(&manager, cancel))
        )?;
        let (mut units, truncated) = merge_units(
            parse_list_units(&loaded.stdout),
            parse_list_unit_files(&files.stdout),
        );
        add_unit_properties(&manager, &mut units, cancel).await?;
        if let Some(search_path) = search_path {
            add_unloaded_fragments(&mut units, &search_path).await;
        }
        Ok(SystemdUnitListResponse {
            scope: manager.scope(),
            units,
            truncated: truncated || loaded.stdout_truncated || files.stdout_truncated,
            can_manage: manager.can_manage(&agent),
        })
    }

    /// The status of one unit.
    pub(crate) async fn unit_details(
        &self,
        scope: &SystemdScope,
        unit: &str,
        cancel: &CancellationToken,
    ) -> Result<SystemdUnitDetailsResponse, CommandError> {
        validate_unit_name(unit)?;
        let (agent, manager) = self.manager(scope, Access::Read).await?;
        manager.require_running().await?;
        details(&agent, &manager, unit, cancel).await
    }

    /// Runs one action on a unit, waiting for its systemd job, and answers with the unit's
    /// status afterwards so the UI shows the outcome without another round trip.
    pub(crate) async fn unit_action(
        &self,
        scope: &SystemdScope,
        unit: &str,
        action: SystemdUnitAction,
        cancel: &CancellationToken,
    ) -> Result<SystemdUnitDetailsResponse, CommandError> {
        validate_unit_name(unit)?;
        let (agent, manager) = self.manager(scope, Access::Manage).await?;
        manager.require_running().await?;
        SystemdTool::systemctl(&manager)
            .args([action.verb(), "--", unit])
            .run(cancel)
            .await?;
        log!(
            Level::Info,
            "Systemd unit action finished: scope={} unit={} action={}",
            manager.scope(),
            unit,
            action.verb()
        );
        details(&agent, &manager, unit, cancel).await
    }

    /// Makes one manager reload its unit files.
    pub(crate) async fn daemon_reload(
        &self,
        scope: &SystemdScope,
        cancel: &CancellationToken,
    ) -> Result<(), CommandError> {
        let (_, manager) = self.manager(scope, Access::Manage).await?;
        manager.require_running().await?;
        SystemdTool::systemctl(&manager)
            .args(["daemon-reload"])
            .run(cancel)
            .await?;
        Ok(())
    }

    /// Enables or disables linger for an account through logind.
    ///
    /// Linger belongs to an account, not a manager, but follows the same rule: a non-root
    /// agent may only change its own (where polkit decides), root may change anyone's.
    pub(crate) async fn set_linger(
        &self,
        user: &str,
        enabled: bool,
        cancel: &CancellationToken,
    ) -> Result<SystemdLingerResponse, CommandError> {
        let scope = SystemdScope::User {
            name: user.to_string(),
        };
        let (_, manager) = self.manager(&scope, Access::Manage).await?;
        let Manager::User { account, .. } = manager else {
            return Err(CommandError::new(
                CommandErrorKind::Internal,
                "Linger resolved to the system manager",
            ));
        };
        let verb = if enabled {
            "enable-linger"
        } else {
            "disable-linger"
        };
        SystemdTool::loginctl()
            .args([verb, "--", account.name.as_str()])
            .run(cancel)
            .await?;
        Ok(SystemdLingerResponse {
            linger: account.linger().await,
            user: account.name,
        })
    }

    /// Which managers' unit search paths contain `path`, the unit it defines and whether a
    /// daemon-reload is due for it.
    ///
    /// Checks the system manager and one user manager: `user`'s when the caller names it,
    /// because shared root-owned files such as `/usr/lib/systemd/user/*` belong to every
    /// user's manager and only the caller knows which user's unit it came from. Otherwise the
    /// agent's own, or for a root agent the file's owner (the parent directory's owner for a
    /// file that does not exist yet), since that is whose manager loads files below a home
    /// directory. A named user goes through the same trust rules as the unit lists.
    pub(crate) async fn path_status(
        &self,
        path: &str,
        user: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<SystemdPathStatusResponse, CommandError> {
        self.require()?;
        let file = Path::new(path);
        if !file.is_absolute() {
            return Err(CommandError::new(
                CommandErrorKind::InvalidInput,
                "The path must be absolute",
            ));
        }
        let agent = AgentAccount::current().await?;
        let mut managers = vec![Manager::System];
        if let Some(name) = user {
            let scope = SystemdScope::User {
                name: name.to_string(),
            };
            managers.push(Manager::resolve(&scope, Access::Read, &agent).await?);
        } else if let Some(account) = path_user(&agent, file).await? {
            managers.push(Manager::User {
                switch_user: account.uid != agent.account.uid,
                account,
            });
        }
        let mut matches = Vec::new();
        for manager in managers {
            if let Some(found) = path_match(&agent, &manager, file, cancel).await? {
                matches.push(found);
            }
        }
        Ok(SystemdPathStatusResponse {
            path: path.to_string(),
            matches,
        })
    }

    /// Streams a unit's journal on the request's output stream.
    pub(crate) async fn journal(
        &self,
        request: request::SystemdJournal,
        output: OutputLane,
    ) -> Reply {
        let OutputLane {
            stream,
            registration,
            ..
        } = output;
        let cancel = registration.token().clone();
        let mut search = SearchStream::new(stream, &cancel, "Journal");
        let result = match self.journal_plan(&request).await {
            Ok((tool, access_problem)) => journal::stream(&mut search, tool, access_problem).await,
            Err(error) => Err(error),
        };
        // Unregistered before the result, so a late cancel finds nothing to stop.
        drop(registration);
        Reply::stream::<request::SystemdJournal>(search.into_writer(), result)
    }

    /// Validates a journal request and builds its `journalctl` run, plus the access note a
    /// non-root agent gets for system units.
    async fn journal_plan(
        &self,
        request: &request::SystemdJournal,
    ) -> Result<(SystemdTool, Option<String>), CommandError> {
        validate_unit_name(&request.unit)?;
        if request.lines > MAX_JOURNAL_LINES {
            return Err(CommandError::new(
                CommandErrorKind::InvalidInput,
                format!("At most {MAX_JOURNAL_LINES} journal lines can be requested"),
            ));
        }
        let (agent, manager) = self.manager(&request.scope, Access::Read).await?;
        let access_problem = if manager == Manager::System && !agent.is_root {
            journal::system_journal_access_problem().await
        } else {
            None
        };
        Ok((
            journal::journal_tool(&manager, &request.unit, request.lines),
            access_problem,
        ))
    }

    /// Checks support, then resolves and authorizes the requested manager.
    async fn manager(
        &self,
        scope: &SystemdScope,
        access: Access,
    ) -> Result<(AgentAccount, Manager), CommandError> {
        self.require()?;
        let agent = AgentAccount::current().await?;
        let manager = Manager::resolve(scope, access, &agent).await?;
        Ok((agent, manager))
    }
}

/// The unsupported state with a reason.
fn unavailable(reason: &str) -> SystemdSupport {
    SystemdSupport::Unavailable {
        reason: reason.to_string(),
    }
}

/// Reads one unit's status properties into the details response.
async fn details(
    agent: &AgentAccount,
    manager: &Manager,
    unit: &str,
    cancel: &CancellationToken,
) -> Result<SystemdUnitDetailsResponse, CommandError> {
    if is_template(unit) {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!(
                "{unit} is a template; only its instances, such as {}, have a status",
                unit.replacen("@.", "@name.", 1)
            ),
        ));
    }
    let show = SystemdTool::systemctl(manager).args(["show", "-p", DETAIL_PROPERTIES, "--", unit]);
    let (output, own_unit) = tokio::join!(show.run(cancel), agent_unit());
    let properties = UnitProperties::parse(&output?.stdout);
    let id = properties.text("Id").unwrap_or_else(|| unit.to_string());
    let scope = manager.scope();
    let is_agent_unit = own_unit.is_some_and(|own| own.scope == scope && own.unit == id);
    // A timer name systemd does not know has only default values, not a schedule.
    let timer = (unit_type(&id) == "timer"
        && properties.text("LoadState").as_deref() != Some("not-found"))
    .then(|| properties.timer_info(Clocks::now()));
    Ok(SystemdUnitDetailsResponse {
        description: properties.text("Description"),
        load_state: properties.text("LoadState"),
        active_state: properties.text("ActiveState"),
        sub_state: properties.text("SubState"),
        unit_file_state: properties.text("UnitFileState"),
        unit_file_preset: properties.text("UnitFilePreset"),
        fragment_path: properties.text("FragmentPath"),
        drop_in_paths: properties.list("DropInPaths"),
        need_daemon_reload: properties.flag("NeedDaemonReload"),
        main_pid: properties.pid("MainPID"),
        exec_main_status: properties.signed("ExecMainStatus"),
        result: properties.text("Result"),
        active_enter_timestamp_ms: properties.timestamp_ms("ActiveEnterTimestamp"),
        inactive_enter_timestamp_ms: properties.timestamp_ms("InactiveEnterTimestamp"),
        memory_current_bytes: properties.number("MemoryCurrent"),
        cpu_usage_nsec: properties.number("CPUUsageNSec"),
        tasks_current: properties.number("TasksCurrent"),
        can_reload: properties.flag("CanReload"),
        can_manage: manager.can_manage(agent),
        is_agent_unit,
        timer,
        triggered_by: properties.list("TriggeredBy"),
        id,
        scope,
    })
}

/// Fills in the unit file of every loaded unit and the schedule of every loaded timer in a
/// unit list with one `systemctl show` run (one per [`UNITS_PER_SHOW`] units), so the list
/// can link units to their files and show when timers run without the UI asking for each
/// unit's details.
///
/// Both are extras on top of the list: when the run fails (other than by being canceled),
/// the units are listed without them instead of failing the whole list.
async fn add_unit_properties(
    manager: &Manager,
    units: &mut [SystemdUnitSummary],
    cancel: &CancellationToken,
) -> Result<(), CommandError> {
    let names: Vec<String> = units
        .iter()
        .filter(|unit| parse::needs_unit_properties(unit))
        .map(|unit| unit.name.clone())
        .collect();
    let mut found = HashMap::new();
    for chunk in names.chunks(UNITS_PER_SHOW) {
        let output = match SystemdTool::systemctl(manager)
            .args(["show", "-p", UNIT_LIST_PROPERTIES, "--"])
            .args(chunk)
            .run(cancel)
            .await
        {
            Ok(output) => output,
            Err(error) if error.kind == CommandErrorKind::Canceled => return Err(error),
            Err(error) => {
                log!(
                    Level::Debug,
                    "Reading systemd unit files and timer schedules failed: scope={} error={}",
                    manager.scope(),
                    error.message
                );
                return Ok(());
            }
        };
        let clocks = Clocks::now();
        for properties in UnitProperties::parse_units(&output.stdout) {
            if let Some(id) = properties.text("Id") {
                let timer = (unit_type(&id) == "timer").then(|| properties.timer_summary(clocks));
                found.insert(
                    id,
                    (
                        parse::editable_fragment(properties.text("FragmentPath")),
                        timer,
                    ),
                );
            }
        }
    }
    for unit in units {
        if let Some((fragment_path, timer)) = found.remove(&unit.name) {
            unit.fragment_path = fragment_path;
            // Only a timer systemd loaded cleanly has a schedule worth showing.
            if unit.load_state.as_deref() == Some("loaded") {
                unit.timer = timer;
            }
        }
    }
    Ok(())
}

/// Finds the files of installed units systemd has not loaded by looking their names up in
/// the manager's unit search path, first directory first, the way systemd itself would.
///
/// Asking systemd (`show`) would make it load each of those units just to answer, so the
/// directories are read instead: one listing per directory, however many units there are.
async fn add_unloaded_fragments(units: &mut [SystemdUnitSummary], search_path: &[PathBuf]) {
    let mut wanted: HashMap<String, Option<PathBuf>> = units
        .iter()
        .filter(|unit| parse::needs_search_path_lookup(unit))
        .map(|unit| (unit.name.clone(), None))
        .collect();
    let mut missing = wanted.len();
    for directory in search_path {
        if missing == 0 {
            break;
        }
        let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Some(slot) = wanted.get_mut(&name) else {
                continue;
            };
            // A `<unit>.d` drop-in directory never has a unit's own name, but a stray
            // directory could; only files (or links to them) define units.
            if slot.is_none()
                && entry
                    .file_type()
                    .await
                    .is_ok_and(|file_type| !file_type.is_dir())
            {
                *slot = Some(entry.path());
                missing -= 1;
            }
        }
    }
    for unit in units {
        if let Some(Some(path)) = wanted.remove(&unit.name) {
            unit.fragment_path =
                parse::editable_fragment(Some(path.to_string_lossy().into_owned()));
        }
    }
}

/// The directories `manager` loads unit files from, in priority order; `None` when
/// `systemd-analyze` cannot tell (old or missing), which only costs the features that need
/// it, not the request.
async fn unit_search_path(
    manager: &Manager,
    cancel: &CancellationToken,
) -> Result<Option<Vec<PathBuf>>, CommandError> {
    match SystemdTool::analyze(manager)
        .args(["unit-paths"])
        .run(cancel)
        .await
    {
        Ok(output) => Ok(Some(parse::parse_unit_paths(&output.stdout))),
        Err(error) if error.kind == CommandErrorKind::Canceled => Err(error),
        Err(error) => {
            log!(
                Level::Debug,
                "Reading systemd unit paths failed: scope={} error={}",
                manager.scope(),
                error.message
            );
            Ok(None)
        }
    }
}

/// The unit the agent process runs in, from `/proc/self/cgroup`; `None` outside systemd
/// units or when the cgroup cannot be read.
async fn agent_unit() -> Option<SystemdAgentUnit> {
    let cgroup = tokio::fs::read_to_string("/proc/self/cgroup").await.ok()?;
    let unit = parse::parse_cgroup(&cgroup)?;
    let scope = match unit.user_uid {
        None => SystemdScope::System,
        Some(uid) => SystemdScope::User {
            name: Account::by_uid(uid)
                .await
                .ok()
                .flatten()
                .map_or_else(|| uid.to_string(), |account| account.name),
        },
    };
    Some(SystemdAgentUnit {
        scope,
        unit: unit.unit,
    })
}

/// The root agent's user list: regular accounts plus every account whose manager runs or
/// whose linger is on, with their linger and manager state.
async fn list_users() -> Result<(Vec<SystemdUserSummary>, bool), CommandError> {
    let (accounts, running, lingering) = tokio::join!(
        crate::platform::accounts::list(),
        running_managers(Path::new(scope::USER_RUNTIME_ROOT)),
        directory_names(Path::new(scope::LINGER_DIRECTORY))
    );
    let accounts =
        accounts.map_err(|message| CommandError::new(CommandErrorKind::Internal, message))?;
    let mut users: Vec<SystemdUserSummary> = accounts
        .users
        .into_iter()
        .filter(|user| {
            (user.uid >= FIRST_REGULAR_UID && user.uid != NOBODY_UID && user.uid < u32::MAX - 1)
                || running.contains(&user.uid)
                || lingering.contains(&user.name)
        })
        .map(|user| SystemdUserSummary {
            linger: lingering.contains(&user.name),
            manager_running: running.contains(&user.uid),
            name: user.name,
            uid: user.uid,
        })
        .collect();
    users.sort_by(|left, right| left.name.cmp(&right.name));
    let truncated = accounts.truncated || users.len() > MAX_LISTED_USERS;
    users.truncate(MAX_LISTED_USERS);
    Ok((users, truncated))
}

/// UIDs whose user manager runs, from the runtime directories below `runtime_root`.
///
/// Judged by the manager's sockets like every scoped request, not by the runtime directory:
/// logind creates that before the manager is up (right after linger is enabled) and keeps it
/// while the manager stops, and a list that called such a manager running would make the
/// UI's next unit request fail with "manager not running".
async fn running_managers(runtime_root: &Path) -> BTreeSet<u32> {
    let mut running = BTreeSet::new();
    for name in directory_names(runtime_root).await {
        if let Ok(uid) = name.parse::<u32>()
            && scope::manager_sockets_exist(&runtime_root.join(&name)).await
        {
            running.insert(uid);
        }
    }
    running
}

/// Entry names of a directory; empty when it is missing or unreadable, which for `/run/user`
/// and the linger directory means "none".
async fn directory_names(path: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(mut entries) = tokio::fs::read_dir(path).await else {
        return names;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Ok(name) = entry.file_name().into_string() {
            names.insert(name);
        }
    }
    names
}

/// The account whose user manager could load `file`: the agent's own for non-root agents;
/// for root, the owner of the file or of its directory when the file is new.
async fn path_user(agent: &AgentAccount, file: &Path) -> Result<Option<Account>, CommandError> {
    if !agent.is_root {
        return Ok(Some(agent.account.clone()));
    }
    let owner = match tokio::fs::metadata(file).await {
        Ok(metadata) => Some(metadata),
        Err(_) => match file.parent() {
            Some(parent) => tokio::fs::metadata(parent).await.ok(),
            None => None,
        },
    };
    let Some(owner) = owner else {
        return Ok(None);
    };
    Account::by_uid(std::os::unix::fs::MetadataExt::uid(&owner)).await
}

/// Where `file` sits in `manager`'s unit search path, and what the manager knows about the
/// unit; `None` when the manager would not load it.
async fn path_match(
    agent: &AgentAccount,
    manager: &Manager,
    file: &Path,
    cancel: &CancellationToken,
) -> Result<Option<SystemdPathMatch>, CommandError> {
    // An old or missing systemd-analyze only means no reload offer for this manager.
    let Some(search_path) = unit_search_path(manager, cancel).await? else {
        return Ok(None);
    };
    let search_path = canonical_paths(search_path).await;
    let Some((unit, drop_in)) = unit_for_path(file, &search_path).await else {
        return Ok(None);
    };
    let drop_in_file = drop_in.then_some(file);
    let state = path_unit_state(manager, &unit, drop_in_file, cancel).await?;
    Ok(Some(SystemdPathMatch {
        scope: manager.scope(),
        can_reload: manager.can_manage(agent),
        unit,
        drop_in,
        state,
    }))
}

/// Resolves search path directories through symlinks (such as `/lib` to `/usr/lib`), so a
/// file opened through either spelling matches; missing directories keep their spelling.
async fn canonical_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut canonical = Vec::with_capacity(paths.len());
    for path in paths {
        canonical.push(tokio::fs::canonicalize(&path).await.unwrap_or(path));
    }
    canonical
}

/// The unit `file` defines when its directory is in `search_path`, or the unit it modifies
/// when it is a `<unit>.d/*.conf` drop-in there. The flag tells which.
async fn unit_for_path(file: &Path, search_path: &[PathBuf]) -> Option<(String, bool)> {
    let name = file.file_name()?.to_str()?;
    let directory = file.parent()?;
    let directory = tokio::fs::canonicalize(directory)
        .await
        .unwrap_or_else(|_| directory.to_path_buf());
    if search_path.contains(&directory) {
        return validate_unit_name(name)
            .is_ok()
            .then(|| (name.to_string(), false));
    }
    let unit = directory.file_name()?.to_str()?.strip_suffix(".d")?;
    let grandparent = directory.parent()?;
    if name.ends_with(".conf")
        && search_path.iter().any(|entry| entry == grandparent)
        && validate_unit_name(unit).is_ok()
    {
        return Some((unit.to_string(), true));
    }
    None
}

/// What `manager` knows about `unit`, for the editor's reload offer. `drop_in_file` is the
/// saved file when it is one of the unit's drop-ins.
async fn path_unit_state(
    manager: &Manager,
    unit: &str,
    drop_in_file: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<SystemdPathUnitState, CommandError> {
    if manager.require_running().await.is_err() {
        return Ok(SystemdPathUnitState::ManagerNotRunning);
    }
    if is_template(unit) {
        // systemd reports no state for templates, and their new instances only see a
        // changed file after a reload, so a reload is always worth offering.
        return Ok(SystemdPathUnitState::NeedsReload);
    }
    let output = SystemdTool::systemctl(manager)
        .args([
            "show",
            "-p",
            "LoadState,NeedDaemonReload,DropInPaths",
            "--",
            unit,
        ])
        .run(cancel)
        .await?;
    let properties = UnitProperties::parse(&output.stdout);
    Ok(
        if properties.text("LoadState").as_deref() == Some("not-found") {
            SystemdPathUnitState::NotLoaded
        } else if properties.flag("NeedDaemonReload") {
            SystemdPathUnitState::NeedsReload
        } else if let Some(file) = drop_in_file
            && !drop_in_loaded(file, &properties.list("DropInPaths")).await
        {
            SystemdPathUnitState::NeedsReload
        } else {
            SystemdPathUnitState::UpToDate
        },
    )
}

/// Whether the loaded unit already uses the drop-in `file`.
///
/// systemd (checked on 255) reports `NeedDaemonReload=no` for a running unit when a drop-in
/// is added to a unit that had none, although the drop-in only applies after a reload. A
/// drop-in missing from the unit's loaded `DropInPaths` therefore needs a reload too. Both
/// sides are compared canonically, so a file opened through a symlinked spelling matches.
async fn drop_in_loaded(file: &Path, loaded: &[String]) -> bool {
    let file = tokio::fs::canonicalize(file)
        .await
        .unwrap_or_else(|_| file.to_path_buf());
    for path in loaded {
        let path = Path::new(path);
        let canonical = tokio::fs::canonicalize(path)
            .await
            .unwrap_or_else(|_| path.to_path_buf());
        if canonical == file {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;

    /// Verifies a host without systemd answers every command with the typed error.
    #[tokio::test]
    async fn unsupported_hosts_refuse_with_a_typed_error() {
        let systemd = Systemd::unsupported();
        let cancel = CancellationToken::new();
        let errors = [
            systemd.overview().await.err(),
            systemd
                .list_units(&SystemdScope::System, &cancel)
                .await
                .err(),
            systemd
                .daemon_reload(&SystemdScope::System, &cancel)
                .await
                .err(),
            systemd
                .path_status("/etc/a.service", None, &cancel)
                .await
                .err(),
        ];
        for error in errors {
            // The UI shows "this device does not use systemd" for exactly this kind.
            assert_eq!(
                error.map(|error| error.kind),
                Some(CommandErrorKind::SystemdUnsupported)
            );
        }
    }

    /// Verifies unit files and drop-ins are recognized in a search path directory.
    #[tokio::test]
    async fn finds_units_and_drop_ins_in_the_search_path() {
        let root = TempDir::create();
        let units = root.path().join("units");
        tokio::fs::create_dir_all(units.join("app.service.d"))
            .await
            .unwrap();
        let search_path = canonical_paths(vec![units.clone()]).await;
        // A unit file directly in the search path defines the unit of its name.
        assert_eq!(
            unit_for_path(&units.join("app.service"), &search_path).await,
            Some(("app.service".to_string(), false))
        );
        // A drop-in modifies the unit its directory names.
        assert_eq!(
            unit_for_path(&units.join("app.service.d/override.conf"), &search_path).await,
            Some(("app.service".to_string(), true))
        );
        // Other files in the search path define nothing.
        assert_eq!(
            unit_for_path(&units.join("README.md"), &search_path).await,
            None
        );
        // Files outside the search path belong to no manager.
        assert_eq!(
            unit_for_path(&root.path().join("app.service"), &search_path).await,
            None
        );
    }

    /// A unit list entry as `merge_units` builds it, for the fragment lookup tests.
    fn summary(name: &str, load_state: Option<&str>, file_state: &str) -> SystemdUnitSummary {
        SystemdUnitSummary {
            name: name.to_string(),
            unit_type: unit_type(name).to_string(),
            description: None,
            load_state: load_state.map(str::to_string),
            active_state: None,
            sub_state: None,
            unit_file_state: Some(file_state.to_string()),
            fragment_path: None,
            timer: None,
        }
    }

    /// Verifies unloaded unit files are found in the search path the way systemd would.
    #[tokio::test]
    async fn finds_unloaded_unit_files_in_the_search_path() {
        let root = TempDir::create();
        let first = root.path().join("etc");
        let second = root.path().join("lib");
        for directory in [&first, &second] {
            tokio::fs::create_dir_all(directory).await.unwrap();
        }
        for (directory, name) in [
            (&first, "shadowed.service"),
            (&second, "shadowed.service"),
            (&second, "only-lib.service"),
            (&second, "worker@.service"),
            (&first, "masked.service"),
            (&second, "loaded.service"),
        ] {
            tokio::fs::write(directory.join(name), "").await.unwrap();
        }
        // A directory with a unit's name is no unit file, so the lookup goes on past it.
        tokio::fs::create_dir_all(first.join("only-lib.service"))
            .await
            .unwrap();
        let mut units = vec![
            summary("shadowed.service", None, "disabled"),
            summary("only-lib.service", None, "disabled"),
            summary("worker@.service", None, "static"),
            summary("masked.service", None, "masked"),
            summary("loaded.service", Some("loaded"), "enabled"),
            summary("gone.service", None, "disabled"),
        ];
        let search_path = vec![root.path().join("missing"), first.clone(), second.clone()];
        add_unloaded_fragments(&mut units, &search_path).await;
        let paths: Vec<Option<PathBuf>> = units
            .iter()
            .map(|unit| unit.fragment_path.as_ref().map(PathBuf::from))
            .collect();
        assert_eq!(
            paths,
            [
                // The earlier search path directory wins, as it does for systemd.
                Some(first.join("shadowed.service")),
                // A directory with the unit's name is skipped.
                Some(second.join("only-lib.service")),
                // A template reports its template file.
                Some(second.join("worker@.service")),
                // A masked unit is a link to /dev/null, not a file to open.
                None,
                // Loaded units get their file from systemd, never from the lookup.
                None,
                // A unit file that disappeared since the listing has no file.
                None,
            ]
        );
    }

    /// Verifies the user list calls a manager running only once its sockets exist, matching
    /// the check scoped requests use, and not merely because its runtime directory exists.
    #[tokio::test]
    async fn running_managers_need_the_manager_sockets() {
        let root = TempDir::create();
        let runtime_root = root.path();
        for (uid, socket) in [
            ("1000", None),
            ("1001", Some("bus")),
            ("1002", Some("systemd/private")),
        ] {
            let runtime_dir = runtime_root.join(uid);
            tokio::fs::create_dir_all(runtime_dir.join("systemd"))
                .await
                .unwrap();
            if let Some(socket) = socket {
                tokio::fs::write(runtime_dir.join(socket), b"")
                    .await
                    .unwrap();
            }
        }
        tokio::fs::create_dir_all(runtime_root.join("not-a-uid/systemd"))
            .await
            .unwrap();
        tokio::fs::write(runtime_root.join("not-a-uid/bus"), b"")
            .await
            .unwrap();
        // 1000 only has the directory logind creates before the manager starts; the user
        // bus and the manager's private socket each prove a running manager; other entries
        // are not users.
        assert_eq!(
            running_managers(runtime_root).await,
            BTreeSet::from([1001, 1002])
        );
    }

    /// Verifies a drop-in counts as loaded only when the unit's `DropInPaths` lists it.
    #[tokio::test]
    async fn drop_ins_are_loaded_only_when_listed() {
        let root = TempDir::create();
        let directory = root.path().join("app.service.d");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let loaded = directory.join("loaded.conf");
        let added = directory.join("added.conf");
        tokio::fs::write(&loaded, "").await.unwrap();
        tokio::fs::write(&added, "").await.unwrap();
        let listed = vec![loaded.to_string_lossy().into_owned()];
        // A drop-in systemd already read needs no reload for being there.
        assert!(drop_in_loaded(&loaded, &listed).await);
        // A drop-in systemd has not read yet only applies after a reload.
        assert!(!drop_in_loaded(&added, &listed).await);
        // A unit without drop-ins has loaded none of them.
        assert!(!drop_in_loaded(&loaded, &[]).await);
    }

    /// Verifies journal requests are validated before anything runs.
    #[tokio::test]
    async fn journal_plans_validate_their_request() {
        let systemd = Systemd {
            support: SystemdSupport::Available,
        };
        let request = |unit: &str, lines: u32| request::SystemdJournal {
            scope: SystemdScope::System,
            unit: unit.to_string(),
            lines,
        };
        // A glob would widen `journalctl -u` to other units' logs.
        assert_eq!(
            systemd
                .journal_plan(&request("*.service", 10))
                .await
                .err()
                .map(|error| error.kind),
            Some(CommandErrorKind::InvalidInput)
        );
        // One view cannot make the agent replay the whole journal.
        assert_eq!(
            systemd
                .journal_plan(&request("a.service", MAX_JOURNAL_LINES + 1))
                .await
                .err()
                .map(|error| error.kind),
            Some(CommandErrorKind::InvalidInput)
        );
    }

    /// Verifies a non-root agent refuses system actions before running systemctl.
    #[tokio::test]
    async fn non_root_agents_refuse_system_actions() {
        if nix::unistd::Uid::effective().is_root() {
            // Root may act on the system manager, so there is nothing to refuse.
            return;
        }
        let systemd = Systemd {
            support: SystemdSupport::Available,
        };
        let cancel = CancellationToken::new();
        let result = systemd
            .unit_action(
                &SystemdScope::System,
                "redoor-no-such-unit.service",
                SystemdUnitAction::Start,
                &cancel,
            )
            .await;
        // The refusal is the agent's own, typed as a permission problem.
        assert_eq!(
            result.map_err(|error| error.kind),
            Err(CommandErrorKind::PermissionDenied)
        );
    }
}
