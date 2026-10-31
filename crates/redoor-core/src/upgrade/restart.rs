//! Finds the local redoor processes that run a binary being upgraded and restarts them.
//!
//! Each process catches [`REEXEC_SIGNAL`] and re-execs in place, which keeps its PID,
//! arguments, environment, working directory, terminal and supervisor, so nothing has to
//! reconstruct how it was started and systemd or launchd simply keep tracking it. Builds from
//! before that signal existed would be killed by it, so they are only reported for a manual
//! restart.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use nix::sys::signal::kill;
use nix::unistd::Pid;
use redoor_protocol::api::server::{UpgradeProcessOutcome, UpgradeProcessReport};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::executable::REPLACED_SUFFIX;
use crate::process::{MANAGED_AGENT_ENV, REEXEC_SIGNAL};

/// How long a signalled process may take to come back on the new binary.
const RESTART_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a signalled process is checked for having restarted.
const RESTART_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Hint for older builds that cannot re-exec themselves.
const MANUAL_RESTART_HINT: &str = "this build cannot restart itself in place; restart it, or its systemd or launchd service, to run the new version";

/// The running processes of one binary and how to restart each of them.
pub struct Restarter {
    /// Sorted by PID so reports come in a stable order.
    processes: Vec<RunningProcess>,
}

impl Restarter {
    /// Lists the processes running `binary`, except this one and server-owned agents.
    ///
    /// Agents launched by a server are skipped because the server restarts them itself, from
    /// its own binary, when it restarts. Call this before installing: afterwards macOS can no
    /// longer name the file the processes run.
    pub async fn discover(binary: &Path) -> Result<Self> {
        Self::collect(|snapshot| snapshot.runs(binary) && !snapshot.is_managed_agent()).await
    }

    /// Lists the processes an earlier `discover` selected, by PID.
    ///
    /// The binary is already replaced at this point, which macOS can no longer match by path.
    pub async fn for_pids(pids: &[u32]) -> Result<Self> {
        Self::collect(|snapshot| pids.contains(&snapshot.pid.0)).await
    }

    /// Snapshots the process table and keeps the processes `select` accepts.
    async fn collect(select: impl Fn(&ProcessSnapshot) -> bool) -> Result<Self> {
        let own_pid = ProcessId(std::process::id());
        let snapshots = tokio::task::spawn_blocking(ProcessSnapshot::all)
            .await
            .context("Failed to list running processes")?;
        let ancestors = ProcessSnapshot::ancestors_of(own_pid, &snapshots);
        let mut processes = Vec::new();
        for snapshot in snapshots {
            if snapshot.pid == own_pid || !select(&snapshot) {
                continue;
            }
            processes.push(RunningProcess {
                pid: snapshot.pid,
                hosts_caller: ancestors.contains(&snapshot.pid),
                launchd_label: snapshot.launchd_label(),
                reexecs: snapshot.pid.catches_reexec().await,
                command: snapshot.command,
            });
        }
        processes.sort_by_key(|process| process.pid.0);
        Ok(Self { processes })
    }

    /// PIDs of the processes, to hand them to a helper that restarts them.
    pub fn pids(&self) -> Vec<u32> {
        self.processes.iter().map(|process| process.pid.0).collect()
    }

    /// PID and command line of each process this one runs inside, such as an agent whose
    /// web terminal started it.
    pub fn hosting_processes(&self) -> impl Iterator<Item = (u32, &str)> {
        self.processes
            .iter()
            .filter(|process| process.hosts_caller)
            .map(|process| (process.pid.0, process.command.as_str()))
    }

    /// Whether a launchd job gets restarted, which can cost it the Local Network permission.
    pub fn restarts_launchd_jobs(&self) -> bool {
        self.processes
            .iter()
            .any(|process| process.launchd_label.is_some() && process.reexecs)
    }

    /// Restarts every process, calling `on_report` as each outcome is known.
    ///
    /// All of them are signalled before any is waited for: a server stops accepting within
    /// milliseconds, so its restarted agents reconnect to the new server instead of the old
    /// one, which would reject a newer protocol. Without `wait` they are reported as
    /// restarting, for a caller that restarts itself next and cannot outlive the wait.
    pub async fn restart(
        self,
        wait: bool,
        mut on_report: impl FnMut(&UpgradeProcessReport),
    ) -> Vec<UpgradeProcessReport> {
        let mut reports = Vec::new();
        let mut report = |process: &RunningProcess, outcome| {
            let entry = process.report(outcome);
            on_report(&entry);
            reports.push(entry);
        };
        let mut signalled = Vec::new();
        for process in &self.processes {
            if !process.reexecs {
                continue;
            }
            match process.pid.signal_reexec() {
                Ok(()) if wait => signalled.push(process),
                Ok(()) => report(process, UpgradeProcessOutcome::Restarting),
                Err(error) => report(process, RunningProcess::failure(&error)),
            }
        }
        for process in signalled {
            let outcome = match process.pid.wait_for_reexec().await {
                Ok(()) => UpgradeProcessOutcome::Restarted,
                Err(error) => RunningProcess::failure(&error),
            };
            report(process, outcome);
        }
        for process in self.processes.iter().filter(|process| !process.reexecs) {
            let hint = MANUAL_RESTART_HINT.to_string();
            report(process, UpgradeProcessOutcome::LeftRunning { hint });
        }
        reports
    }
}

/// One process that runs the binary being replaced.
struct RunningProcess {
    /// Target of the re-exec signal.
    pid: ProcessId,
    /// Command line shown to the operator.
    command: String,
    /// Whether the caller runs inside it, for example in a web terminal of that agent.
    hosts_caller: bool,
    /// launchd job label, so macOS operators learn about the Local Network permission.
    launchd_label: Option<String>,
    /// Whether it catches the re-exec signal; older builds would be killed by it instead.
    reexecs: bool,
}

impl RunningProcess {
    /// Pairs an outcome with the process it describes.
    fn report(&self, outcome: UpgradeProcessOutcome) -> UpgradeProcessReport {
        UpgradeProcessReport {
            pid: self.pid.0,
            command: self.command.clone(),
            outcome,
        }
    }

    /// The failed outcome with the whole error chain.
    fn failure(error: &anyhow::Error) -> UpgradeProcessOutcome {
        UpgradeProcessOutcome::Failed {
            error: format!("{error:#}"),
        }
    }
}

/// Fields of one process table entry that decide whether and how it is restarted.
struct ProcessSnapshot {
    /// Process ID.
    pid: ProcessId,
    /// Parent process ID, used to find the process hosting this command.
    parent: Option<ProcessId>,
    /// Executable path; `None` when the process belongs to a user this one cannot inspect.
    exe: Option<PathBuf>,
    /// Command line shown to the operator.
    command: String,
    /// Environment, used to recognize managed agents and launchd jobs.
    environ: Vec<OsString>,
}

impl ProcessSnapshot {
    /// Reads the process table; blocking, so callers run it off the async workers.
    ///
    /// A non-dumpable process (the server makes itself one so other processes of its user
    /// cannot read vault keys from its memory) hides its `exe` link even from its own user.
    /// Its command line stays readable, so an absolute `argv[0]` of a process of this user
    /// stands in for the executable path.
    fn all() -> Vec<Self> {
        let own_user = nix::unistd::Uid::current().as_raw();
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_exe(UpdateKind::Always)
                .with_cmd(UpdateKind::Always)
                .with_environ(UpdateKind::Always)
                // The owner decides whether a hidden `exe` may fall back to `argv[0]`.
                .with_user(UpdateKind::Always),
        );
        system
            .processes()
            .values()
            .filter(|process| process.thread_kind().is_none())
            .map(|process| Self {
                pid: ProcessId(process.pid().as_u32()),
                parent: process.parent().map(|parent| ProcessId(parent.as_u32())),
                exe: process.exe().map(Path::to_path_buf).or_else(|| {
                    let owned = process.user_id().is_some_and(|user| **user == own_user);
                    process
                        .cmd()
                        .first()
                        .map(PathBuf::from)
                        .filter(|path| owned && path.is_absolute())
                }),
                command: process
                    .cmd()
                    .iter()
                    .map(|argument| argument.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
                environ: process.environ().to_vec(),
            })
            .collect()
    }

    /// Collects the ancestors of `pid`, guarding against cycles from PID reuse.
    fn ancestors_of(pid: ProcessId, snapshots: &[Self]) -> HashSet<ProcessId> {
        let parents: HashMap<ProcessId, ProcessId> = snapshots
            .iter()
            .filter_map(|snapshot| Some((snapshot.pid, snapshot.parent?)))
            .collect();
        let mut ancestors = HashSet::new();
        let mut current = pid;
        while let Some(&parent) = parents.get(&current) {
            if !ancestors.insert(parent) {
                break;
            }
            current = parent;
        }
        ancestors
    }

    /// Whether the process was started from `binary`, even if it was replaced since.
    fn runs(&self, binary: &Path) -> bool {
        self.exe
            .clone()
            .is_some_and(|exe| crate::executable::without_replaced_suffix(exe) == binary)
    }

    /// Whether a server or relay launched this agent and therefore restarts it.
    fn is_managed_agent(&self) -> bool {
        self.env_value(MANAGED_AGENT_ENV).is_some()
    }

    /// The launchd job label of a process launchd started, on macOS.
    ///
    /// Terminal sessions set the same variable to `0` or an `application.` identifier.
    fn launchd_label(&self) -> Option<String> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        self.env_value("XPC_SERVICE_NAME")
            .filter(|label| label != "0" && !label.starts_with("application."))
    }

    /// Value of one environment variable of the process.
    fn env_value(&self, name: &str) -> Option<String> {
        self.environ.iter().find_map(|entry| {
            let entry = entry.to_string_lossy();
            let (key, value) = entry.split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    }
}

/// A process ID with the platform probes the restart decisions need.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ProcessId(u32);

impl ProcessId {
    /// Whether the process catches the re-exec signal, i.e. is a role of a current build.
    ///
    /// Sending it to any other process would terminate that process.
    async fn catches_reexec(self) -> bool {
        let bit = 1_u64 << (REEXEC_SIGNAL as i32 - 1);
        self.caught_signals()
            .await
            .is_some_and(|mask| mask & bit != 0)
    }

    /// The mask of signals the process handles, from `/proc` on Linux and Android.
    #[cfg(not(target_os = "macos"))]
    async fn caught_signals(self) -> Option<u64> {
        let status = tokio::fs::read_to_string(format!("/proc/{}/status", self.0))
            .await
            .ok()?;
        Self::parse_caught_signals(&status)
    }

    /// The mask of signals the process handles, from `ps` on macOS.
    #[cfg(target_os = "macos")]
    async fn caught_signals(self) -> Option<u64> {
        let output = tokio::process::Command::new("ps")
            .args(["-o", "caught=", "-p", &self.0.to_string()])
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let mask = String::from_utf8_lossy(&output.stdout);
        let mask = mask.trim();
        u64::from_str_radix(mask.strip_prefix("0x").unwrap_or(mask), 16).ok()
    }

    /// Extracts the `SigCgt` hex mask from a `/proc/<pid>/status` document.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    fn parse_caught_signals(status: &str) -> Option<u64> {
        let mask = status
            .lines()
            .find_map(|line| line.strip_prefix("SigCgt:"))?
            .trim();
        u64::from_str_radix(mask, 16).ok()
    }

    /// Sends the re-exec signal.
    fn signal_reexec(self) -> Result<()> {
        let pid = i32::try_from(self.0).context("PID out of range")?;
        kill(Pid::from_raw(pid), REEXEC_SIGNAL).context("Failed to send the re-exec signal")
    }

    /// Waits until the process runs the new binary and is ready for the next upgrade.
    ///
    /// On Linux a re-exec turns `/proc/<pid>/exe` from the replaced marker into the real
    /// path, and the new image catches the signal again once its role started. macOS has
    /// no such marker, so there the signal delivery is the last thing that can be checked.
    async fn wait_for_reexec(self) -> Result<()> {
        // A non-dumpable process hides its `exe` link too, so it gets the same treatment.
        if cfg!(target_os = "macos") || self.hides_image().await {
            return Ok(());
        }
        let waited = tokio::time::timeout(RESTART_TIMEOUT, async {
            let mut interval = tokio::time::interval(RESTART_POLL_INTERVAL);
            loop {
                interval.tick().await;
                if kill(Pid::from_raw(self.0 as i32), None).is_err() {
                    bail!("it exited instead of restarting; check its log");
                }
                if self.runs_current_image().await && self.catches_reexec().await {
                    return Ok(());
                }
            }
        })
        .await;
        match waited {
            Ok(result) => result,
            Err(_) => bail!(
                "it did not restart within {}s; check its log",
                RESTART_TIMEOUT.as_secs()
            ),
        }
    }

    /// Whether `/proc/<pid>/exe` cannot be read by this user, as for a non-dumpable process.
    async fn hides_image(self) -> bool {
        tokio::fs::read_link(format!("/proc/{}/exe", self.0))
            .await
            .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    }

    /// Whether `/proc/<pid>/exe` names an existing file rather than a replaced one.
    async fn runs_current_image(self) -> bool {
        tokio::fs::read_link(format!("/proc/{}/exe", self.0))
            .await
            .is_ok_and(|exe| !exe.to_string_lossy().ends_with(REPLACED_SUFFIX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a snapshot with only the fields a test cares about.
    fn snapshot(pid: u32, parent: Option<u32>) -> ProcessSnapshot {
        ProcessSnapshot {
            pid: ProcessId(pid),
            parent: parent.map(ProcessId),
            exe: None,
            command: String::new(),
            environ: Vec::new(),
        }
    }

    /// The signal probe must read the caught mask, not the blocked or ignored ones.
    #[test]
    fn parses_the_caught_signal_mask() {
        let status = "Name:\tredoor\nSigBlk:\t0000000000000000\nSigIgn:\t0000000000001000\nSigCgt:\t0000000180000800\n";
        let mask = ProcessId::parse_caught_signals(status).expect("SigCgt should parse");
        // Bit 11 is SIGUSR2 on Linux; a set bit means the role registered its handler.
        assert_eq!(mask & (1 << 11), 1 << 11);
        // A document without SigCgt yields no mask, so the process is not signalled.
        assert_eq!(ProcessId::parse_caught_signals("Name:\tx\n"), None);
    }

    /// The process hosting the upgrade must be found through every intermediate shell.
    #[test]
    fn finds_ancestors_without_looping() {
        let snapshots = [
            snapshot(1, None),
            snapshot(10, Some(1)),
            snapshot(20, Some(10)),
            snapshot(30, Some(20)),
            // A cycle from PID reuse must not hang the walk.
            snapshot(40, Some(41)),
            snapshot(41, Some(40)),
        ];
        let ancestors = ProcessSnapshot::ancestors_of(ProcessId(30), &snapshots);
        // Every process up to init hosts the command.
        assert_eq!(
            ancestors,
            HashSet::from([ProcessId(20), ProcessId(10), ProcessId(1)])
        );
        // The cycle terminates after visiting each process once.
        assert_eq!(
            ProcessSnapshot::ancestors_of(ProcessId(40), &snapshots),
            HashSet::from([ProcessId(41), ProcessId(40)])
        );
    }

    /// Managed agents are left to the server that restarts them with its own binary.
    #[test]
    fn recognizes_managed_agents_by_environment() {
        let mut managed = snapshot(5, None);
        managed.environ = vec![
            OsString::from("HOME=/root"),
            OsString::from(format!("{MANAGED_AGENT_ENV}=1")),
        ];
        // The marker the server sets must exclude the agent from the restart list.
        assert!(managed.is_managed_agent());
        // Standalone agents have no marker and are restarted.
        assert!(!snapshot(6, None).is_managed_agent());
    }
}
